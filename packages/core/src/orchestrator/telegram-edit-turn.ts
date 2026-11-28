// This host binding can withhold output that used an obsolete input. The
// ordinary channel and IPC authorisation still decide who may send.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';

import {
  getDb, getRouterState, getTelegramMessageEditBindingHash,
  getTelegramMessageEditRevision, markTelegramMessageSnapshotsAdmitted, setRouterState,
} from './db.js';
import type { NewMessage } from './types.js';

export interface TelegramEditSource {
  id: string;
  revision: number;
  bindingHash: string;
}

interface IpcBinding {
  chatJid: string;
  folder: string;
  sourceFolder: string;
  sources: TelegramEditSource[];
  expires: number;
}

interface EditTurn {
  chatJid: string;
  sources: Map<string, TelegramEditSource>;
  obsolete: boolean;
  admitted: boolean;
  folder?: string;
  sourceFolder?: string;
  token?: string;
}

const active = new Map<string, EditTurn>();
const turns = new AsyncLocalStorage<EditTurn>();
const ipcGuards = new AsyncLocalStorage<() => boolean>();
const retentionMs = 7 * 24 * 60 * 60 * 1000;

function tokenKey(token: string): string {
  return 'telegram_edit_ipc:' + createHash('sha256').update(token).digest('hex');
}

export async function withTelegramEditTurn<T>(chatJid: string, body: () => Promise<T>): Promise<T> {
  if (!chatJid.startsWith('tg:')) return body();
  const turn: EditTurn = {chatJid, sources: new Map(), obsolete: false, admitted: false};
  active.set(chatJid, turn);
  try {
    return await turns.run(turn, body);
  } finally {
    if (active.get(chatJid) === turn) active.delete(chatJid);
  }
}

export function telegramEditTurnSources(chatJid: string): TelegramEditSource[] | undefined {
  const turn = active.get(chatJid);
  if (turn?.sources.size) return [...turn.sources.values()];
}

export function telegramEditSourcesCurrent(chatJid: string, sources: Iterable<TelegramEditSource>): boolean {
  for (const source of sources) {
    if (getTelegramMessageEditRevision(chatJid, source.id) !== source.revision ||
        getTelegramMessageEditBindingHash(chatJid, source.id) !== source.bindingHash) return false;
  }
  return true;
}

function persistBinding(turn: EditTurn): void {
  if (!turn.token || !turn.folder || !turn.sourceFolder) return;
  const binding: IpcBinding = {
    chatJid: turn.chatJid,
    folder: turn.folder,
    sourceFolder: turn.sourceFolder,
    sources: [...turn.sources.values()],
    expires: Date.now() + retentionMs,
  };
  setRouterState(tokenKey(turn.token), JSON.stringify(binding));
}

export function watchTelegramEditInputs(chatJid: string, rows: readonly NewMessage[]): void {
  const turn = active.get(chatJid);
  if (!turn) return;
  for (const row of rows) {
    if (!row.telegram_editable || turn.sources.has(row.id)) continue;
    const bindingHash = getTelegramMessageEditBindingHash(chatJid, row.id);
    if (!bindingHash || !row.telegram_edit_group_folder ||
        (turn.sourceFolder !== undefined && turn.sourceFolder !== row.telegram_edit_group_folder)) {
      turn.obsolete = true;
      return;
    }
    turn.sourceFolder = row.telegram_edit_group_folder;
    turn.sources.set(row.id, {id: row.id, revision: row.telegram_edit_revision ?? 0, bindingHash});
  }
}

export function admitTelegramEditInputs(chatJid: string, rows: readonly NewMessage[]): boolean {
  const bound = rows.filter(row => row.telegram_editable);
  if (!bound.length) return true;
  const turn = active.get(chatJid);
  if (!turn) return false;
  watchTelegramEditInputs(chatJid, bound);
  if (turn.obsolete || !telegramEditSourcesCurrent(chatJid, turn.sources.values()) ||
      !markTelegramMessageSnapshotsAdmitted(bound)) return false;
  turn.admitted = true;
  persistBinding(turn);
  return true;
}

export function canPipeTelegramEditInputs(chatJid: string, rows: readonly NewMessage[]): boolean {
  return !rows.some(row => row.telegram_editable) || Boolean(active.get(chatJid)?.token);
}

export function invalidateTelegramEditTurn(chatJid: string, id: string): boolean {
  const turn = active.get(chatJid);
  if (!turn?.sources.has(id)) return false;
  turn.obsolete = true;
  return turn.admitted;
}

export function currentTelegramEditGuard(): (() => boolean) | undefined {
  return ipcGuards.getStore() ?? guardForTurn(turns.getStore());
}

export function activeTelegramEditGuard(chatJid: string): (() => boolean) | undefined {
  return guardForTurn(active.get(chatJid));
}

function guardForTurn(turn: EditTurn | undefined): (() => boolean) | undefined {
  if (turn?.sources.size) {
    // A callback may outlive its queue slot. Check its own snapshot again
    // instead of borrowing the next turn's in-memory guard.
    return () => !turn.obsolete && telegramEditSourcesCurrent(turn.chatJid, turn.sources.values());
  }
}

export function issueTelegramEditIpcBinding(folder: string): string | undefined {
  const turn = turns.getStore();
  if (!turn?.sources.size) return;
  if (turn.obsolete || (turn.folder !== undefined && turn.folder !== folder)) {
    throw new Error('telegram_source_changed');
  }
  if (turn.token) return turn.token;
  // A marked envelope whose binding expires is still rejected. The stored
  // metadata contains only scoped identifiers, hashes and revisions.
  getDb().prepare("DELETE FROM router_state WHERE key GLOB 'telegram_edit_ipc:*' AND json_extract(value,'$.expires') <= ?")
    .run(Date.now());
  turn.token = randomBytes(32).toString('base64url');
  turn.folder = folder;
  persistBinding(turn);
  return turn.token;
}

export function withTelegramEditIpcGuard<T>(folder: string, token: unknown, body: () => Promise<T>): Promise<T> {
  if (token === undefined) return body();
  const canSend = () => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    try {
      const raw = getRouterState(tokenKey(token));
      if (!raw) return false;
      const binding: IpcBinding = JSON.parse(raw);
      return binding.folder === folder && binding.expires > Date.now() &&
        getDb().prepare('SELECT folder FROM registered_groups WHERE jid=?').pluck().get(binding.chatJid) === binding.sourceFolder &&
        binding.sources.length > 0 && telegramEditSourcesCurrent(binding.chatJid, binding.sources);
    } catch {
      return false;
    }
  };
  return ipcGuards.run(canSend, body);
}
