import { createServer, IncomingMessage, ServerResponse } from 'http';
import crypto from 'crypto';
import { logger } from '../orchestrator/logger.js';
import type { MessageIngestion } from '../orchestrator/types.js';

export interface WebhookDeps {
  ingestion: MessageIngestion;
  findGroupByFolder: (folder: string) => { jid: string; name: string } | undefined;
  /** Send a message directly to a registered group's chat without spawning
   * an agent. Used for owner-approved canned replies routed via webhook. */
  sendDirect?: (folder: string, text: string) => Promise<void>;
}

// Per-group rate limit (post-auth, business limit)
const GROUP_RATE_LIMIT = 10;
// Per-IP rate limit (pre-auth abuse protection — covers anonymous traffic
// before HMAC verification; must be high enough not to throttle legit callers,
// low enough to bound memory/CPU under flood).
const IP_RATE_LIMIT = 120;
const RATE_WINDOW = 60_000;
// Max body bytes accepted before HMAC verification. Webhook payloads are
// short JSON envelopes; uncapped reads let an unauthenticated client exhaust
// memory before we ever check the signature.
const MAX_BODY_BYTES = 256 * 1024;

type RateEntry = { count: number; resetAt: number };

function checkRate(map: Map<string, RateEntry>, key: string, limit: number): boolean {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    map.set(key, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

export function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return;
      const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bytes += len;
      if (bytes > maxBytes) {
        aborted = true;
        resolve(null);
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => { if (!aborted) resolve(data); });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function clientIpOf(req: IncomingMessage): string {
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

export function startWebhookServer(
  port: number,
  secret: string,
  deps: WebhookDeps,
): ReturnType<typeof createServer> {
  // Per-server rate maps so each instance (and each test) starts clean.
  const groupRequestCounts = new Map<string, RateEntry>();
  const ipRequestCounts = new Map<string, RateEntry>();

  const server = createServer(async (req, res) => {
    // Health check — open path. Still subject to per-IP rate limit so anonymous
    // flood on /health cannot starve legit clients sharing the same listener.
    if (req.method === 'GET' && req.url === '/health') {
      if (!checkRate(ipRequestCounts, clientIpOf(req), IP_RATE_LIMIT)) {
        sendJson(res, 429, { error: 'Rate limit exceeded' });
        return;
      }
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // Routes: POST /webhook/:folder (spawn agent) and POST /send/:folder (direct send)
    const isSend = req.method === 'POST' && req.url?.startsWith('/send/');
    const isAgent = req.method === 'POST' && req.url?.startsWith('/webhook/');
    if (!isSend && !isAgent) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // Pre-auth: per-IP abuse protection. Must happen before reading body and
    // before any group-keyed work, otherwise anonymous callers can poison
    // per-group counters for known group names and DoS legitimate webhooks.
    if (!checkRate(ipRequestCounts, clientIpOf(req), IP_RATE_LIMIT)) {
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    const prefix = isSend ? '/send/' : '/webhook/';
    const groupFolder = req.url!.slice(prefix.length).split('?')[0];
    if (!groupFolder) {
      sendJson(res, 400, { error: 'Missing group folder' });
      return;
    }

    // Read body with hard cap (defends memory before HMAC).
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) {
      sendJson(res, 413, { error: 'Payload too large' });
      return;
    }

    // Verify HMAC signature before any group-keyed bookkeeping.
    const signature = req.headers['x-signature'] as string;
    if (!signature || !verifySignature(secret, body, signature)) {
      sendJson(res, 401, { error: 'Invalid signature' });
      return;
    }

    // Post-auth: per-group business rate limit. Only authenticated callers
    // contribute to this counter, so a single noisy legit integration cannot
    // be silenced by anonymous traffic.
    if (!checkRate(groupRequestCounts, groupFolder, GROUP_RATE_LIMIT)) {
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    // Lookup group
    const group = deps.findGroupByFolder(groupFolder);
    if (!group) {
      sendJson(res, 404, { error: 'Group not found' });
      return;
    }

    // Parse payload
    let payload: { prompt?: string; text?: string; [key: string]: unknown };
    try {
      payload = JSON.parse(body);
    } catch {
      payload = { prompt: body };
    }

    if (isSend) {
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text.trim()) {
        sendJson(res, 400, { error: 'text required' });
        return;
      }
      if (!deps.sendDirect) {
        sendJson(res, 501, { error: 'sendDirect not configured' });
        return;
      }
      try {
        await deps.sendDirect(groupFolder, text);
        logger.info(
          { groupFolder, jid: group.jid, length: text.length },
          'Direct send delivered',
        );
        sendJson(res, 200, { status: 'sent', group: group.name });
      } catch (err) {
        logger.error({ err, groupFolder }, 'Direct send failed');
        sendJson(res, 500, { error: 'send failed' });
      }
      return;
    }

    const prompt = payload.prompt || JSON.stringify(payload);

    // Ingest via the routing service
    const accepted = await deps.ingestion.ingest({
      groupFolder,
      chatJid: group.jid,
      sender: 'webhook',
      senderName: 'Webhook',
      triggerType: 'webhook',
      prompt,
      bypassTrigger: true,
    });

    if (accepted) {
      logger.info({ groupFolder, jid: group.jid }, 'Webhook triggered');
      sendJson(res, 200, { status: 'accepted', group: group.name });
    } else {
      sendJson(res, 200, { status: 'dropped', group: group.name });
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Webhook server listening');
  });

  return server;
}
