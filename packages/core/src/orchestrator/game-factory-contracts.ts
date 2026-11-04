/** Личность и полномочия создаёт хост текущего запуска, а не аргументы модели. */
export interface FactoryActor {
  identityId: string;
  tenantId: string;
  chatJid: string;
  sourceGroup: string;
  senderId: string;
  /** Host-verified channel chat identity, never a model argument. */
  channelChatId?: string;
  currentMessageIds: string[];
  runId: string;
  isPrimaryOwner?: boolean;
}

export interface FactoryRequest {
  operationId: string;
  action: string;
  projectId?: string;
  expectedRevision?: number;
  args?: Record<string, unknown>;
}

export const FACTORY_READ_ACTIONS = [
  'capabilities',
  'list',
  'inspect',
  'context',
  'peer_result',
] as const;

export type FactoryBackend =
  | 'agent'
  | 'peer'
  | 'legacy'
  | 'codex_desktop'
  | 'claude_desktop'
  | 'gemini_desktop';
export type FactoryRole = 'owner' | 'editor' | 'reviewer' | 'reader';
export type FactoryPlatform = 'local' | 'yandex' | 'crazygames' | 'roblox';
export type FactoryStage =
  | 'brief'
  | 'playable'
  | 'art'
  | 'content'
  | 'qa'
  | 'package'
  | 'release'
  | 'learn';

export interface FactoryActorPolicy {
  identityId: string;
  tenantId: string;
  /** Псевдоним в интерфейсе, не адрес/телефон/ключ авторизации. */
  alias: string;
  canCreate: boolean;
  backends: FactoryBackend[];
  sourceRoots: string[];
}

export interface FactoryConfiguration {
  version: 1;
  enabled: boolean;
  primaryOwnerIdentityId?: string;
  actors: FactoryActorPolicy[];
  workspaceRoot: string;
  databasePath: string;
  accounts?: Array<{
    alias: string;
    platform: FactoryPlatform;
    actorAliases: string[];
  }>;
  peer?: {
    coordinatorConfigPath: string;
    networkId: string;
    model: string;
    reasoningEffort: string;
  };
  legacy?: { configurationPath: string };
}

export interface FactoryBrief {
  revision: number;
  goal: string;
  audience: string;
  firstSession: string;
  coreLoop: string;
  artDirection: string;
  acceptance: string[];
  devices: Array<'desktop' | 'mobile'>;
  platforms: FactoryPlatform[];
  exclusions: string[];
  budget: { currency: 'USD'; limitMicros: number };
  /** Разрешение публикации не выводится из производственного брифа. */
  publication: 'prepare_only';
  source: FactorySource;
}

export interface FactorySource {
  actorKey: string;
  messageIds: string[];
  at: string;
  trust: 'agent_interpreted';
}

export interface FactoryDecision {
  key: string;
  value: string;
  state: 'proposed' | 'accepted' | 'superseded' | 'forgotten';
  source: FactorySource;
  revision: number;
  replaces?: number;
}

export interface FactoryTask {
  id: string;
  stage: FactoryStage;
  title: string;
  acceptance: string[];
  dependencies: string[];
  briefRevision: number;
  state:
    | 'pending'
    | 'working'
    | 'submitted'
    | 'accepted'
    | 'blocked'
    | 'superseded'
    | 'cancelled';
  checkpoint?: string;
  buildId?: string;
  operationIds: string[];
  humanReviewRequired?: boolean;
  review?: {
    actorKey: string;
    at: string;
    decision: 'accepted' | 'changes_requested';
    note: string;
    evidenceIds: string[];
    assurance: 'coordinator_judgment';
  };
}

export interface FactoryLease {
  token: string;
  fencing: number;
  actorKey: string;
  runId: string;
  taskId: string;
  backend: FactoryBackend;
  briefRevision: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  /** Истечение таймера требует сверки исполнителя, а не второго редактора. */
  state: 'active' | 'reconcile_required';
  workDirectory: string;
}

export interface FactoryFile {
  path: string;
  sha256: string;
  size: number;
}

export interface FactoryBuild {
  id: string;
  briefRevision: number;
  version: string;
  root: string;
  entrypoint: string;
  manifestSha256: string;
  files: FactoryFile[];
  totalBytes: number;
  capturedAt: string;
  capturedBy: string;
}

export interface FactoryOperation {
  id: string;
  kind: 'peer' | 'image' | 'legacy' | 'desktop' | 'delivery' | 'asset';
  externalId: string;
  briefRevision: number;
  taskId?: string;
  state: 'linked' | 'running' | 'completed' | 'failed' | 'unknown';
  evidence: 'reported' | 'host_observed';
  /** A reported reference cannot manufacture an execution lock or completion. */
  tracking?: 'reference_only' | 'execution';
  resultHash?: string;
  resultConflict?: boolean;
  observedAt: string;
  detail?: string;
}

export interface FactoryEvidence {
  id: string;
  buildId: string;
  manifestSha256: string;
  kind: 'technical' | 'browser' | 'device' | 'human' | 'platform';
  criterion: string;
  result: 'pass' | 'fail' | 'unknown';
  trust: 'reported' | 'host_verified';
  source: FactorySource;
  receiptPath?: string;
  receiptSha256?: string;
  receiptId?: string;
  assurance?: 'startup_only' | 'verified_user_quote';
}

export interface FactoryRelease {
  id: string;
  buildId: string;
  platform: FactoryPlatform;
  mode: 'preview' | 'basic' | 'full';
  state:
    | 'prepared'
    | 'reported_submitted'
    | 'reported_live'
    | 'verified_submitted'
    | 'verified_live'
    | 'rejected';
  /** Аккаунт выбирает хост из приватной конфигурации, не произвольный логин. */
  accountAlias: string;
  sourceOfFirstPlayers: string;
  reviewAt: string;
  observedAt?: string;
  receipt?: string;
  bundle?: {
    path: string;
    sha256: string;
    bytes: number;
    manifestSha256: string;
    createdAt: string;
    profileId: string;
  };
}

export interface FactoryAsset {
  id: string;
  file: FactoryFile;
  relativePath: string;
  kind: 'image' | 'audio' | 'video' | 'font' | 'model' | 'other';
  provenance: string;
  rights: string;
  provider?: string;
  externalId?: string;
  costMicros?: number;
  state: 'candidate' | 'accepted' | 'rejected';
  source: FactorySource;
  review?: {
    state: 'accepted' | 'rejected';
    note: string;
    source: FactorySource;
  };
}

export interface FactoryProject {
  id: string;
  title: string;
  engine: 'canvas' | 'phaser' | 'threejs' | 'roblox' | 'other';
  ownerKey: string;
  revision: number;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  workspace: string;
  createdAt: string;
  updatedAt: string;
  origin?: { projectId?: string; sourceRoot?: string; note: string };
  brief: FactoryBrief;
  briefHistory: FactoryBrief[];
  decisions: FactoryDecision[];
  tasks: FactoryTask[];
  taskHistory: FactoryTask[];
  lease: FactoryLease | null;
  fencing: number;
  builds: FactoryBuild[];
  operations: FactoryOperation[];
  evidence: FactoryEvidence[];
  releases: FactoryRelease[];
  assets: FactoryAsset[];
}

export class FactoryError extends Error {
  constructor(
    public code: string,
    public revision?: number,
  ) {
    super(`Game factory: ${code}`);
    this.name = 'FactoryError';
  }
}
