import path from 'path';

import { parseTelegramJid } from '@skoobi/shared/telegram-jid';

import { assertValidGroupFolder } from './group-folder.js';

/**
 * A main chat can contain people other than the owner.  Such a run must not
 * reuse the owner's writable group/session namespace merely because its
 * destination happens to be the main group.
 *
 * This namespace is deliberately shared by the untrusted members of one main
 * chat (identity is not required), but is disjoint from every canonical owner
 * path.  It is therefore safe for guest continuity without letting a guest
 * plant files that a later owner run will execute or load.
 */
export const UNTRUSTED_MAIN_NAMESPACE_DIR = 'untrusted-main';

export function isMultiSenderRuntimeChat(chatJid: unknown): boolean {
  if (typeof chatJid !== 'string') return false;
  if (chatJid.endsWith('@g.us') || chatJid.startsWith('dc:')) return true;
  const parsed = parseTelegramJid(chatJid);
  return parsed?.chatId.startsWith('-') === true;
}

export function shouldUseUntrustedMainRuntimeNamespace(input: {
  groupIsMain: boolean;
  credentialProxyTier?: 'owner' | 'guest';
  chatJid: unknown;
}): boolean {
  return (
    input.groupIsMain &&
    input.credentialProxyTier !== 'owner' &&
    isMultiSenderRuntimeChat(input.chatJid)
  );
}

export interface RuntimePersistencePolicy {
  untrustedMain: boolean;
  resumeCanonicalSession: boolean;
  persistCanonicalSession: boolean;
  exposeCanonicalTasks: boolean;
  includeCanonicalInstructions: boolean;
}

const SAFE_RUNTIME_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeRuntimeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_RUNTIME_SESSION_ID_RE.test(value);
}

export function safeRuntimeSessionIdOrUndefined(
  value: unknown,
): string | undefined {
  return isSafeRuntimeSessionId(value) ? value : undefined;
}

/** One policy object consumed by both chat and scheduled run integration. */
export function runtimePersistencePolicy(input: {
  groupIsMain: boolean;
  credentialProxyTier?: 'owner' | 'guest';
  chatJid: unknown;
}): RuntimePersistencePolicy {
  const untrustedMain = shouldUseUntrustedMainRuntimeNamespace(input);
  return {
    untrustedMain,
    resumeCanonicalSession: !untrustedMain,
    persistCanonicalSession: !untrustedMain,
    exposeCanonicalTasks: !untrustedMain,
    includeCanonicalInstructions: !untrustedMain,
  };
}

export function runtimeVisibleTasks<T>(
  policy: RuntimePersistencePolicy,
  tasks: readonly T[],
): T[] {
  return policy.exposeCanonicalTasks ? [...tasks] : [];
}

export function persistRuntimeSessionIfAllowed(
  policy: RuntimePersistencePolicy,
  sessionId: string,
  persist: (sessionId: string) => void,
): boolean {
  if (!policy.persistCanonicalSession || !isSafeRuntimeSessionId(sessionId)) {
    return false;
  }
  persist(sessionId);
  return true;
}

export interface UntrustedMainRuntimePaths {
  root: string;
  workspace: string;
  home: string;
  claudeHome: string;
  tmp: string;
  runnerSrc: string;
  logs: string;
  /** Safe key for per-run facilities which accept a folder-like identifier. */
  runtimeKey: string;
}

export function untrustedMainRuntimePaths(
  dataDir: string,
  groupFolder: string,
): UntrustedMainRuntimePaths {
  assertValidGroupFolder(groupFolder);
  const root = path.resolve(dataDir, UNTRUSTED_MAIN_NAMESPACE_DIR, groupFolder);
  const expectedParent = path.resolve(dataDir, UNTRUSTED_MAIN_NAMESPACE_DIR);
  if (path.dirname(root) !== expectedParent) {
    throw new Error('Untrusted main runtime path escaped its namespace');
  }
  const home = path.join(root, 'home');
  return {
    root,
    workspace: path.join(root, 'workspace'),
    home,
    claudeHome: path.join(home, '.claude'),
    tmp: path.join(root, 'tmp'),
    runnerSrc: path.join(root, 'agent-runner-src'),
    logs: path.join(root, 'logs'),
    runtimeKey: `untrusted-main-${groupFolder}`,
  };
}
