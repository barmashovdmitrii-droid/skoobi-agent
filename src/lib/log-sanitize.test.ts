import { describe, it, expect } from 'vitest';
import {
  basenameOnly,
  hashShort,
  redactString,
  redactLogObject,
  PINO_REDACT_PATHS,
} from './log-sanitize.js';

describe('basenameOnly', () => {
  it('returns the basename for an absolute path', () => {
    expect(
      basenameOnly(
        '/Users/example/my-assistant/claudeclaw/groups/telegram_fixture_user/received/2026-05-11T10-20-30-000Z-voice-12345678.oga',
      ),
    ).toBe('2026-05-11T10-20-30-000Z-voice-12345678.oga');
  });

  it('returns the file name unchanged for a basename input', () => {
    expect(basenameOnly('voice.oga')).toBe('voice.oga');
  });

  it('returns empty string for non-string or empty input', () => {
    expect(basenameOnly('')).toBe('');
    expect(basenameOnly(undefined)).toBe('');
    expect(basenameOnly(null)).toBe('');
    expect(basenameOnly(42 as unknown)).toBe('');
  });
});

describe('hashShort', () => {
  it('produces an 8-character hex string', () => {
    const h = hashShort('Fixture User');
    expect(h).toHaveLength(8);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable for the same input', () => {
    expect(hashShort('Fixture A')).toBe(hashShort('Fixture A'));
  });

  it('differs for different inputs', () => {
    expect(hashShort('Fixture A')).not.toBe(hashShort('Fixture B'));
  });

  it('coerces non-string values without throwing', () => {
    expect(hashShort(undefined)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashShort(null)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashShort(1234567890)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('redactString', () => {
  it('redacts a Telegram bot token with the bot prefix', () => {
    const sample =
      'curl https://api.telegram.org/bot1234567890:AAEhBP0av5VfaTrJWA-FAKE-TOKEN-DATA/getMe';
    const out = redactString(sample);
    expect(out).not.toContain('1234567890');
    expect(out).not.toContain('AAEhBP0av5VfaTrJWA');
    expect(out).toContain('bot<redacted>');
  });

  it('redacts a generic <digits>:<long-body> token', () => {
    // Use a non-header context so the generic-token rule is what fires here
    // (the authorization=… form is covered by its own test below).
    const token = ['987654321', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(
      ':',
    );
    const sample = `creds ${token} end`;
    const out = redactString(sample);
    expect(out).toContain('<token-redacted>');
    expect(out).not.toContain('987654321:');
    expect(out).toContain(' end');
  });

  it('redacts /Users/example/... absolute paths', () => {
    const sample =
      'Saved voice at /Users/example/my-assistant/claudeclaw/groups/telegram_fixture_user/received/x.oga done';
    const out = redactString(sample);
    expect(out).toContain('<path-redacted>');
    expect(out).not.toContain('/Users/example/');
    expect(out).toContain(' done');
  });

  it('redacts local absolute paths outside the example macOS home folder', () => {
    const sample =
      'paths: /Users/example/project/.env /var/folders/a/b/tmp/file.jpg /private/var/folders/a/b/tmp/file.jpg /tmp/skoobi/file.txt';
    const out = redactString(sample);
    expect(out).not.toContain('/Users/example/');
    expect(out).not.toContain('/var/folders');
    expect(out).not.toContain('/private/var/folders');
    expect(out).not.toContain('/tmp/skoobi');
    expect(out.match(/<path-redacted>/g)).toHaveLength(4);
  });

  it('leaves clean strings untouched', () => {
    expect(redactString('hello world')).toBe('hello world');
    expect(redactString('chars: 42')).toBe('chars: 42');
  });

  it('handles null/undefined/non-strings without throwing', () => {
    expect(redactString(undefined)).toBe('');
    expect(redactString(null)).toBe('');
    expect(redactString(7)).toBe('7');
  });

  it('redacts multiple occurrences in one string', () => {
    const sample =
      'paths: /Users/example/a.txt and /Users/example/b.txt token bot111111:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const out = redactString(sample);
    expect(out).not.toContain('/Users/example/');
    expect(out).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  // --- Real secret formats this production bot actually handles (L23) ---

  it('redacts an Anthropic API key', () => {
    const secret = ['sk', 'ant', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKE0123'].join('-');
    const out = redactString(`x-anthropic: ${secret} ok`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('FAKEFAKEFAKE');
    expect(out).toContain('<key-redacted>');
    expect(out).toContain(' ok');
  });

  it('redacts an OpenAI sk-proj- style API key', () => {
    const secret = ['sk', 'proj', 'FAKEFAKEFAKEFAKEFAKEFAKEFAKE9876'].join('-');
    const out = redactString(`key=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('FAKEFAKEFAKE');
    expect(out).toContain('<key-redacted>');
  });

  it('redacts an Authorization: Bearer header value but keeps the field name', () => {
    const out = redactString(
      'authorization: Bearer FAKE-MODEL-GATEWAY-KEY-abc123',
    );
    expect(out).toContain('authorization');
    expect(out).not.toContain('FAKE-MODEL-GATEWAY-KEY-abc123');
    expect(out).not.toContain('Bearer FAKE');
    expect(out).toContain('<redacted>');
  });

  it('redacts an x-api-key header value but keeps the field name', () => {
    const out = redactString(
      'x-api-key=FAKE-PROXY-INJECTED-KEY-xyz789 trailing',
    );
    expect(out).toContain('x-api-key');
    expect(out).not.toContain('FAKE-PROXY-INJECTED-KEY-xyz789');
    expect(out).toContain('<redacted>');
    expect(out).toContain(' trailing');
  });

  it('redacts a credential-bearing URL query param value but keeps the param name', () => {
    const out = redactString(
      'GET https://image.example/api?model=v3&key=FAKE-IMAGE-GATEWAY-APIKEY-001&n=1',
    );
    expect(out).not.toContain('FAKE-IMAGE-GATEWAY-APIKEY-001');
    expect(out).toContain('key=<redacted>');
    // Non-secret params are preserved.
    expect(out).toContain('model=v3');
    expect(out).toContain('n=1');
  });

  it('redacts ?token= and &secret= and &api_key= query params', () => {
    const out = redactString(
      'u?token=FAKE-TOK-aaa&secret=FAKE-SEC-bbb&api_key=FAKE-AK-ccc',
    );
    expect(out).not.toContain('FAKE-TOK-aaa');
    expect(out).not.toContain('FAKE-SEC-bbb');
    expect(out).not.toContain('FAKE-AK-ccc');
    expect(out).toContain('token=<redacted>');
    expect(out).toContain('secret=<redacted>');
    expect(out).toContain('api_key=<redacted>');
  });

  it('does not over-redact ordinary sk- prefixed words or short values', () => {
    // Real words / short tokens must survive (avoid over-redaction).
    expect(redactString('skip the sketch')).toBe('skip the sketch');
    expect(redactString('sk-short')).toBe('sk-short');
    expect(redactString('the key is here')).toBe('the key is here');
  });

  // --- Slack / GitHub token formats from .env.example (finding #45) ---

  it('redacts a Slack xoxb- bot token', () => {
    const secret = [
      'xoxb',
      '2345678901',
      '2345678901234',
      'AbCdEfGhIjKlMnOpQrStUvWx',
    ].join('-');
    const out = redactString(`Slack API error for ${secret} end`);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
    expect(out).toContain('<slack-token-redacted>');
    expect(out).toContain(' end');
  });

  it('redacts a Slack xapp- app-level token', () => {
    const secret = [
      'xapp',
      '1-A01B2C3D4E5-1234567890123-abcdefghijklmnopqrstuvwxyz',
    ].join('-');
    const out = redactString(`token=${secret}`);
    expect(out).not.toContain(secret);
    expect(out).toContain('<slack-token-redacted>');
  });

  it('redacts a GitHub ghp_ personal access token', () => {
    const secret = ['ghp', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('_');
    const out = redactString(`https://${secret}@github.com/x ok`);
    expect(out).not.toContain(secret);
    expect(out).toContain('<gh-token-redacted>');
    expect(out).toContain('@github.com/x ok');
  });

  it('redacts a GitHub fine-grained github_pat_ token', () => {
    const secret = [
      'github',
      'pat',
      '11ABCDEFG0aBcDeFgHiJ',
      'KLMNOPqrstuvwxyz1234567890ABCDEF',
    ].join('_');
    const out = redactString(`auth ${secret} done`);
    expect(out).not.toContain(secret);
    expect(out).toContain('<gh-token-redacted>');
    expect(out).toContain(' done');
  });

  it('does not over-redact ordinary xox/gh prefixed words', () => {
    // Common words / non-token prefixes must survive (avoid over-redaction).
    expect(redactString('the box of foxes')).toBe('the box of foxes');
    expect(redactString('ghastly ghoul ghp_short')).toBe(
      'ghastly ghoul ghp_short',
    );
    expect(redactString('github_pattern is a normal word')).toBe(
      'github_pattern is a normal word',
    );
  });

  it('replaces every supported WhatsApp JID form with a safe stable label', () => {
    const direct = '15551234567:4@s.whatsapp.net';
    const group = '120363400001234567-1712345678@g.us';
    const lid = '987654321098765@lid';
    const out = redactString(`from=${direct} group=${group} lid=${lid}`);

    for (const raw of [direct, group, lid]) {
      expect(out).not.toContain(raw);
    }
    expect(out.match(/<whatsapp-peer:[0-9a-f]{16}>/g)).toHaveLength(3);

    const sameAgain = redactString(`retry ${direct}`);
    expect(sameAgain.match(/<whatsapp-peer:[0-9a-f]{16}>/)?.[0]).toBe(
      out.match(/<whatsapp-peer:[0-9a-f]{16}>/)?.[0],
    );
    expect(redactString(`other 15550000000@s.whatsapp.net`)).not.toContain(
      out.match(/<whatsapp-peer:[0-9a-f]{16}>/)?.[0],
    );
  });

  it('does not alter Telegram identifiers or ordinary email addresses', () => {
    const clean =
      'telegram=tg:123456789 chat=telegram_main email=person@example.com';
    expect(redactString(clean)).toBe(clean);
  });
});

describe('redactLogObject', () => {
  it('redacts string leaves in a nested object', () => {
    const obj = {
      msg: 'voice saved at /Users/example/groups/x/y.oga',
      meta: {
        path: '/Users/example/secret/file',
        chars: 12,
        ok: true,
      },
      items: ['/Users/example/a', 'plain'],
    };
    const out = redactLogObject(obj) as typeof obj;
    expect(out.msg).not.toContain('/Users/example/');
    expect(out.meta.path).not.toContain('/Users/example/');
    expect(out.meta.chars).toBe(12);
    expect(out.meta.ok).toBe(true);
    expect(out.items[0]).not.toContain('/Users/example/');
    expect(out.items[1]).toBe('plain');
  });

  it('redacts case-insensitive nested credential keys and standalone Bearer values', () => {
    const out = redactLogObject({
      err: {
        config: {
          headers: {
            Authorization: 'Bearer ya29.live-access-token',
            'X-API-Key': 'abc',
          },
        },
        refreshToken: 'tiny',
        message: 'upstream returned Bearer reflected-token',
      },
      inputTokens: 42,
    }) as any;
    expect(out.err.config.headers.Authorization).toBe('<redacted>');
    expect(out.err.config.headers['X-API-Key']).toBe('<redacted>');
    expect(out.err.refreshToken).toBe('<redacted>');
    expect(out.err.message).not.toContain('reflected-token');
    expect(out.inputTokens).toBe(42);
  });

  it('pseudonymizes WhatsApp JIDs in nested metadata and arrays', () => {
    const direct = '15551234567@s.whatsapp.net';
    const group = '120363400001234567-1712345678@g.us';
    const lid = '987654321098765@lid';
    const out = redactLogObject({
      transport: {
        chat: direct,
        routing: { group },
        participants: ['telegram_main', lid],
      },
    });
    const serialized = JSON.stringify(out);

    expect(serialized).not.toContain(direct);
    expect(serialized).not.toContain(group);
    expect(serialized).not.toContain(lid);
    expect(serialized.match(/<whatsapp-peer:[0-9a-f]{16}>/g)).toHaveLength(3);
    expect(serialized).toContain('telegram_main');
  });

  it('preserves sanitized Error diagnostics instead of collapsing err to an empty object', () => {
    const secret = 'ya29.error-token-that-must-not-be-logged';
    const error = Object.assign(
      new Error(`provider failed with Bearer ${secret}`),
      {
        code: 'EPROVIDER',
        refreshToken: secret,
      },
    );

    const out = redactLogObject({ err: error }) as {
      err: Record<string, unknown>;
    };
    const serialized = JSON.stringify(out);

    expect(out.err).toMatchObject({
      type: 'Error',
      message: 'provider failed with Bearer <redacted>',
      code: 'EPROVIDER',
      refreshToken: '<redacted>',
    });
    expect(out.err.stack).toEqual(expect.any(String));
    expect(serialized).not.toContain(secret);
  });

  it('honours depth limit', () => {
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 10; i++) {
      cursor.next = { token: 'bot999:' + 'a'.repeat(40) };
      cursor = cursor.next as Record<string, unknown>;
    }
    // Must not throw; structure preserved.
    const out = redactLogObject(deep, 2);
    expect(out).toBeDefined();
  });

  it('scrubs a string leaf that sits exactly at the depth cutoff (L25)', () => {
    // With maxDepth=1, the string value of `a` is visited with depth=0 (the
    // cutoff). It must still be redacted, not emitted verbatim.
    const token = 'bot999:' + 'a'.repeat(40);
    const out = redactLogObject({ a: token }, 1) as { a: string };
    expect(out.a).not.toContain(token);
    expect(out.a).toContain('bot<redacted>');
  });

  it('scrubs a string leaf reached right at the cutoff in a deeper object (L25)', () => {
    // A string nested inside an array at the cutoff depth must also be
    // scrubbed (the cutoff branch covers any scalar string leaf, not just
    // top-level object fields). Before the fix this returned the raw subtree.
    const token = 'bot999:' + 'b'.repeat(40);
    // maxDepth=2: root obj (2) -> arr (1) -> string element visited at depth 0.
    const out = redactLogObject({ arr: [token] }, 2) as { arr: string[] };
    expect(out.arr[0]).not.toContain(token);
    expect(out.arr[0]).toContain('bot<redacted>');
  });
});

describe('PINO_REDACT_PATHS', () => {
  it('covers the field names secrets are actually stored under (L24)', () => {
    // The secret-bearing config/header objects in this codebase use these
    // field names (model/image gateway apiKey; payment certPass/pass/login;
    // credential-proxy x-api-key). Both bare and wildcard-nested forms.
    for (const field of [
      'apiKey',
      'api_key',
      'certPass',
      'pass',
      'login',
      'secret',
      'webhookSecret',
    ]) {
      expect(PINO_REDACT_PATHS).toContain(field);
      expect(PINO_REDACT_PATHS).toContain(`*.${field}`);
    }
    // Hyphenated header key uses fast-redact bracket notation.
    expect(PINO_REDACT_PATHS).toContain('*["x-api-key"]');
    expect(PINO_REDACT_PATHS).toContain('headers["x-api-key"]');
  });

  it('still retains the original token/header paths', () => {
    for (const p of ['token', '*.token', 'botToken', 'headers.authorization']) {
      expect(PINO_REDACT_PATHS).toContain(p);
    }
  });
});
