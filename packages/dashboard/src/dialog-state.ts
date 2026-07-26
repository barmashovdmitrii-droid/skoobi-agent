import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';

export const DIALOG_STATE_FILE = path.join(
  STORE_DIR,
  'dashboard-dialog-state.json',
);

export type DashboardDialogState = {
  version: 1;
  pinned: string[];
  aliases: Record<string, string>;
  links: Record<string, string[]>;
  updatedAt: string | null;
};

const MAX_ALIAS_CHARS = 80;
const MAX_LINKS_PER_CHAT = 20;

function emptyState(): DashboardDialogState {
  return {
    version: 1,
    pinned: [],
    aliases: {},
    links: {},
    updatedAt: null,
  };
}

export function isDialogStateJid(jid: unknown): jid is string {
  return (
    typeof jid === 'string' &&
    (/^tg:\d{1,20}$/u.test(jid) ||
      /^\d{5,20}(?::\d{1,5})?@s\.whatsapp\.net$/u.test(jid) ||
      /^\d{5,20}(?:-\d{1,20})?@g\.us$/u.test(jid) ||
      /^\d{5,20}@lid$/u.test(jid))
  );
}

function normalizeAlias(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const alias = value.trim().replace(/\s+/gu, ' ');
  if (
    alias.length === 0 ||
    alias.length > MAX_ALIAS_CHARS ||
    /[\u0000-\u001f\u007f]/u.test(alias)
  ) {
    return null;
  }
  return alias;
}

function normalizeState(value: unknown): DashboardDialogState {
  const state = emptyState();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return state;
  const raw = value as Record<string, unknown>;
  if (Array.isArray(raw.pinned)) {
    state.pinned = [...new Set(raw.pinned.filter(isDialogStateJid))].slice(
      0,
      500,
    );
  }
  if (
    raw.aliases &&
    typeof raw.aliases === 'object' &&
    !Array.isArray(raw.aliases)
  ) {
    for (const [jid, value] of Object.entries(raw.aliases)) {
      const alias = normalizeAlias(value);
      if (isDialogStateJid(jid) && alias) state.aliases[jid] = alias;
    }
  }
  if (raw.links && typeof raw.links === 'object' && !Array.isArray(raw.links)) {
    for (const [jid, value] of Object.entries(raw.links)) {
      if (!isDialogStateJid(jid) || !Array.isArray(value)) continue;
      const links = [...new Set(value.filter(isDialogStateJid))]
        .filter((target) => target !== jid)
        .slice(0, MAX_LINKS_PER_CHAT);
      if (links.length > 0) state.links[jid] = links;
    }
  }
  state.updatedAt =
    typeof raw.updatedAt === 'string' &&
    Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : null;
  return state;
}

function assertWritableStateShape(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Файл локальных настроек диалогов повреждён');
  }
  const raw = value as Record<string, unknown>;
  const aliasesValid =
    raw.aliases &&
    typeof raw.aliases === 'object' &&
    !Array.isArray(raw.aliases) &&
    Object.entries(raw.aliases).every(
      ([jid, alias]) => isDialogStateJid(jid) && Boolean(normalizeAlias(alias)),
    );
  const linksValid =
    raw.links &&
    typeof raw.links === 'object' &&
    !Array.isArray(raw.links) &&
    Object.entries(raw.links).every(
      ([jid, links]) =>
        isDialogStateJid(jid) &&
        Array.isArray(links) &&
        links.length <= MAX_LINKS_PER_CHAT &&
        links.every((target) => isDialogStateJid(target) && target !== jid),
    );
  if (
    raw.version !== 1 ||
    !Array.isArray(raw.pinned) ||
    !raw.pinned.every(isDialogStateJid) ||
    !aliasesValid ||
    !linksValid ||
    !(
      raw.updatedAt === null ||
      (typeof raw.updatedAt === 'string' &&
        Number.isFinite(Date.parse(raw.updatedAt)))
    )
  ) {
    throw new Error('Файл локальных настроек диалогов повреждён');
  }
}

function readStateFile(
  stateFile: string,
  strict: boolean,
): DashboardDialogState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    if (strict) assertWritableStateShape(parsed);
    return normalizeState(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    if (strict) throw new Error('Файл локальных настроек диалогов повреждён');
    return emptyState();
  }
}

export function readDialogState(
  stateFile = DIALOG_STATE_FILE,
): DashboardDialogState {
  return readStateFile(stateFile, false);
}

function writeDialogState(
  state: DashboardDialogState,
  stateFile: string,
): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const next: DashboardDialogState = {
    ...normalizeState(state),
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, stateFile);
}

export function setDialogPinned(
  jid: string,
  value: boolean,
  stateFile = DIALOG_STATE_FILE,
): void {
  if (!isDialogStateJid(jid)) throw new Error('Некорректный чат');
  const state = readStateFile(stateFile, true);
  const pinned = new Set(state.pinned);
  if (value) pinned.add(jid);
  else pinned.delete(jid);
  state.pinned = [...pinned];
  writeDialogState(state, stateFile);
}

export function setDialogAlias(
  jid: string,
  value: string,
  stateFile = DIALOG_STATE_FILE,
): void {
  if (!isDialogStateJid(jid)) throw new Error('Некорректный чат');
  const state = readStateFile(stateFile, true);
  const trimmed = value.trim();
  if (!trimmed) {
    delete state.aliases[jid];
  } else {
    const alias = normalizeAlias(value);
    if (!alias) throw new Error('Имя должно быть короче 80 символов');
    state.aliases[jid] = alias;
  }
  writeDialogState(state, stateFile);
}

export function setDialogLink(
  jid: string,
  targetJid: string,
  value: boolean,
  stateFile = DIALOG_STATE_FILE,
): void {
  if (
    !isDialogStateJid(jid) ||
    !isDialogStateJid(targetJid) ||
    jid === targetJid
  ) {
    throw new Error('Некорректная связь диалогов');
  }
  const state = readStateFile(stateFile, true);
  for (const [from, to] of [
    [jid, targetJid],
    [targetJid, jid],
  ] as const) {
    const links = new Set(state.links[from] || []);
    if (value) {
      if (links.size >= MAX_LINKS_PER_CHAT && !links.has(to)) {
        throw new Error('Слишком много связанных диалогов');
      }
      links.add(to);
    } else {
      links.delete(to);
    }
    if (links.size > 0) state.links[from] = [...links];
    else delete state.links[from];
  }
  writeDialogState(state, stateFile);
}
