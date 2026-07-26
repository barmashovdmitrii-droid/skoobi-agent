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

/**
 * Initiate a subscription purchase for a plan and return the hosted payform URL.
 * Returns null when payments are disabled or the plan/identity is unusable.
 */
export type OnPlanPurchase = (input: {
  /** Stable channel event/callback id, reused when delivery is retried. */
  purchaseId: string;
  planCode: string;
  chatJid: string;
  telegramUserId: string | number;
  tenantId?: string;
  channelUserId?: string;
  botUsername?: string;
}) => Promise<{ resultUrl: string } | null>;

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup?: (jid: string, group: RegisteredGroup) => void;
  tenantRegistry?: () => TenantRegistry;
  ownerAllowlist?: () => OwnerAllowlistConfig;
  onTelegramCallbackQuery?: OnTelegramCallbackQuery;
  onPlanPurchase?: OnPlanPurchase;
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
