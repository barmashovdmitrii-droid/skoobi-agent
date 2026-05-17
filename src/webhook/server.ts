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

// Rate limiting: per-group request counter
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10; // requests per minute
const RATE_WINDOW = 60_000;

function checkRateLimit(groupFolder: string): boolean {
  const now = Date.now();
  const entry = requestCounts.get(groupFolder);
  if (!entry || now > entry.resetAt) {
    requestCounts.set(groupFolder, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: string) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function startWebhookServer(
  port: number,
  secret: string,
  deps: WebhookDeps,
): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
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

    const prefix = isSend ? '/send/' : '/webhook/';
    const groupFolder = req.url!.slice(prefix.length).split('?')[0];
    if (!groupFolder) {
      sendJson(res, 400, { error: 'Missing group folder' });
      return;
    }

    // Rate limit
    if (!checkRateLimit(groupFolder)) {
      sendJson(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    // Read body
    const body = await readBody(req);

    // Verify HMAC signature
    const signature = req.headers['x-signature'] as string;
    if (!signature || !verifySignature(secret, body, signature)) {
      sendJson(res, 401, { error: 'Invalid signature' });
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
