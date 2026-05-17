/**
 * Channel registry — channels self-register at startup.
 */
import type {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  OnTelegramCallbackQuery,
  RegisteredGroup,
} from './types.js';
import type {
  OwnerAllowlistConfig,
  TenantRegistry,
} from './tenant-registry.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  tenantRegistry?: () => TenantRegistry;
  ownerAllowlist?: () => OwnerAllowlistConfig;
  onTelegramCallbackQuery?: OnTelegramCallbackQuery;
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
