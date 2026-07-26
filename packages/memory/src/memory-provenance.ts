import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'crypto';

export const SIGNED_MEMORY_MARKER_PREFIX = 'skoobi_memory_v2=';

export type SignedMemoryMetadata = Record<string, unknown> & {
  source_type?: string;
  confidence?: number;
  provenance?: string;
  sender_id?: string | null;
  tenant_id?: string | null;
  identity_id?: string | null;
  persona_id?: string | null;
  bot_id?: string | null;
};

export interface SignedMemoryPayload {
  v: 1;
  entry_id: string;
  scope: string;
  stamp: string;
  content: string;
  metadata: SignedMemoryMetadata;
}

export interface VerifiedMemoryEntry {
  payload: SignedMemoryPayload;
  envelope: string;
}

const SIGNED_MEMORY_MARKER_RE =
  /<!--\s*skoobi_memory_v2=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\s*-->/g;

function isSignedMemoryPayload(value: unknown): value is SignedMemoryPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    typeof record.entry_id === 'string' &&
    /^[A-Za-z0-9_-]{8,128}$/.test(record.entry_id) &&
    typeof record.scope === 'string' &&
    record.scope.length > 0 &&
    record.scope.length <= 1024 &&
    typeof record.stamp === 'string' &&
    record.stamp.length > 0 &&
    record.stamp.length <= 64 &&
    typeof record.content === 'string' &&
    record.content.length <= 256 * 1024 &&
    !!record.metadata &&
    typeof record.metadata === 'object' &&
    !Array.isArray(record.metadata)
  );
}

export function publicKeyPemFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

export function createSignedMemoryEnvelope(
  payload: SignedMemoryPayload,
  privateKeyPem: string,
): string {
  if (!isSignedMemoryPayload(payload)) {
    throw new Error('Invalid signed-memory payload');
  }
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const encodedPayload = payloadBytes.toString('base64url');
  const signature = cryptoSign(null, payloadBytes, privateKeyPem).toString(
    'base64url',
  );
  return `${encodedPayload}.${signature}`;
}

export function signedMemoryEntryLine(
  payload: SignedMemoryPayload,
  privateKeyPem: string,
): string {
  const envelope = createSignedMemoryEnvelope(payload, privateKeyPem);
  const visible = payload.content.replace(/\r?\n/g, ' ↩ ');
  return `- [${payload.stamp}] ${visible} <!-- ${SIGNED_MEMORY_MARKER_PREFIX}${envelope} -->\n`;
}

export function verifySignedMemoryEnvelope(
  envelope: string,
  publicKeyPem: string,
  expectedScope?: string,
): VerifiedMemoryEntry | null {
  const parts = envelope.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const payloadBytes = Buffer.from(parts[0], 'base64url');
    const signature = Buffer.from(parts[1], 'base64url');
    if (
      payloadBytes.length === 0 ||
      payloadBytes.length > 512 * 1024 ||
      signature.length === 0 ||
      !cryptoVerify(null, payloadBytes, publicKeyPem, signature)
    ) {
      return null;
    }
    const payload: unknown = JSON.parse(payloadBytes.toString('utf8'));
    if (!isSignedMemoryPayload(payload)) return null;
    if (expectedScope !== undefined && payload.scope !== expectedScope) {
      return null;
    }
    return { payload, envelope };
  } catch {
    return null;
  }
}

export function extractVerifiedMemoryEntries(
  markdown: string,
  publicKeyPem: string,
  expectedScope: string,
): VerifiedMemoryEntry[] {
  const result: VerifiedMemoryEntry[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(SIGNED_MEMORY_MARKER_RE)) {
    const verified = verifySignedMemoryEnvelope(
      match[1],
      publicKeyPem,
      expectedScope,
    );
    if (!verified || seen.has(verified.payload.entry_id)) continue;
    seen.add(verified.payload.entry_id);
    result.push(verified);
  }
  return result;
}
