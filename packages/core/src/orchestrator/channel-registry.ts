/**
 * Channel registry — channels self-register at startup.
 */
import type {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  OnTaskControl,
  OnTelegramCallbackQuery,
  OnTelegramMessageEdit,
  RegisteredGroup,
} from './types.js';
import type {
  OwnerAllowlistConfig,
  TenantRegistry,
} from './tenant-registry.js';
import type { OperationTraceObserver } from '@skoobi/shared/operation-trace';
import type { MediaIntakeAdapter } from '@skoobi/shared/media-intake';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onTelegramMessageEdit?: OnTelegramMessageEdit;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  tenantRegistry?: () => TenantRegistry;
  ownerAllowlist?: () => OwnerAllowlistConfig;
  onTelegramCallbackQuery?: OnTelegramCallbackQuery;
  /** «Остановить» buttons for scheduled tasks (W25); Telegram only. */
  onTaskControl?: OnTaskControl;
  /** Host-scoped observations only; never an authorization decision. */
  operationTrace?: (
    chatJid: string,
    messageId: string,
  ) => OperationTraceObserver | undefined;
  mediaIntake?: (botId?: string) => MediaIntakeAdapter | undefined;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
