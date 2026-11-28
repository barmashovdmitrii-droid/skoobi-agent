import fs from 'fs';
import { telegramEditTurnSources, telegramEditSourcesCurrent, type TelegramEditSource } from './telegram-edit-turn.js';
import path from 'path';

import { resolveExistingSafeIpcCategoryDirectory } from './ipc-paths.js';
import { getRouterState, setRouterState } from './db.js';

export interface DeferredInputSourceStore {
  get: (key: string) => string | undefined;
  set: (key: string, value: string) => void;
}
interface DeferredInputSource {
  messageIds: string[];
  ingestionCursors: string[];
  telegramEditSources?: TelegramEditSource[];
}
const defaultSourceStore: DeferredInputSourceStore = {
  get: (key) => getRouterState(key),
  set: (key, value) => setRouterState(key, value),
};
const SOURCE_LIMIT = 1000;
const QUARANTINE_SUFFIX = '.delivery-confirmed';
const sourceKey = (chatJid: string): string =>
  `deferred_input_sources:${chatJid}`;

function validSource(value: unknown): value is DeferredInputSource {
  const source = value as DeferredInputSource | undefined;
  return Boolean(
    source &&
    (source.telegramEditSources === undefined || (Array.isArray(source.telegramEditSources) &&
      source.telegramEditSources.every(entry => entry && typeof entry.id === 'string' && /^[0-9a-f]{64}$/.test(entry.bindingHash) &&
        Number.isSafeInteger(entry.revision) && entry.revision >= 0))) &&
    Array.isArray(source.messageIds) &&
    source.messageIds.length > 0 &&
    source.messageIds.length <= 200 &&
    source.messageIds.every(
      (id) => typeof id === 'string' && id.length > 0 && id.length <= 256,
    ) &&
    new Set(source.messageIds).size === source.messageIds.length &&
    Array.isArray(source.ingestionCursors) &&
    source.ingestionCursors.length === source.messageIds.length &&
    source.ingestionCursors.every(
      (cursor) => typeof cursor === 'string' && /^i:\d{16}$/.test(cursor),
    ),
  );
}

function readSourceRegistry(
  chatJid: string,
  store = defaultSourceStore,
): Map<string, DeferredInputSource> {
  const data: unknown = JSON.parse(store.get(sourceKey(chatJid)) || '[]');
  if (!Array.isArray(data) || data.length > SOURCE_LIMIT)
    throw new Error('Invalid deferred input registry');
  const result = new Map<string, DeferredInputSource>();
  for (const entry of data) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      !INPUT_NAME.test(entry[0]) ||
      !validSource(entry[1])
    )
      throw new Error('Invalid deferred input source');
    result.set(entry[0], entry[1]);
  }
  return result;
}

/** Persist host-selected IDs BEFORE exposing an editable IPC input to a model. */
export function registerDeferredInputSource(
  chatJid: string,
  name: string,
  source: DeferredInputSource,
  options: { groupIpcDir?: string; store?: DeferredInputSourceStore } = {},
): void {
  if (!INPUT_NAME.test(name) || !validSource(source))
    throw new Error('Invalid deferred input registration');
  const store = options.store ?? defaultSourceStore;
  const registry = readSourceRegistry(chatJid, store);
  const dir =
    options.groupIpcDir &&
    resolveExistingSafeIpcCategoryDirectory(options.groupIpcDir, 'input');
  // Early supersede consumes ordinary IPC files without a final checkpoint.
  // Prune those gone files, but keep pending and confirmed-delivery evidence.
  if (dir)
    for (const oldName of registry.keys()) {
      if (oldName === name) continue;
      const exists = (file: string): boolean => {
        try {
          fs.lstatSync(file);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== 'ENOENT';
        }
      };
      if (
        !exists(path.join(dir, oldName)) &&
        !exists(path.join(dir, oldName + QUARANTINE_SUFFIX))
      )
        registry.delete(oldName);
    }
  if (
    registry.has(name) &&
    JSON.stringify(registry.get(name)) !== JSON.stringify(source)
  )
    throw new Error('Deferred input filename already registered');
  if (!registry.has(name) && registry.size >= SOURCE_LIMIT)
    throw new Error('Deferred input registry full');
  registry.set(name, {
    messageIds: [...source.messageIds],
    ingestionCursors: [...source.ingestionCursors],
    telegramEditSources: telegramEditTurnSources(chatJid),
  });
  store.set(sourceKey(chatJid), JSON.stringify([...registry]));
}

export interface DeferredInputCheckpoint {
  name: string;
  telegramEditSuperseded?: true;
  messageIds: string[];
  /** Old checkpoints are preserved, but cannot authorize a historical replay. */
  recoverable: boolean;
}

export function deferredDeliveryReceiptKey(chatJid: string): string {
  return `deferred_input_deliveries:${chatJid}`;
}

export function decodeDeferredDeliveryReceipts(raw: string | undefined): {
  names: string[];
  messageIds: string[];
} {
  try {
    const data = JSON.parse(raw || '{}');
    return {
      names: Array.isArray(data.names)
        ? data.names
            .filter(
              (name: unknown) =>
                typeof name === 'string' && INPUT_NAME.test(name),
            )
            .slice(-1000)
        : [],
      messageIds: Array.isArray(data.messageIds)
        ? data.messageIds
            .filter(
              (id: unknown) =>
                typeof id === 'string' && id.length > 0 && id.length <= 256,
            )
            .slice(-5000)
        : [],
    };
  } catch {
    return { names: [], messageIds: [] };
  }
}

export function appendDeferredDeliveryReceipts(
  raw: string | undefined,
  checkpoints: readonly DeferredInputCheckpoint[],
): string {
  const before = decodeDeferredDeliveryReceipts(raw);
  return JSON.stringify({
    names: [
      ...new Set([...before.names, ...checkpoints.map((entry) => entry.name)]),
    ].slice(-1000),
    messageIds: [
      ...new Set([
        ...before.messageIds,
        ...checkpoints.flatMap((entry) => entry.messageIds),
      ]),
    ].slice(-5000),
  });
}

const INPUT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,220}\.json$/;

/** IPC JSON is editable: only the host's separate registry supplies IDs. */
export function readDeferredInputCheckpoints(
  groupIpcDir: string,
  chatJid: string,
): DeferredInputCheckpoint[] {
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir) return [];
  const registry = readSourceRegistry(chatJid);
  const out: DeferredInputCheckpoint[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!INPUT_NAME.test(name)) continue;
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        path.join(dir, name),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 512_000) continue;
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
      const source = registry.get(name);
      // A runner may fail to add the draft/marker after doing work. The host
      // registration still proves this exact input is pending and permits its
      // acknowledgement after delivery. Editable JSON never supplies authority.
      if (
        data?.type !== 'message' ||
        (!source && data.afterFailedHold !== true)
      )
        continue;
      const recoverable = Boolean(source);
      out.push({
        name,
        recoverable,
        ...(source?.telegramEditSources && !telegramEditSourcesCurrent(chatJid, source.telegramEditSources)
          ? { telegramEditSuperseded: true as const } : {}),
        messageIds: source ? [...source.messageIds] : [],
      });
    } catch {
      // Unreadable/partial inputs stay on disk. Never acknowledge them here.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return out;
}

/**
 * The runner's unsent answer draft (finalize-hold `holdOriginalText`) kept in
 * a pending correction input. Model-written text only: never authority, never
 * proof of done actions; the host shows it once at a final stop (W05).
 */
export function readDeferredAnswerDraft(
  groupIpcDir: string,
  chatJid: string,
): string | null {
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir) return null;
  const pending = new Set(
    readDeferredInputCheckpoints(groupIpcDir, chatJid).filter(entry => !entry.telegramEditSuperseded).map(entry => entry.name),
  );
  let draft: string | null = null;
  for (const name of [...pending].sort()) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        path.join(dir, name),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 512_000) continue;
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
      const text = data?.holdOriginalText;
      if (typeof text === 'string' && text.trim() && text.length <= 100_000) {
        draft = text;
      }
    } catch {
      // An unreadable input has no draft to show; it stays on disk as is.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return draft;
}

/** Inhibit execution after a confirmed send if receipt persistence failed. */
export function quarantineDeferredInputsAfterDelivered(
  groupIpcDir: string,
  names: unknown,
): string[] {
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir || !Array.isArray(names)) return [];
  const moved: string[] = [];
  for (const name of new Set(names)) {
    if (typeof name !== 'string' || !INPUT_NAME.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      fs.renameSync(file, file + QUARANTINE_SUFFIX);
      moved.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return moved;
}

/** Quarantine can only inhibit replay; it cannot authorize any work or IDs. */
export function readDeferredDeliveryQuarantineIds(
  groupIpcDir: string,
  chatJid: string,
): string[] {
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir) return [];
  const registry = readSourceRegistry(chatJid);
  return [
    ...new Set(
      [...registry].flatMap(([name, source]) => {
        try {
          return fs.lstatSync(path.join(dir, name + QUARANTINE_SUFFIX)).isFile()
            ? source.messageIds
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

/** A runner frame is not delivery. Call only after the channel confirmed send. */
export function acknowledgeDeferredInputCheckpoints(
  groupIpcDir: string,
  chatJid: string,
  names: unknown,
  persistReceipt?: (checkpoints: DeferredInputCheckpoint[]) => void,
): string[] {
  const dir = resolveExistingSafeIpcCategoryDirectory(groupIpcDir, 'input');
  if (!dir) return [];
  const checkpoints = readDeferredInputCheckpoints(groupIpcDir, chatJid);
  const safeNames: string[] = Array.isArray(names)
    ? names.filter(
        (name): name is string =>
          typeof name === 'string' && INPUT_NAME.test(name),
      )
    : [];
  const wanted = new Set(safeNames);
  const selected = checkpoints.filter((entry) => wanted.has(entry.name));
  // Persist BEFORE deletion: a process crash after this acknowledgement must
  // not replay a successfully delivered answer even if the scalar cursor lags.
  if (selected.length) persistReceipt?.(selected);
  const existing = new Set(selected.map((c) => c.name));
  const removed: string[] = [];
  for (const name of new Set(safeNames)) {
    if (!INPUT_NAME.test(name) || !existing.has(name)) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // Delivery receipt is authoritative. Cleanup is retryable and must not
      // reclassify a successful channel send as a failed delivery.
    }
  }
  return removed;
}

/**
 * Failed correction recovery never replays the original action. On its first
 * run only that original batch is checkpointed; a recovery run preserves its
 * existing cursor. Exact pending inputs are loaded separately by host IDs.
 */
export function deferredContinuationRecovery(input: {
  hasRecoverableCheckpoint: boolean;
  startedWithCheckpoint: boolean;
  currentCursor: string;
  originalTargetCursor: string;
}): { retry: boolean; cursor: string } {
  if (!input.hasRecoverableCheckpoint)
    return { retry: false, cursor: input.currentCursor };
  return {
    retry: true,
    cursor:
      input.startedWithCheckpoint ||
      input.currentCursor >= input.originalTargetCursor
        ? input.currentCursor
        : input.originalTargetCursor,
  };
}
