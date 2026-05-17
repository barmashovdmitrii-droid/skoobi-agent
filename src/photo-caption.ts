/**
 * Photo vision captioning (Tier 1).
 *
 * Sends a saved JPEG/PNG to Anthropic's vision-capable Haiku and gets a
 * short Russian description back. We use this caption as the placeholder
 * content for `messages.content` so the agent has searchable context
 * without us storing the raw absolute path.
 *
 * Constraints from the spec:
 *  - Russian, 1–2 sentences, neutral, search-friendly, no markdown.
 *  - 30s timeout. Any failure (no API key, network, parse) → null.
 *  - Cost-tracked through the existing `logAgentRun` helper.
 *  - Prompt caching enabled on the system prompt to keep marginal cost
 *    near zero across batches of photos.
 */

import { promises as fs } from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

import { logger } from './orchestrator/logger.js';
import { basenameOnly, redactString } from './lib/log-sanitize.js';
import { logAgentRun } from './cost-tracking/index.js';

const PHOTO_CAPTION_MODEL =
  process.env.PHOTO_CAPTION_MODEL || 'claude-haiku-4-5';

const CAPTION_TIMEOUT_MS = parseInt(
  process.env.PHOTO_CAPTION_TIMEOUT_MS || '30000',
  10,
);

const SYSTEM_PROMPT = [
  'Ты — описатель фото для базы сообщений мессенджера.',
  'Получая изображение, верни 1–2 предложения по-русски с нейтральным',
  'описанием для последующего полнотекстового поиска.',
  'Не используй markdown, не пиши вступительных оборотов вроде',
  '«На изображении...», начинай прямо с сути. Если фото содержит',
  'персональные данные (документы, банковские карты), не цитируй',
  'их дословно, опиши категорию.',
].join(' ');

type SupportedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

function extToMimeType(p: string): SupportedMime | null {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return null;
  }
}

function captionErrorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const withCode = err as Error & {
      code?: unknown;
      status?: unknown;
      type?: unknown;
    };
    return {
      name: err.name,
      code: withCode.code,
      status: withCode.status,
      type: withCode.type,
      message: redactString(err.message),
    };
  }
  return { message: redactString(err) };
}

/**
 * Caption a photo. Returns the caption string on success or null on any
 * failure path. Failures are logged at warn level but never thrown.
 *
 * `costMeta` lets the caller attribute the spend to a specific group /
 * chat in the `agent_runs` table. If omitted, defaults to a sentinel so
 * the row is still recorded but easy to filter.
 */
export async function captionPhoto(
  photoPath: string,
  costMeta?: { groupFolder?: string; chatJid?: string },
): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    logger.debug(
      { photoBasename: basenameOnly(photoPath) },
      'photo-caption: ANTHROPIC_API_KEY not set, skipping',
    );
    return null;
  }

  const mediaType = extToMimeType(photoPath);
  if (!mediaType) {
    logger.debug(
      { photoBasename: basenameOnly(photoPath) },
      'photo-caption: unsupported image extension, skipping',
    );
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(photoPath);
  } catch (err) {
    logger.warn(
      {
        error: captionErrorSummary(err),
        photoBasename: basenameOnly(photoPath),
      },
      'photo-caption: could not read photo',
    );
    return null;
  }

  const data = buffer.toString('base64');
  const client = new Anthropic({ apiKey });

  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTION_TIMEOUT_MS);
  try {
    const resp = await client.messages.create(
      {
        model: PHOTO_CAPTION_MODEL,
        max_tokens: 200,
        system: [
          {
            type: 'text',
            text: SYSTEM_PROMPT,
            // Cache the system prompt so subsequent captions cost ~nothing
            // beyond the image payload. The cache key is the system text,
            // which is stable across requests.
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data,
                },
              },
            ],
          },
        ],
      },
      { signal: controller.signal as unknown as AbortSignal },
    );

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    if (!text) {
      logger.warn(
        { photoBasename: basenameOnly(photoPath) },
        'photo-caption: empty response',
      );
      return null;
    }

    // Cost-track. Use the existing logAgentRun helper so retention/billing
    // dashboards already aware of agent_runs see vision usage.
    try {
      logAgentRun({
        groupFolder: costMeta?.groupFolder ?? 'photo-caption',
        chatJid: costMeta?.chatJid ?? 'photo-caption',
        triggerType: 'message',
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
        cacheCreationTokens: resp.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: resp.usage?.cache_read_input_tokens ?? 0,
        durationMs: Date.now() - start,
        turns: 1,
        model: PHOTO_CAPTION_MODEL,
        status: 'success',
      });
    } catch (err) {
      logger.warn(
        { error: captionErrorSummary(err) },
        'photo-caption: failed to record cost',
      );
    }

    return text;
  } catch (err) {
    logger.warn(
      {
        error: captionErrorSummary(err),
        photoBasename: basenameOnly(photoPath),
      },
      'photo-caption: API call failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
