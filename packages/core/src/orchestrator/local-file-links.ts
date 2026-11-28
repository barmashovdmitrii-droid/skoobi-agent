/**
 * Markdown links to files on this Mac in a final answer (C38).
 *
 * A chat cannot open «[Кухня — список.pdf](</Users/example/список.pdf>)»: the link
 * is dead on the phone. Twice a chat got one — once the PDF had
 * gone out as a file 18 s earlier, once research.md never went out at all.
 * Before the final answer leaves, each such link is resolved and replaced:
 *
 *  - the file already went to this chat (an IPC send_document / send_photo,
 *    or an earlier link in the same answer) → «подпись (файл выше)», no
 *    second copy;
 *  - the file lies inside this chat's workspace (groups/<folder>/, after
 *    realpath), is a regular non-secret file of at most 50 MB, the chat is
 *    a main (owner/admin) chat and its channel can send documents → the host
 *    attaches it before the text: «подпись (файл выше)»;
 *  - the owner's own chat also gets files from his work folders outside the
 *    chat folder (OWNER_WORK_FILE_GROUPS, ownerWorkFileRoots: the folders
 *    of the instance profile, e.g. a Desktop project folder with the game
 *    factory's gf-*\/delivery, and groups/*\/output) — W08; their
 *    private working files (*.private.*, hidden folders) only by name, as
 *    before;
 *  - the bot's own instructions, skills and memory (SKILL.md, CLAUDE.md …,
 *    isInternalInstructionPath) keep only the link's words: no name, no
 *    offer to send (4 «SKILL.md — попросите, и я пришлю» in a week, W08);
 *  - a failed send says so honestly, with the reason and where the file lies
 *    on the Mac — never an offer to send what just failed;
 *  - anything else → the name stays, the path goes: «подпись (файл «x.pdf»)»,
 *    with «скажи — пришлю» only where the bot really can send it.
 *
 * Only Markdown links are touched. A path written in `code` is left alone —
 * the owner asks for a file's address on the Mac often enough — and so is
 * anything inside <internal>, which never reaches the user.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  isSensitiveSendPath,
  noteChatFileSendFinished,
  noteChatFileSendStarted,
  queuedIpcFileSends,
  recentChatFileSend,
} from './chat-file-sends.js';
import { CODE_ROOT, DATA_DIR, GROUPS_DIR } from './config.js';
import { documentBlockReasonText } from './file-delivery-final.js';
import { randomUUID } from 'node:crypto';
import type { FileTransportResult } from './file-delivery.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { instanceProfile } from './instance-profile.js';
import type { RuntimePersistencePolicy } from './runtime-namespace.js';
import type { MessageRouter } from './types.js';

/** Telegram Bot API upload limit for documents. */
const MAX_ATTACH_BYTES = 50 * 1024 * 1024;
/** More links than this in one answer are not attached (name only). */
const MAX_ATTACHMENTS_PER_ANSWER = 5;
const MAX_CAPTION_CHARS = 1024;
const VIRTUAL_WORKSPACE_ROOT = '/workspace/group';
/**
 * A send refused before anything reached Telegram, for a reason that can
 * pass by itself (the channel was reconnecting, the file was still being
 * written). One more try is safe: nothing went out, so nothing can arrive
 * twice. A failed acceptance check is not retried (it fails the same way),
 * nor is an unknown outcome (the file may already be in the chat).
 */
const RETRYABLE_BLOCK_CODES: ReadonlySet<string> = new Set([
  'channel_unavailable',
  'document_preflight_failed',
]);
const DEFAULT_RETRY_DELAY_MS = 2_000;

/**
 * Chats whose links may also attach files from the owner's work folders
 * (ownerWorkFileRoots). Only the owner's own chat: a second admin's chat
 * keeps its own folder alone, so nothing of the owner's leaks into it.
 */
export const OWNER_WORK_FILE_GROUPS: readonly string[] = ['telegram_main'];

/**
 * Where the owner's work lands outside a chat folder: the folders the
 * instance profile lists (owner.workFolders, relative to the home directory),
 * e.g. a Desktop project folder that also holds the game factory's deliveries
 * (gf-*\/delivery). None by default. groups/*\/output is checked separately
 * (groupSubfolderOf). Secrets and the bot's internal files stay refused there
 * as everywhere; private working files only by name (isPrivateWorkFile).
 */
export function ownerWorkFileRoots(homeDir: string = os.homedir()): string[] {
  return instanceProfile().owner.workFolders.map((folder) =>
    path.join(homeDir, folder),
  );
}

/**
 * Chats whose links may attach the owner's work folders: an owner turn
 * (mayAttach — chatTurnMayAttachLocalFiles, or a task's owner authorisation)
 * in the owner's own chat. A second admin's chat is never one of them.
 */
export function chatMayAttachOwnerWorkFiles(input: {
  mayAttach: boolean;
  groupFolder: string;
}): boolean {
  return (
    input.mayAttach === true &&
    OWNER_WORK_FILE_GROUPS.includes(input.groupFolder)
  );
}

const PRIVATE_WORK_NAME_RE = /(?:^|[._-])private(?:[._-]|$)/i;

/**
 * Working files the owner keeps next to his deliveries (audits, scans,
 * review notes): «*.private.json», «secret-scan.private.log», anything in a
 * hidden folder such as «.skoobi-review-…». Inside an owner work folder they
 * are named and offered, never attached on their own — the owner asks, and
 * send_document sends them as before.
 */
function isPrivateWorkFile(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  return (
    PRIVATE_WORK_NAME_RE.test(parts[parts.length - 1] ?? '') ||
    parts.slice(0, -1).some((part) => part.startsWith('.'))
  );
}

const INTERNAL_FILE_NAME_RE =
  /^(?:skill|claude|agents|memory)\.md(?:[.-].*)?$/i;

/**
 * A configured root, or null when it is unavailable: a partial config mock
 * in a test must cost a missing root, never the whole rewrite.
 */
function configuredRoot(read: () => string): string | null {
  try {
    const value = read();
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * The bot's own instructions, skills and memory — not something to hand the
 * user as a file. By name (SKILL.md, CLAUDE.md, AGENTS.md, MEMORY.md and
 * their backups) or by place (skills, Codex homes, user memory, a chat's
 * memory/ folder, ~/.codex, ~/.claude).
 */
export function isInternalInstructionPath(
  filePath: string,
  roots: {
    homeDir?: string;
    dataDir?: string;
    groupsDir?: string;
    codeRoot?: string;
  } = {},
): boolean {
  if (INTERNAL_FILE_NAME_RE.test(path.basename(filePath))) return true;
  const homeDir = roots.homeDir ?? os.homedir();
  const dataDir = roots.dataDir ?? configuredRoot(() => DATA_DIR);
  const codeRoot = roots.codeRoot ?? configuredRoot(() => CODE_ROOT);
  const groupsDir = roots.groupsDir ?? configuredRoot(() => GROUPS_DIR);
  const internalDirs = [
    path.join(homeDir, '.codex'),
    path.join(homeDir, '.claude'),
    ...(dataDir
      ? ['skills', 'codex-homes', 'user-memory'].map((dir) =>
          path.join(dataDir, dir),
        )
      : []),
    ...(codeRoot ? [path.join(codeRoot, 'agent', 'skills')] : []),
  ];
  // Pictures the bot drew for the user live in a Codex home too
  // (codex-homes/<chat>/generated_images), kept there for «пришли картинку»:
  // a link to one is a file of the user's, not an instruction.
  if (dataDir && codexGeneratedImage(path.join(dataDir, 'codex-homes'), filePath)) {
    return false;
  }
  if (internalDirs.some((dir) => isWithinEither(dir, filePath))) return true;
  return (
    groupsDir !== null && groupSubfolderOf(groupsDir, filePath) === 'memory'
  );
}

/** codex-homes/<chat>/generated_images/… — the bot's drawings for a chat. */
function codexGeneratedImage(codexHomes: string, filePath: string): boolean {
  for (const root of new Set([codexHomes, realPathOrNull(codexHomes)])) {
    if (!root) continue;
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }
    const parts = relative.split(path.sep);
    if (parts.length >= 3 && parts[1] === 'generated_images') return true;
  }
  return false;
}

/** The first folder under groups/<chat>/ that holds the file, if any. */
function groupSubfolderOf(groupsDir: string, filePath: string): string | null {
  for (const root of new Set([groupsDir, realPathOrNull(groupsDir)])) {
    if (!root) continue;
    const relative = path.relative(root, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      continue;
    }
    const parts = relative.split(path.sep);
    if (parts.length >= 3) return parts[1];
  }
  return null;
}

function realPathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return null;
  }
}

/** The path of `child` below `parent` (as spelled or real), or null. */
function relativeWithinEither(parent: string, child: string): string | null {
  for (const root of new Set([parent, realPathOrNull(parent)])) {
    if (root && isWithin(root, child)) return path.relative(root, child);
  }
  return null;
}

/** Inside `parent` as spelled, or inside its real path (/tmp → /private/tmp). */
function isWithinEither(parent: string, child: string): boolean {
  if (isWithin(parent, child)) return true;
  const real = realPathOrNull(parent);
  return real !== null && real !== parent && isWithin(real, child);
}

/** The path as the owner reads it: ~/… for his home folder. */
function displayPath(realPath: string, homeDir: string): string {
  let shown = realPath;
  for (const home of new Set([homeDir, realPathOrNull(homeDir)])) {
    if (home && isWithin(home, realPath)) {
      shown = `~/${path.relative(home, realPath)}`;
      break;
    }
  }
  return shown.replace(/[`\r\n]/g, '');
}

export interface LocalFileLinkMatch {
  /** Offsets of the whole link, `!` of an image link included. */
  start: number;
  end: number;
  label: string;
  target: string;
}

export type LocalFileLinkOutcome = 'sent' | 'already_sent' | 'text_only';

export interface LocalFileLinkResult {
  outcome: LocalFileLinkOutcome;
  /** Why the file was not attached (text_only) or how it went (already_sent). */
  reason?: string;
  basename: string;
}

export interface LocalFileLinkRewrite {
  text: string;
  links: LocalFileLinkResult[];
  /** Files the host attached, in the order they were sent. */
  sentFiles: string[];
}

const PROTECTED_RE =
  /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`|<internal>[\s\S]*?(?:<\/internal>|$)/g;
const MARKDOWN_LINK_RE =
  /(!?)\[([^[\]\n]{0,500})\]\(\s*(<[^<>\n]+>|[^\s<>()]+)\s*\)/g;

function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(PROTECTED_RE)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

/**
 * The local path a Markdown link target points at, or null for a web link
 * (or anything else that is not a path on this machine).
 */
export function localPathFromLinkTarget(
  rawTarget: string,
  context: { groupRoot?: string; homeDir?: string } = {},
): string | null {
  let target = rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }
  if (!target) return null;
  if (/^file:\/\//i.test(target)) {
    let rest = target.replace(/^file:\/\//i, '');
    if (/^localhost\//i.test(rest)) rest = rest.slice('localhost'.length);
    if (!rest.startsWith('/')) return null;
    try {
      rest = decodeURIComponent(rest);
    } catch {
      /* keep the raw spelling */
    }
    return rest;
  }
  if (target.startsWith('~/')) {
    return path.join(context.homeDir ?? os.homedir(), target.slice(2));
  }
  // An absolute path, never a protocol-relative «//host/…» web link.
  if (!/^\/[^/\s]/.test(target)) return null;
  if (
    context.groupRoot &&
    (target === VIRTUAL_WORKSPACE_ROOT ||
      target.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`))
  ) {
    return path.join(
      context.groupRoot,
      target.slice(VIRTUAL_WORKSPACE_ROOT.length),
    );
  }
  return target;
}

/** Markdown links to local files, outside code and <internal>. */
export function findLocalFileLinks(
  text: string,
  context: { groupRoot?: string; homeDir?: string } = {},
): LocalFileLinkMatch[] {
  if (!text.includes('](')) return [];
  const ranges = protectedRanges(text);
  const links: LocalFileLinkMatch[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // A link that starts inside code / <internal> is quoted, not given; a
    // code span INSIDE the label («[`report.md`](/Users/example/…)») is still a link.
    if (ranges.some(([from, to]) => start >= from && start < to)) continue;
    const target = match[3];
    if (localPathFromLinkTarget(target, context) === null) continue;
    links.push({ start, end, label: match[2], target });
  }
  return links;
}

function existingRealPath(candidate: string): string | null {
  const spellings = [candidate];
  if (/%[0-9A-Fa-f]{2}/.test(candidate)) {
    try {
      spellings.push(decodeURIComponent(candidate));
    } catch {
      /* not percent-encoded after all */
    }
  }
  const hash = candidate.indexOf('#');
  if (hash > 0) spellings.push(candidate.slice(0, hash));
  for (const spelling of spellings) {
    try {
      return fs.realpathSync(spelling);
    } catch {
      /* try the next spelling */
    }
  }
  return null;
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    Boolean(relative) &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

/** A label that is itself a path says nothing the file name does not. */
function meaningfulLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return '';
  if (localPathFromLinkTarget(trimmed) !== null) return '';
  if (trimmed.includes('/') && !/\s/.test(trimmed)) return '';
  return trimmed;
}

function sentReplacement(label: string, name: string, queued: boolean): string {
  const shown = label || `«${name}»`;
  return queued
    ? `${shown} (файл отдельным сообщением)`
    : `${shown} (файл выше)`;
}

function nameOnlyReplacement(
  label: string,
  name: string,
  offerToSend: boolean,
  fileExists = true,
): string {
  // A link to nothing keeps its words, and claims no file.
  if (!fileExists) return label || `«${name}»`;
  // Only main chats (the owner and a second admin) ever see the offer; the bot
  // talks to both on «ты».
  const offer = 'скажи — пришлю';
  if (!label) return offerToSend ? `«${name}» (${offer})` : `«${name}»`;
  if (label.includes(name)) return offerToSend ? `${label} (${offer})` : label;
  return offerToSend
    ? `${label} (файл «${name}», ${offer})`
    : `${label} (файл «${name}»)`;
}

/** The bot's own rules and skills: the link's words only, no file at all. */
function internalReplacement(label: string): string {
  return label || 'внутренняя инструкция';
}

/**
 * A send that did not go through: what happened and where the file lies,
 * never «скажи — пришлю» right after the same send failed (the person
 * asked, and the second send failed the same way).
 */
function failedSendReplacement(
  label: string,
  name: string,
  where: string,
  result: FileTransportResult,
): string {
  const shown = label || `«${name}»`;
  if (result.state === 'unknown') {
    return `${shown} (⚠️ не уверен, что файл «${name}» дошёл — проверь чат выше; он лежит тут: \`${where}\`)`;
  }
  const why = documentBlockReasonText(result.code);
  return `${shown} (⚠️ файл «${name}» не дошёл${why ? `: ${why}` : ''}. Он лежит тут: \`${where}\`)`;
}

/** A code safe for an event key: the router's own, or a neutral one. */
function safeReasonCode(code: string): string {
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : 'unknown';
}

/**
 * Whether a chat turn may attach files from the chat's canonical folder: the
 * `isMain` of rewriteLocalFileLinks. A main registration alone is not enough.
 * A guest-tier turn in a multi-sender main chat (a member who is not the
 * owner) runs in the isolated untrusted-main workspace, and IPC refuses its
 * send_document for the canonical folder (guest_file_outside_workspace); the
 * host must not post the owner's CLAUDE.md or memory into that group for it
 * either. A DM keeps the canonical folder at any tier, as IPC does.
 */
export function chatTurnMayAttachLocalFiles(input: {
  groupIsMain: boolean;
  persistencePolicy: Pick<RuntimePersistencePolicy, 'untrustedMain'>;
}): boolean {
  return input.groupIsMain && !input.persistencePolicy.untrustedMain;
}

/**
 * Resolve every local-file link of a final answer and return the text to
 * deliver. Attachments go out BEFORE the text, so «файл выше» is true when
 * the text arrives. Never throws for a single link: an unreadable file or a
 * failed send leaves only that link as a name (and, for a failed send, the
 * reason and the file's place on the Mac).
 */
export async function rewriteLocalFileLinks(input: {
  text: string;
  groupFolder: string;
  chatJid: string;
  router: Pick<MessageRouter, 'sendDocument'> &
    Partial<Pick<MessageRouter, 'sendDocumentResult'>>;
  /**
   * Main (owner/admin) chats only: a guest chat never gets a host attachment.
   * Chat turns pass chatTurnMayAttachLocalFiles, scheduled tasks their owner
   * authorisation.
   */
  isMain: boolean;
  /** Same visibility tier as document sends through the IPC host. */
  ownerAuthorized?: boolean;
  /** Revalidate pending corrections/cancellation immediately before each upload. */
  canSend?: () => boolean;
  /** The chat's channel has sendDocument (WhatsApp does not). */
  canSendDocuments: boolean;
  /**
   * The owner's own chat (OWNER_WORK_FILE_GROUPS) with an owner turn: files
   * from his work folders may be attached too. Never set for a second admin.
   */
  ownerWorkFolders?: boolean;
  nowMs?: number;
  /** Test seams. */
  groupRoot?: string;
  homeDir?: string;
  ipcMessagesDir?: string;
  ownerWorkRoots?: string[];
  groupsDir?: string;
  dataDir?: string;
  codeRoot?: string;
  retryDelayMs?: number;
}): Promise<LocalFileLinkRewrite> {
  const homeDir = input.homeDir ?? os.homedir();
  const groupsDir = input.groupsDir ?? configuredRoot(() => GROUPS_DIR);
  const internalRoots = {
    homeDir,
    dataDir: input.dataDir,
    groupsDir: groupsDir ?? undefined,
    codeRoot: input.codeRoot,
  };
  const ownerRoots = input.ownerWorkFolders
    ? (input.ownerWorkRoots ?? ownerWorkFileRoots(homeDir))
    : [];
  const inOwnerWorkFolder = (realPath: string): boolean => {
    if (input.ownerWorkFolders !== true) return false;
    const roots = [
      ...ownerRoots,
      ...(groupsDir !== null &&
      groupSubfolderOf(groupsDir, realPath) === 'output'
        ? [groupsDir]
        : []),
    ];
    for (const root of roots) {
      const relative = relativeWithinEither(root, realPath);
      if (relative !== null) return !isPrivateWorkFile(relative);
    }
    return false;
  };
  const groupRoot =
    input.groupRoot ?? resolveGroupFolderPath(input.groupFolder);
  const matches = findLocalFileLinks(input.text, {
    groupRoot,
    homeDir: input.homeDir,
  });
  if (matches.length === 0) {
    return { text: input.text, links: [], sentFiles: [] };
  }
  let groupRootReal: string | null = null;
  try {
    groupRootReal = fs.realpathSync(groupRoot);
  } catch {
    groupRootReal = null;
  }
  let queued: Set<string> | undefined;
  /** One retry per answer: the text must not wait 2 s for every link. */
  let retriesLeft = 1;
  /** One wording per file: a second link to it reuses the first outcome. */
  const handled = new Map<
    string,
    { result: LocalFileLinkResult; again: (label: string) => string }
  >();
  const links: LocalFileLinkResult[] = [];
  const sentFiles: string[] = [];
  const replacements: string[] = [];

  for (const match of matches) {
    const label = meaningfulLabel(match.label);
    const candidate = localPathFromLinkTarget(match.target, {
      groupRoot,
      homeDir: input.homeDir,
    })!;
    const realPath = existingRealPath(candidate);
    const name = path.basename(realPath ?? candidate) || candidate;
    const remember = (
      result: LocalFileLinkResult,
      again: (label: string) => string,
    ): void => {
      if (realPath) handled.set(realPath, { result, again });
    };
    const textOnly = (reason: string, offerToSend = false): void => {
      const fileExists = reason !== 'missing' && reason !== 'not_a_file';
      const result: LocalFileLinkResult = {
        outcome: 'text_only',
        reason,
        basename: name,
      };
      links.push(result);
      replacements.push(
        nameOnlyReplacement(label, name, offerToSend, fileExists),
      );
      if (fileExists) {
        remember(result, (again) =>
          nameOnlyReplacement(again, name, offerToSend),
        );
      }
    };

    const earlier = realPath ? handled.get(realPath) : undefined;
    if (earlier) {
      // The same file twice in one answer: one attachment, one wording.
      if (earlier.result.outcome === 'text_only') {
        links.push({ ...earlier.result });
        replacements.push(earlier.again(label));
      } else {
        links.push({
          outcome: 'already_sent',
          reason: 'same_answer',
          basename: name,
        });
        replacements.push(earlier.again(label));
      }
      continue;
    }

    // Skills, CLAUDE.md, memory: never offered, not even by name (W08).
    if (isInternalInstructionPath(realPath ?? candidate, internalRoots)) {
      const result: LocalFileLinkResult = {
        outcome: 'text_only',
        reason: 'internal',
        basename: name,
      };
      links.push(result);
      replacements.push(internalReplacement(label));
      remember(result, internalReplacement);
      continue;
    }
    if (!realPath) {
      textOnly('missing');
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realPath);
    } catch {
      textOnly('missing');
      continue;
    }
    if (!stat.isFile()) {
      textOnly('not_a_file');
      continue;
    }

    const previous = recentChatFileSend(
      input.groupFolder,
      input.chatJid,
      realPath,
      input.nowMs,
    );
    queued ??= queuedIpcFileSends(input.groupFolder, input.chatJid, input.ipcMessagesDir);
    if (previous || queued.has(realPath)) {
      const inFlight = previous !== 'sent';
      const result: LocalFileLinkResult = {
        outcome: 'already_sent',
        reason: inFlight ? 'queued' : 'sent',
        basename: name,
      };
      links.push(result);
      replacements.push(sentReplacement(label, name, inFlight));
      remember(result, (again) => sentReplacement(again, name, inFlight));
      continue;
    }

    if (isSensitiveSendPath(realPath)) {
      textOnly('sensitive');
      continue;
    }
    if (!input.isMain) {
      textOnly('not_main_chat');
      continue;
    }
    // «скажи — пришлю» only where it is true: a main chat's own
    // send_document takes any readable non-secret file up to the upload limit.
    const sendable = stat.size <= MAX_ATTACH_BYTES && input.canSendDocuments;
    const insideWorkspace =
      (groupRootReal !== null && isWithin(groupRootReal, realPath)) ||
      inOwnerWorkFolder(realPath);
    if (!insideWorkspace) {
      textOnly('outside_workspace', sendable);
      continue;
    }
    if (stat.size > MAX_ATTACH_BYTES) {
      textOnly('too_large');
      continue;
    }
    if (!input.canSendDocuments) {
      textOnly('no_channel');
      continue;
    }
    if (sentFiles.length >= MAX_ATTACHMENTS_PER_ANSWER) {
      textOnly('limit', sendable);
      continue;
    }

    const caption =
      label && label !== name && label !== path.parse(name).name
        ? label.slice(0, MAX_CAPTION_CHARS)
        : undefined;
    const sendOptions = {
      // An attachment of the answer, not the answer: the text's own
      // delivery decides the chat cursor.
      suppressCursorAdvance: true,
      meta: { kind: 'local_file_document' },
    };
    const linkedDocument = {
      deliveryId: randomUUID(),
      sourceGroup: input.groupFolder,
      ownerAuthorized: input.ownerAuthorized === true,
      ...(input.canSend ? {canSend: input.canSend} : {}),
    };
    const sendOnce = async (): Promise<FileTransportResult> => {
      try {
        if (input.router.sendDocumentResult) {
          return await input.router.sendDocumentResult(
            input.chatJid,
            realPath,
            caption,
            { ...sendOptions, linkedDocument },
          );
        }
        if (input.canSend && !input.canSend())
          return {state:'blocked', code:'final_superseded'};
        const ok = await input.router.sendDocument(
          input.chatJid,
          realPath,
          caption,
          sendOptions,
        );
        return ok
          ? { state: 'delivered', code: 'api_acknowledged' }
          : { state: 'blocked', code: 'channel_refused' };
      } catch {
        // Whether anything reached Telegram is not known: never retried.
        return { state: 'unknown', code: 'send_threw' };
      }
    };
    noteChatFileSendStarted(input.groupFolder, input.chatJid, realPath, input.nowMs);
    let outcome = await sendOnce();
    if (
      retriesLeft > 0 &&
      outcome.state === 'blocked' &&
      RETRYABLE_BLOCK_CODES.has(outcome.code)
    ) {
      retriesLeft--;
      await new Promise((resolve) =>
        setTimeout(resolve, input.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS),
      );
      outcome = await sendOnce();
    }
    const delivered = outcome.state === 'delivered';
    noteChatFileSendFinished(
      input.groupFolder,
      input.chatJid,
      realPath,
      delivered,
      input.nowMs,
    );
    if (!delivered) {
      // The real code goes to the event (it used to show only «send_failed»).
      const result: LocalFileLinkResult = {
        outcome: 'text_only',
        reason: `send_failed:${safeReasonCode(outcome.code)}`,
        basename: name,
      };
      links.push(result);
      replacements.push(
        failedSendReplacement(
          label,
          name,
          displayPath(realPath, homeDir),
          outcome,
        ),
      );
      remember(result, (again) => nameOnlyReplacement(again, name, false));
      continue;
    }
    if (outcome.code === 'existing_api_acknowledgement') {
      const result: LocalFileLinkResult = { outcome: 'already_sent', reason: 'sent', basename: name };
      links.push(result);
      replacements.push(sentReplacement(label, name, false));
      remember(result, (again) => sentReplacement(again, name, false));
      continue;
    }
    sentFiles.push(realPath);
    const result: LocalFileLinkResult = { outcome: 'sent', basename: name };
    links.push(result);
    replacements.push(sentReplacement(label, name, false));
    remember(result, (again) => sentReplacement(again, name, false));
  }

  let text = '';
  let cursor = 0;
  matches.forEach((match, index) => {
    text += input.text.slice(cursor, match.start) + replacements[index];
    cursor = match.end;
  });
  text += input.text.slice(cursor);
  return { text, links, sentFiles };
}

/** One local_file_link event per answer: counts and reasons, no paths. */
export function localFileLinkEventPayload(
  links: readonly LocalFileLinkResult[],
): Record<string, unknown> | null {
  if (links.length === 0) return null;
  const count = (outcome: LocalFileLinkOutcome) =>
    links.filter((link) => link.outcome === outcome).length;
  const reasons: Record<string, number> = {};
  for (const link of links) {
    if (link.outcome === 'sent' || !link.reason) continue;
    const key = `${link.outcome}:${link.reason}`;
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return {
    found: links.length,
    sent: count('sent'),
    already_sent: count('already_sent'),
    text_only: count('text_only'),
    reasons,
  };
}
