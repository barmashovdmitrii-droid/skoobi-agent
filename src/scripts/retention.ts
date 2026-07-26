#!/usr/bin/env node
/**
 * Retention sweep (Tier 1, dry-by-default).
 *
 * For each `groups/<folder>/`, read `.media-index.jsonl`, classify
 * entries as `keep` or `candidate` for deletion, and either:
 *   - mode === 'dry'  → log aggregate counts to `logs/retention.log`,
 *   - mode === 'run'  → unlink the candidate files and patch the
 *     manifest entry with `deleted_at`.
 *
 * Phase 5 (this commit) ships the script wired to `mode: dry` for every
 * media type in `config/retention.json`. The `run` path is implemented
 * but inactive — operators flip the mode after observing dry-run output
 * over a week.
 *
 * Usage:
 *   node dist/scripts/retention.js [--dry] [--config <path>] \
 *        [--groups-dir <path>] [--report-chat <int>] [--no-report]
 *
 *   --dry          force dry mode regardless of config (default off)
 *   --config       path to retention.json (default: <cwd>/config/retention.json)
 *   --groups-dir   override groups directory (default: <cwd>/groups)
 *   --report-chat  Telegram chat_id (int) to send the daily summary to
 *                  (default: disabled)
 *   --no-report    skip the Telegram report; still write the log file
 *
 * SAFETY: in `dry` mode the script ONLY reads. It never deletes and
 * never updates the manifest. It always writes a summary line to
 * `logs/retention.log`.
 */

import fs, { promises as fsp } from 'fs';
import { execFile } from 'node:child_process';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'node:url';

import {
  folderAbsFromMediaPath,
  isSafeMediaBasename,
  listMedia,
  updateMediaEntry,
  type MediaType,
} from '../media-manifest.js';
import {
  applyGlobalBytes,
  applyPerUserBytes,
  classifyFolder,
  type ClassifiedEntry,
  type FolderSummary,
  type RetentionConfig,
} from '../retention-classifier.js';
import { readEnvFile } from '../orchestrator/env.js';

const DEFAULT_OWNER_CHAT_ID: number | null = null;
const SAFE_UNLINK_HELPER = fileURLToPath(
  new URL('../../scripts/safe-unlink-received.py', import.meta.url),
);
const PYTHON_BIN =
  process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';

export type SafeUnlinkStatus = 'deleted' | 'missing' | 'unsafe';

/**
 * Delete one media file without ever resolving a tenant-writable `received`
 * parent during unlink. The Python helper opens the group and received
 * directories with O_NOFOLLOW and performs unlinkat through the verified
 * directory descriptor. Any helper failure is deliberately `unsafe`: the
 * retention sweep must not tombstone or retry through a normal pathname.
 */
export function safeUnlinkReceivedFile(
  folderAbs: string,
  basename: string,
): Promise<SafeUnlinkStatus> {
  if (!isSafeMediaBasename(basename)) return Promise.resolve('unsafe');
  return new Promise((resolve) => {
    execFile(
      PYTHON_BIN,
      ['-I', SAFE_UNLINK_HELPER, folderAbs, basename],
      {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          resolve('unsafe');
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as { status?: unknown };
          if (
            parsed.status === 'deleted' ||
            parsed.status === 'missing' ||
            parsed.status === 'unsafe'
          ) {
            resolve(parsed.status);
            return;
          }
        } catch {
          // Malformed helper output is unsafe and must fail closed.
        }
        resolve('unsafe');
      },
    );
  });
}

interface Args {
  dry: boolean;
  configPath: string;
  groupsDir: string;
  reportChat: number | null;
  sendReport: boolean;
  logsDir: string;
}

function parseArgs(argv: string[]): Args {
  const reportEnv = readEnvFile(['SKOOBI_RETENTION_REPORT_CHAT_ID']);
  const configuredReportChat = (
    process.env.SKOOBI_RETENTION_REPORT_CHAT_ID ||
    reportEnv.SKOOBI_RETENTION_REPORT_CHAT_ID ||
    ''
  ).trim();
  const defaultReportChat = /^-?[1-9]\d*$/u.test(configuredReportChat)
    ? Number(configuredReportChat)
    : DEFAULT_OWNER_CHAT_ID;
  const args: Args = {
    dry: false,
    configPath: path.resolve(process.cwd(), 'config/retention.json'),
    groupsDir: path.resolve(process.cwd(), 'groups'),
    reportChat: defaultReportChat,
    sendReport: defaultReportChat !== null,
    logsDir: path.resolve(process.cwd(), 'logs'),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--config') args.configPath = path.resolve(argv[++i]);
    else if (a === '--groups-dir') args.groupsDir = path.resolve(argv[++i]);
    else if (a === '--report-chat') {
      args.reportChat = parseInt(argv[++i], 10);
      args.sendReport = true;
    }
    else if (a === '--no-report') args.sendReport = false;
    else if (a === '--logs-dir') args.logsDir = path.resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(
        'Usage: retention [--dry] [--config <path>] [--groups-dir <path>] [--report-chat <id>] [--no-report]',
      );
      process.exit(0);
    }
  }
  return args;
}

async function loadConfig(p: string): Promise<RetentionConfig> {
  const raw = await fsp.readFile(p, 'utf8');
  return JSON.parse(raw) as RetentionConfig;
}

interface FolderRun {
  folder: string;
  total_bytes: number;
  total_entries: number;
  candidates: number;
  freed_bytes: number;
  by_type: Record<string, { entries: number; candidates: number }>;
  /** Set only when mode === 'run' and files were actually unlinked. */
  deleted: number;
}

/**
 * Map a media type to the config mode key that governs its deletion.
 *
 * SAFETY: every type must resolve to ITS OWN mode key. A type with no
 * explicit mode entry in `config.mode` defaults to `'dry'` (skip) — it
 * must NOT borrow another type's mode. Previously the switch fell through
 * to `'document'`, so real `video`/`audio` entries (which have no
 * keep-gate in classifyEntry) became deletion candidates governed by the
 * `document` mode rather than their own. We now look up an explicit
 * per-type key and treat anything unmapped as dry-run.
 */
const TYPE_TO_MODE_KEY: Record<MediaType, string> = {
  voice: 'voice',
  'video-note': 'videoNote',
  photo: 'photo',
  document: 'document',
  video: 'video',
  audio: 'audio',
};

function resolveMode(type: MediaType, config: RetentionConfig): 'dry' | 'run' {
  const key = TYPE_TO_MODE_KEY[type];
  if (!key) return 'dry';
  const mode = (config.mode as Record<string, 'dry' | 'run' | undefined>)[key];
  // Unset key (e.g. config predates a new media type) → dry, never 'run'.
  return mode === 'run' ? 'run' : 'dry';
}

/**
 * True when `type` is DELETABLE: its mode key exists in `config.mode`, so the
 * retention sweep will physically unlink it once that key is flipped to 'run'.
 *
 * CORRECTNESS: this is deliberately distinct from `resolveMode === 'run'`. A
 * deletable type currently in `dry` mode (e.g. `document` before an operator
 * flips it) is still a legitimate dry-run preview candidate and IS counted in
 * the report. But `video`/`audio` have no key in `config.mode` at all — they
 * are structurally never deleted regardless of any flip — so byte-cap eviction
 * of them is inert. Counting their candidacy in `freed_bytes` would overstate
 * reclaimed disk and let the byte cap believe it freed space it never reclaims.
 * Only deletable types are counted toward `candidates`/`freed_bytes`.
 */
function isDeletableType(type: MediaType, config: RetentionConfig): boolean {
  const key = TYPE_TO_MODE_KEY[type];
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(config.mode, key);
}

/**
 * Classify a single folder and layer the per-user byte cap. Does NOT
 * delete anything: physical deletion is deferred to a second pass in
 * `main` so the candidate set can first be finalized across ALL folders
 * by `applyGlobalBytes`. Doing the unlink here would make the global
 * byte cap ineffective (its extra candidates would never be deleted) and
 * leave `run.deleted` inconsistent with `run.freed_bytes`.
 */
async function processFolder(
  folderAbs: string,
  folderName: string,
  config: RetentionConfig,
  now: Date,
): Promise<{ summary: FolderSummary; run: FolderRun }> {
  const entries = await listMedia(folderAbs);
  const classifications = classifyFolder(entries, config, now);
  applyPerUserBytes(classifications, config);

  const summary: FolderSummary = { folder: folderName, classifications };
  const run: FolderRun = {
    folder: folderName,
    total_bytes: entries
      .filter((e) => !e.deleted_at)
      .reduce((acc, e) => acc + (e.size_bytes || 0), 0),
    total_entries: entries.length,
    candidates: 0,
    freed_bytes: 0,
    by_type: {},
    deleted: 0,
  };

  for (const c of classifications) {
    const t = c.entry.type;
    run.by_type[t] = run.by_type[t] || { entries: 0, candidates: 0 };
    run.by_type[t].entries++;
    // CORRECTNESS: only count a candidate toward run.candidates/freed_bytes if
    // its type is DELETABLE — i.e. it has a real mode key in config.mode and so
    // is eligible to be unlinked once that key is flipped to 'run'. video/audio
    // have NO key in config.mode (structurally never deleted regardless of any
    // flip), so byte-cap eviction of them is inert: counting them here would
    // overstate freed_bytes (the report would claim disk that stays on disk) and
    // let the byte cap believe it freed space it never reclaims. Types in dry
    // mode that DO have a key are still counted — that is the dry-run preview.
    if (c.decision === 'candidate' && isDeletableType(t, config)) {
      run.candidates++;
      run.by_type[t].candidates++;
      run.freed_bytes += c.entry.size_bytes || 0;
    }
  }

  return { summary, run };
}

/**
 * Second pass: delete the FINALIZED candidate set for one folder. Called
 * only after `applyGlobalBytes` has run across every folder, so a
 * candidate promoted by either the per-user OR the global byte cap is
 * unlinked here. Per-type mode still gates each delete (keeping the
 * video/audio fallthrough fix: an unmapped type resolves to its own dry
 * mode, never `document`). Returns the count actually unlinked/tombstoned.
 */
async function deleteFolderCandidates(
  folderAbs: string,
  classifications: ClassifiedEntry[],
  config: RetentionConfig,
): Promise<number> {
  let deleted = 0;
  for (const c of classifications) {
    if (c.decision !== 'candidate') continue;
    const mode = resolveMode(c.entry.type, config);
    if (mode !== 'run') continue;

    // SECURITY: both the manifest basename AND the `received` parent are
    // tenant-writable. A safe basename alone cannot stop `received` from being
    // replaced with a symlink between a path check and fs.unlink(). The helper
    // independently validates the basename, pins group/received with O_NOFOLLOW
    // directory descriptors, and calls unlinkat relative to that pinned fd.
    if (!isSafeMediaBasename(c.entry.basename)) {
      process.stderr.write(
        `retention: skipping unsafe manifest basename in ${folderAbs}: ${JSON.stringify(
          c.entry.basename,
        )}\n`,
      );
      continue;
    }
    const status = await safeUnlinkReceivedFile(folderAbs, c.entry.basename);
    if (status === 'unsafe') {
      process.stderr.write(
        `retention: refusing unsafe received directory or media entry in ${folderAbs}: ${JSON.stringify(
          c.entry.basename,
        )}\n`,
      );
      continue;
    }
    await updateMediaEntry(folderAbs, c.entry.basename, {
      deleted_at: new Date().toISOString(),
    });
    if (status === 'deleted') {
      deleted++;
    }
  }
  return deleted;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatReport(runs: FolderRun[], dryRun: boolean): string {
  const totalEntries = runs.reduce((a, r) => a + r.total_entries, 0);
  const totalCandidates = runs.reduce((a, r) => a + r.candidates, 0);
  const totalBytes = runs.reduce((a, r) => a + r.total_bytes, 0);
  const freedBytes = runs.reduce((a, r) => a + r.freed_bytes, 0);
  const totalDeleted = runs.reduce((a, r) => a + r.deleted, 0);

  const lines: string[] = [];
  lines.push(
    `Skoobi retention ${dryRun ? '(DRY)' : '(RUN)'} — ${new Date().toISOString()}`,
  );
  lines.push(
    `Total: ${totalEntries} entries, ${humanBytes(totalBytes)}, candidates: ${totalCandidates} (${humanBytes(freedBytes)})${dryRun ? '' : `, deleted: ${totalDeleted}`}`,
  );
  for (const r of runs.sort((a, b) => b.total_bytes - a.total_bytes)) {
    const breakdown = Object.entries(r.by_type)
      .map(
        ([t, v]) =>
          `${t}=${v.entries}${v.candidates > 0 ? `(cand:${v.candidates})` : ''}`,
      )
      .join(' ');
    lines.push(
      `  ${r.folder}: ${r.total_entries} entries / ${humanBytes(r.total_bytes)} | candidates ${r.candidates} (${humanBytes(r.freed_bytes)})${r.deleted > 0 ? ` | deleted ${r.deleted}` : ''} | ${breakdown}`,
    );
  }
  return lines.join('\n') + '\n';
}

const MAX_TELEGRAM_REPORT_RESPONSE_BYTES = 1024 * 1024;
const TELEGRAM_REPORT_TIMEOUT_MS = 30_000;

export function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text });
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        let bodyBytes = 0;
        let ended = false;
        res.on('error', (err) => fail(err));
        res.on('aborted', () =>
          fail(new Error('telegram sendMessage response aborted')),
        );
        res.on('data', (chunk: Buffer | string) => {
          bodyBytes += Buffer.byteLength(chunk);
          if (bodyBytes > MAX_TELEGRAM_REPORT_RESPONSE_BYTES) {
            const error = new Error(
              'telegram sendMessage response exceeds byte limit',
            );
            res.destroy(error);
            fail(error);
            return;
          }
          body += chunk.toString();
        });
        res.on('end', () => {
          ended = true;
          if (res.statusCode && res.statusCode < 400) succeed();
          else
            fail(
              new Error(`telegram sendMessage ${res.statusCode}: ${body}`),
            );
        });
        res.on('close', () => {
          if (!ended) {
            fail(new Error('telegram sendMessage response closed early'));
          }
        });
      },
    );
    req.setTimeout(TELEGRAM_REPORT_TIMEOUT_MS, () => {
      req.destroy(new Error('telegram sendMessage timed out'));
    });
    req.on('error', (err) => fail(err));
    req.write(payload);
    req.end();
  });
}

export async function main(argv = process.argv): Promise<void> {
  const args = parseArgs(argv);
  const config = await loadConfig(args.configPath);
  const now = new Date();

  let folders: string[];
  try {
    const entries = await fsp.readdir(args.groupsDir, { withFileTypes: true });
    folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(`groups dir missing: ${args.groupsDir}\n`);
      process.exit(2);
    }
    throw err;
  }

  const summaries: FolderSummary[] = [];
  const runs: FolderRun[] = [];
  for (const name of folders) {
    const folderAbs = path.join(args.groupsDir, name);
    const { summary, run } = await processFolder(folderAbs, name, config, now);
    summaries.push(summary);
    runs.push(run);
  }

  // Layer global byte limit AFTER folder-by-folder processing so the
  // candidate set is final.
  applyGlobalBytes(summaries, config);
  // Re-derive run candidate counts after global pass — folders may have
  // gained additional candidates.
  for (const s of summaries) {
    const r = runs.find((rr) => rr.folder === s.folder)!;
    r.candidates = 0;
    r.freed_bytes = 0;
    for (const t of Object.keys(r.by_type)) r.by_type[t].candidates = 0;
    for (const c of s.classifications) {
      // CORRECTNESS: mirror processFolder — only count DELETABLE-type candidates
      // (those with a real config.mode key). video/audio are structurally never
      // unlinked, so including their byte-cap promotions here would overstate
      // freed_bytes and let the global cap believe it reclaimed disk it didn't.
      if (c.decision === 'candidate' && isDeletableType(c.entry.type, config)) {
        r.candidates++;
        r.freed_bytes += c.entry.size_bytes || 0;
        r.by_type[c.entry.type] = r.by_type[c.entry.type] || {
          entries: 0,
          candidates: 0,
        };
        r.by_type[c.entry.type].candidates++;
      }
    }
  }

  // Second pass: now that the candidate set is FINAL (per-user + global
  // byte caps applied across every folder), physically delete the
  // finalized candidates. `--dry` forces a no-op; otherwise per-type mode
  // gates each file inside deleteFolderCandidates. Doing this after the
  // global pass is what makes the global byte cap actually evict files
  // and keeps run.deleted consistent with the reported freed bytes.
  if (!args.dry) {
    for (const s of summaries) {
      const r = runs.find((rr) => rr.folder === s.folder)!;
      const folderAbs = path.join(args.groupsDir, s.folder);
      r.deleted = await deleteFolderCandidates(
        folderAbs,
        s.classifications,
        config,
      );
    }
  }

  // dry mode is the contract for phase 5 even if --dry isn't supplied:
  // every mode key defaults to 'dry' in retention.json.
  const text = formatReport(
    runs,
    args.dry || Object.values(config.mode).every((m) => m === 'dry'),
  );

  fs.mkdirSync(args.logsDir, { recursive: true });
  fs.appendFileSync(path.join(args.logsDir, 'retention.log'), text + '\n');
  process.stdout.write(text);

  if (args.sendReport && args.reportChat) {
    const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    const token =
      process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
    if (!token) {
      process.stderr.write(
        'TELEGRAM_BOT_TOKEN not set; skipping daily report delivery.\n',
      );
    } else {
      try {
        await sendTelegramMessage(token, args.reportChat, text);
      } catch (err) {
        process.stderr.write(
          `Daily report delivery failed: ${(err as Error).message}\n`,
        );
      }
    }
  }
}

// Helpers exported for tests / admin commands. `folderAbsFromMediaPath`
// re-exported so `/cleanup dry` consumers can resolve paths without
// reaching into the manifest module separately.
export { folderAbsFromMediaPath };

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/retention.js') ||
  process.argv[1]?.endsWith('/retention.ts');

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
