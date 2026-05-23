import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';

const REQUEST_REGEX = /\bREQ-\d{4}-\d{6}\b/;
const REQUEST_PREFIX = 'REQ';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TEXT_LENGTH = 4000;
const MAX_RAW_MESSAGE_LENGTH = 8000;

const MEDIA_KINDS = new Set([
  'image',
  'video',
  'audio',
  'document',
  'sticker',
  'location',
  'contact',
]);

const AUTOPARTS_KEYWORDS = [
  'акпп',
  'амортиз',
  'артикул',
  'бампер',
  'двигател',
  'детал',
  'двер',
  'запчаст',
  'капот',
  'колод',
  'короб',
  'крыл',
  'кузов',
  'лев',
  'мотор',
  'насос',
  'oem',
  'оптика',
  'прав',
  'радиатор',
  'сид',
  'стеклоомыв',
  'стойк',
  'тормоз',
  'фар',
  'фильтр',
  'форсунк',
  'vin',
  'camry',
  'ceed',
  'kia',
  'hyundai',
  'solar',
  'toyota',
];

const REQUEST_HINTS =
  /\b(есть|ищу|купить|можно|нужн|подбер|сколько|стоим|цена|цену)\b/i;

export type AutopartsFetchResponse = {
  status: number;
  text(): Promise<string>;
};

export type AutopartsFetch = (
  url: string,
  init?: RequestInit,
) => Promise<AutopartsFetchResponse>;

export interface AutopartsPayloadConfig {
  baseUrl: string;
  email: string;
  password: string;
  privacyPolicyVersion: string;
  timeoutMs?: number;
  fetchImpl?: AutopartsFetch;
}

export interface AutopartsWhatsAppInbound {
  chatJid: string;
  phone: string;
  pushName?: string;
  text: string;
  content: string;
  mediaKind?: string | null;
  whatsappMessageId?: string;
  timestamp: string;
}

export interface AutopartsWhatsAppOutbound {
  chatJid: string;
  text: string;
}

type PayloadRecord = Record<string, any>;
type AuthState = { token: string | null; expiresAt: number };

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}

function jsonOrText(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function payloadDoc(result: any): any {
  return result?.doc ?? result;
}

function phoneFromSkoobiJid(jid: string): string {
  return jid.startsWith('wa:') ? jid.slice(3).replace(/[^0-9]/g, '') : '';
}

function phoneDisplay(phone: string): string {
  return phone ? `+${phone.replace(/[^0-9]/g, '')}` : '';
}

function mediaKindForPayload(mediaKind?: string | null): string | undefined {
  if (!mediaKind) return undefined;
  return MEDIA_KINDS.has(mediaKind) ? mediaKind : undefined;
}

function compactText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function requestText(input: AutopartsWhatsAppInbound): string {
  const text = input.text.trim();
  if (text) return text;
  if (input.mediaKind) return `[${input.mediaKind}]`;
  return input.content.trim();
}

function appendUnique(
  existing: string | null | undefined,
  addition: string,
  maxLength: number,
): string {
  const current = (existing || '').trim();
  const next = addition.trim();
  if (!next) return current;
  if (!current) return truncate(next, maxLength);
  if (current.includes(next)) return current;
  return truncate(`${current}\n${next}`, maxLength);
}

function mergeQueryText(
  existing: string | null | undefined,
  addition: string,
): string {
  return appendUnique(existing, addition, MAX_TEXT_LENGTH);
}

function transcriptLine(input: AutopartsWhatsAppInbound): string {
  const author = input.pushName || phoneDisplay(input.phone) || input.phone;
  const body = requestText(input);
  return `[${input.timestamp}] ${author}: ${body}`;
}

export function shouldCreateAutopartsRequest(
  input: Pick<AutopartsWhatsAppInbound, 'text' | 'content' | 'mediaKind'>,
): boolean {
  const text = compactText(input.text || input.content || '').toLowerCase();
  if (!text) {
    return ['audio', 'document', 'image'].includes(input.mediaKind || '');
  }
  if (
    input.mediaKind &&
    ['audio', 'document', 'image'].includes(input.mediaKind)
  ) {
    return true;
  }
  const hasKeyword = AUTOPARTS_KEYWORDS.some((keyword) =>
    text.includes(keyword),
  );
  if (!hasKeyword) return false;
  if (REQUEST_HINTS.test(text)) return true;
  if (/\b(19|20)\d{2}\b/.test(text)) return true;
  if (/[a-hj-npr-z0-9]{11,17}/i.test(text)) return true;
  return text.length >= 12;
}

export class AutopartsPayloadClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: AutopartsFetch;
  private readonly auth: AuthState = { token: null, expiresAt: 0 };

  constructor(private readonly config: AutopartsPayloadConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl =
      config.fetchImpl ??
      (globalThis.fetch as unknown as AutopartsFetch | undefined) ??
      (async () => {
        throw new Error('fetch is not available in this Node runtime');
      });
  }

  get privacyPolicyVersion(): string {
    return this.config.privacyPolicyVersion;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<AutopartsFetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async login(): Promise<string> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/api/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: this.config.email,
        password: this.config.password,
      }),
    });
    const text = await res.text();
    if (res.status >= 300) {
      throw new Error(`Payload login failed (${res.status}): ${text}`);
    }
    const data = jsonOrText(text) as { token?: string; exp?: number };
    if (!data || typeof data.token !== 'string') {
      throw new Error('Payload login response did not include a token');
    }
    this.auth.token = data.token;
    this.auth.expiresAt =
      typeof data.exp === 'number'
        ? data.exp * 1000 - 60_000
        : Date.now() + 10 * 60_000;
    return data.token;
  }

  private async token(): Promise<string> {
    if (this.auth.token && Date.now() < this.auth.expiresAt) {
      return this.auth.token;
    }
    return this.login();
  }

  private async call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    retried = false,
  ): Promise<any> {
    const token = await this.token();
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `JWT ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if ((res.status === 401 || res.status === 403) && !retried) {
      this.auth.token = null;
      this.auth.expiresAt = 0;
      return this.call(method, path, body, true);
    }
    if (res.status >= 300) {
      throw new Error(
        `Payload ${method} ${path} failed (${res.status}): ${text}`,
      );
    }
    return jsonOrText(text);
  }

  async findCustomerRequestByPhone(
    phone: string,
  ): Promise<PayloadRecord | null> {
    const normalized = phone.replace(/[^0-9]/g, '');
    const where = encodeURIComponent(
      JSON.stringify({
        or: [
          { customerWhatsapp: { equals: `+${normalized}` } },
          { customerWhatsapp: { equals: normalized } },
          { customerWhatsapp: { contains: normalized } },
          { customerPhone: { contains: normalized } },
        ],
      }),
    );
    const sort = encodeURIComponent('-createdAt');
    const res = await this.call(
      'GET',
      `/api/customer-requests?where=${where}&sort=${sort}&limit=1&depth=0`,
    );
    return res?.docs?.[0] ?? null;
  }

  async findCustomerRequestByNumber(
    requestNumber: string,
  ): Promise<PayloadRecord | null> {
    const where = encodeURIComponent(
      JSON.stringify({ requestNumber: { equals: requestNumber } }),
    );
    const res = await this.call(
      'GET',
      `/api/customer-requests?where=${where}&limit=1&depth=0`,
    );
    return res?.docs?.[0] ?? null;
  }

  async getNextRequestNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `${REQUEST_PREFIX}-${year}-`;
    const where = encodeURIComponent(
      JSON.stringify({ requestNumber: { like: prefix } }),
    );
    const sort = encodeURIComponent('-requestNumber');
    const res = await this.call(
      'GET',
      `/api/customer-requests?where=${where}&sort=${sort}&limit=1&depth=0`,
    );
    const last = res?.docs?.[0];
    let next = 1;
    if (last?.requestNumber) {
      const trail = String(last.requestNumber).split('-').pop() || '0';
      const parsed = parseInt(trail, 10);
      if (Number.isFinite(parsed)) next = parsed + 1;
    }
    return `${prefix}${String(next).padStart(6, '0')}`;
  }

  async createCustomerRequest(
    data: Record<string, unknown>,
  ): Promise<PayloadRecord> {
    return payloadDoc(await this.call('POST', '/api/customer-requests', data));
  }

  async updateCustomerRequest(
    id: string | number,
    data: Record<string, unknown>,
  ): Promise<PayloadRecord> {
    return payloadDoc(
      await this.call('PATCH', `/api/customer-requests/${id}`, data),
    );
  }

  async createWhatsAppMessage(
    data: Record<string, unknown>,
  ): Promise<PayloadRecord> {
    return payloadDoc(await this.call('POST', '/api/whatsapp-messages', data));
  }

  async createLeadEvent(data: Record<string, unknown>): Promise<PayloadRecord> {
    return payloadDoc(await this.call('POST', '/api/lead-events', data));
  }
}

export class AutopartsWhatsAppBridge {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly client: AutopartsPayloadClient) {}

  async recordInbound(input: AutopartsWhatsAppInbound): Promise<void> {
    const phone = input.phone || phoneFromSkoobiJid(input.chatJid);
    if (!phone) return;
    await this.withPhoneQueue(phone, () =>
      this.recordInboundUnlocked({ ...input, phone }),
    );
  }

  async recordOutbound(input: AutopartsWhatsAppOutbound): Promise<void> {
    const phone = phoneFromSkoobiJid(input.chatJid);
    if (!phone || !input.text.trim()) return;
    await this.withPhoneQueue(phone, async () => {
      const request = await this.client.findCustomerRequestByPhone(phone);
      if (!request) {
        logger.debug(
          { chatJid: input.chatJid },
          'autoparts_outbound_without_request',
        );
        return;
      }
      await this.client.createWhatsAppMessage({
        direction: 'outgoing',
        customerRequest: request.id,
        fromPhone: null,
        toPhone: phoneDisplay(phone),
        text: input.text,
        mediaKind: null,
        whatsappMessageId: null,
        isAutoReply: true,
      });
      logger.info(
        { chatJid: input.chatJid, requestNumber: request.requestNumber },
        'autoparts_message_saved',
      );
    });
  }

  private async withPhoneQueue<T>(
    phone: string,
    op: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(phone) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(op);
    this.queues.set(phone, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(phone) === next) {
        this.queues.delete(phone);
      }
    }
  }

  private async recordInboundUnlocked(
    input: AutopartsWhatsAppInbound,
  ): Promise<void> {
    const request = await this.ensureCustomerRequest(input);
    await this.client.createWhatsAppMessage({
      direction: 'incoming',
      customerRequest: request?.id,
      fromPhone: phoneDisplay(input.phone),
      toPhone: null,
      text: input.text,
      mediaKind: mediaKindForPayload(input.mediaKind),
      whatsappMessageId: input.whatsappMessageId || undefined,
      pushName: input.pushName || undefined,
    });
    logger.info(
      { chatJid: input.chatJid, requestNumber: request?.requestNumber },
      'autoparts_message_saved',
    );
    if (!request) return;
    await this.client
      .createLeadEvent({
        eventType: 'whatsapp_click',
        customerRequest: request.id,
        queryText: requestText(input),
        sourcePage: 'whatsapp:skoobi',
      })
      .catch((err) =>
        logger.warn(
          { err, chatJid: input.chatJid },
          'autoparts_lead_event_failed',
        ),
      );
  }

  private async ensureCustomerRequest(
    input: AutopartsWhatsAppInbound,
  ): Promise<PayloadRecord | null> {
    const refMatch = input.text.match(REQUEST_REGEX);
    let request = refMatch
      ? await this.client.findCustomerRequestByNumber(refMatch[0])
      : null;
    if (!request) {
      request = await this.client.findCustomerRequestByPhone(input.phone);
    }
    if (request) {
      logger.info(
        { chatJid: input.chatJid, requestNumber: request.requestNumber },
        'autoparts_request_found',
      );
      return this.updateCustomerRequest(request, input);
    }
    if (!shouldCreateAutopartsRequest(input)) {
      logger.info({ chatJid: input.chatJid }, 'autoparts_request_not_created');
      return null;
    }
    const requestNumber = await this.client.getNextRequestNumber();
    const now = new Date().toISOString();
    request = await this.client.createCustomerRequest({
      requestNumber,
      channel: 'whatsapp',
      status: 'new',
      customerName: input.pushName || undefined,
      customerWhatsapp: phoneDisplay(input.phone),
      queryText: requestText(input),
      rawMessage: transcriptLine(input),
      sourcePage: 'whatsapp:skoobi',
      consentAcceptedAt: now,
      privacyPolicyVersion: this.client.privacyPolicyVersion,
      whatsappClickedAt: now,
      city: 'Актау',
    });
    logger.info(
      { chatJid: input.chatJid, requestNumber },
      'autoparts_request_created',
    );
    await this.client
      .createLeadEvent({
        eventType: 'request_created',
        customerRequest: request.id,
        queryText: requestText(input),
        sourcePage: 'whatsapp:skoobi',
      })
      .catch((err) =>
        logger.warn(
          { err, chatJid: input.chatJid },
          'autoparts_lead_event_failed',
        ),
      );
    return request;
  }

  private async updateCustomerRequest(
    request: PayloadRecord,
    input: AutopartsWhatsAppInbound,
  ): Promise<PayloadRecord> {
    const updates: Record<string, unknown> = {};
    const query = requestText(input);
    const nextQueryText = mergeQueryText(request.queryText, query);
    const nextRawMessage = appendUnique(
      request.rawMessage,
      transcriptLine(input),
      MAX_RAW_MESSAGE_LENGTH,
    );
    if (nextQueryText && nextQueryText !== request.queryText) {
      updates.queryText = nextQueryText;
    }
    if (nextRawMessage && nextRawMessage !== request.rawMessage) {
      updates.rawMessage = nextRawMessage;
    }
    if (!request.customerWhatsapp) {
      updates.customerWhatsapp = phoneDisplay(input.phone);
    }
    if (!request.customerName && input.pushName) {
      updates.customerName = input.pushName;
    }
    if (Object.keys(updates).length === 0) return request;
    return this.client.updateCustomerRequest(request.id, updates);
  }
}

export function createAutopartsWhatsAppBridgeFromEnv(): AutopartsWhatsAppBridge | null {
  const env = readEnvFile([
    'AUTOPARTS_BACKEND_ENABLED',
    'AUTOPARTS_WHATSAPP_BACKEND_ENABLED',
    'AUTOPARTS_BACKEND_URL',
    'AUTOPARTS_PAYLOAD_URL',
    'AUTOPARTS_PAYLOAD_EMAIL',
    'AUTOPARTS_PAYLOAD_PASSWORD',
    'AUTOPARTS_PRIVACY_POLICY_VERSION',
    'BOT_PAYLOAD_URL',
    'BOT_PAYLOAD_EMAIL',
    'BOT_PAYLOAD_PASSWORD',
    'PRIVACY_POLICY_VERSION',
  ]);
  const value = (key: string): string => process.env[key] || env[key] || '';
  const enabled =
    value('AUTOPARTS_BACKEND_ENABLED') === 'true' ||
    value('AUTOPARTS_WHATSAPP_BACKEND_ENABLED') === 'true';
  if (!enabled) return null;
  const baseUrl =
    value('AUTOPARTS_BACKEND_URL') ||
    value('AUTOPARTS_PAYLOAD_URL') ||
    value('BOT_PAYLOAD_URL');
  const email = value('AUTOPARTS_PAYLOAD_EMAIL') || value('BOT_PAYLOAD_EMAIL');
  const password =
    value('AUTOPARTS_PAYLOAD_PASSWORD') || value('BOT_PAYLOAD_PASSWORD');
  const privacyPolicyVersion =
    value('AUTOPARTS_PRIVACY_POLICY_VERSION') ||
    value('PRIVACY_POLICY_VERSION') ||
    '2026-05-23';
  if (!baseUrl || !email || !password) {
    logger.warn(
      {
        hasBaseUrl: Boolean(baseUrl),
        hasEmail: Boolean(email),
        hasPassword: Boolean(password),
      },
      'autoparts_backend_config_incomplete',
    );
    return null;
  }
  logger.info({ baseUrl }, 'autoparts_backend_enabled');
  return new AutopartsWhatsAppBridge(
    new AutopartsPayloadClient({
      baseUrl,
      email,
      password,
      privacyPolicyVersion,
    }),
  );
}
