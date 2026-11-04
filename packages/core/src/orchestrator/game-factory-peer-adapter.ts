import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  peerCanonicalJson,
  type PeerContextRecord,
  type PeerTaskContext,
} from './peer-context.js';
import { readGameFactoryPeerState } from './game-factory-peer-state.js';
import {
  writePeerInboxEvent,
  type PeerBridgeConfig,
  type PeerInboxEvent,
} from './peer-inbox.js';

/** This is private host state, never accepted as a tool/model/worker argument. */
export interface GameFactoryPeerState {
  jobId: string;
  parentTaskId: string;
  projectId: string;
  peerRevision: number;
  briefRevision: number;
  actorKey: string;
  networkId: string;
  scopeHash: string;
  scopeRevisionHash: string;
  createdAt: string;
  expiresAt: string;
  current: boolean;
  /** Retained completed bytes may outlive transport/execution context TTL. */
  retainedResultCurrent?: boolean;
  routeAllowed: boolean;
  records: PeerContextRecord[];
  route: {
    chatJid: string;
    tenantId: string;
    identityId: string;
    groupFolder: string;
  };
}
type Payload = {
  contract: {
    parentTaskId: string;
    projectKey: string | null;
    revision: number;
    execution: { expiresAt: string; mode: string; guiAuthorized: boolean };
  };
  context?: PeerTaskContext;
};
const digest = (value: unknown) =>
  createHash('sha256').update(peerCanonicalJson(value)).digest('hex');
export const isFactoryPeerParent = (value: unknown): boolean =>
  typeof value === 'string' && value.startsWith('factory:');

function readState(
  jobId: string,
  parentTaskId: string,
): GameFactoryPeerState | null {
  try {
    return readGameFactoryPeerState(jobId) as GameFactoryPeerState | null;
  } catch (error) {
    // An unavailable optional factory must not interrupt existing owner jobs.
    // Its reserved namespace, however, never falls back to personal memory.
    if (isFactoryPeerParent(parentTaskId)) throw error;
    return null;
  }
}

/** Stable snapshot hash; operational progress must not change these fields. */
export function buildGameFactoryPeerContext(
  state: GameFactoryPeerState,
  records = state.records,
): PeerTaskContext {
  if (
    records.length > 20 ||
    records.some(
      (r) =>
        r.projectKey !== state.projectId ||
        Buffer.byteLength(r.value) > 4000 ||
        r.source.messageRef !== undefined,
    )
  )
    throw new Error('Invalid factory project context');
  const body = {
    schema: 1 as const,
    taskId: state.jobId,
    revision: state.peerRevision,
    scopeHash: state.scopeHash,
    scopeRevisionHash: state.scopeRevisionHash,
    projectKey: state.projectId,
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    records: structuredClone(records),
    retrieval: { mode: 'lexical' as const, reason: 'not_configured' as const },
  };
  if (Buffer.byteLength(peerCanonicalJson(body)) > 64 * 1024 - 100)
    throw new Error('Factory context limit');
  return { ...body, sha256: digest(body) };
}

export function factoryPeerStateForEvent(
  c: PeerBridgeConfig,
  event: PeerInboxEvent,
): GameFactoryPeerState | null {
  const state = readState(event.jobId, event.parentTaskId);
  if (!state) {
    if (isFactoryPeerParent(event.parentTaskId))
      throw new Error('Factory peer binding unavailable');
    return null;
  }
  if (
    state.networkId !== c.networkId ||
    state.jobId !== event.jobId ||
    state.parentTaskId !== event.parentTaskId ||
    state.projectId !== event.projectKey ||
    state.peerRevision !== event.revision ||
    !isFactoryPeerParent(state.parentTaskId)
  )
    throw new Error('Factory peer binding mismatch');
  return state;
}

export function factoryPeerEventIsCurrent(
  state: GameFactoryPeerState,
  event: PeerInboxEvent,
  now = new Date().toISOString(),
): boolean {
  return (
    state.current &&
    state.routeAllowed &&
    Date.parse(state.expiresAt) > Date.parse(now) &&
    event.contextValidity.expiresAt === state.expiresAt &&
    event.contextValidity.scopeRevisionHash === state.scopeRevisionHash &&
    event.contextHash === buildGameFactoryPeerContext(state).sha256
  );
}

/** Per-job selection persists across coordinator restart and every lifecycle
 * method. A factory marker with a missing binding can never select owner memory. */
export function createGameFactoryPeerHostAdapter(
  c: PeerBridgeConfig,
  jobId: string,
  payload: Payload,
) {
  const initial = readState(jobId, payload.contract.parentTaskId);
  if (!initial) {
    if (isFactoryPeerParent(payload.contract.parentTaskId))
      throw new Error('Factory peer binding unavailable');
    return null;
  }
  const stateFor = (id: string, task: Payload): GameFactoryPeerState => {
    const state = readGameFactoryPeerState(id) as GameFactoryPeerState | null;
    if (
      !state ||
      id !== jobId ||
      state.networkId !== c.networkId ||
      state.jobId !== id ||
      state.parentTaskId !== task.contract.parentTaskId ||
      state.projectId !== task.contract.projectKey ||
      state.peerRevision !== task.contract.revision ||
      state.expiresAt !== task.contract.execution.expiresAt ||
      !isFactoryPeerParent(state.parentTaskId) ||
      task.contract.execution.mode !== 'isolated' ||
      task.contract.execution.guiAuthorized !== false
    )
      throw new Error('Factory peer binding mismatch');
    return state;
  };
  stateFor(jobId, payload);
  const current = (state: GameFactoryPeerState) =>
    state.current &&
    state.routeAllowed &&
    Date.parse(state.expiresAt) > Date.now();
  return {
    config: c,
    context: async (id: string, task: Payload) => {
      const state = stateFor(id, task);
      if (!current(state)) throw new Error('Factory peer context stale');
      return buildGameFactoryPeerContext(state);
    },
    contextCurrent: async (id: string, task: Payload) => {
      try {
        const state = stateFor(id, task),
          context = task.context;
        if (!current(state) || !context)
          return { valid: false, reason: 'changed' };
        const retained = new Map(state.records.map((r) => [r.key, digest(r)]));
        if (
          !context.records.every((r) => retained.get(r.key) === digest(r)) ||
          peerCanonicalJson(context) !==
            peerCanonicalJson(
              buildGameFactoryPeerContext(state, context.records),
            )
        )
          return { valid: false, reason: 'changed' };
        return { valid: true };
      } catch {
        return { valid: false, reason: 'changed' };
      }
    },
    supplementary: async (
      id: string,
      task: Payload,
      request: { query: string; recordKeys?: string[]; reason: string },
    ) => {
      const state = stateFor(id, task);
      if (
        !current(state) ||
        !request.reason?.trim() ||
        request.reason.length > 1000 ||
        typeof request.query !== 'string' ||
        request.query.length > 1000 ||
        (request.recordKeys?.length ?? 0) > 10
      )
        throw new Error('Factory supplementary context denied');
      const records = request.recordKeys?.length
        ? state.records.filter((r) => request.recordKeys!.includes(r.key))
        : state.records;
      return buildGameFactoryPeerContext(state, records);
    },
    publish: (event: PeerInboxEvent) => {
      const state = factoryPeerStateForEvent(c, event);
      if (!state || state.jobId !== jobId)
        throw new Error('Factory peer binding mismatch');
      // Stale results can be retained as stale. Inbox independently validates
      // current permission/hash before it exposes text or transfers files.
      writePeerInboxEvent(c, event);
    },
  };
}

/** Only the host passes this retained private dispatch specification. Preparing
 * the existing peer queue performs no SSH or second scheduling system. */
export async function prepareFactoryPeerJob(input: {
  jobId: string;
  coordinatorConfigPath: string;
  options: {
    title: string;
    prompt: string;
    notify: boolean;
    inputs: unknown[];
    contract: unknown;
  };
}): Promise<unknown> {
  const state = readGameFactoryPeerState(
    input.jobId,
  ) as GameFactoryPeerState | null;
  if (!state || !state.current || !state.routeAllowed)
    throw new Error('Factory peer binding unavailable');
  // The implementation lives in the pinned code root containing this module.
  const codeRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  const core = await import(
    pathToFileURL(path.join(codeRoot, 'ops/peer/skoobi-peer-core.mjs')).href
  );
  const peer = await import(
    pathToFileURL(path.join(codeRoot, 'ops/peer/skoobi-peer-v2.mjs')).href
  );
  const config = core.loadConfig(input.coordinatorConfigPath);
  if (config.role !== 'coordinator' || config.networkId !== state.networkId)
    throw new Error('Factory peer coordinator mismatch');
  return peer.preparePeerV2(config, input.options, undefined, input.jobId);
}
