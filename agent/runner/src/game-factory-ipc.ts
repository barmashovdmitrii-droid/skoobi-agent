import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'crypto';
import fs from 'fs';
import path from 'path';

function key(secret: Buffer, purpose: 'request' | 'response'): Buffer {
  return createHmac('sha256', secret)
    .update(`skoobi.game_factory.${purpose}.key.v1`)
    .digest();
}
function aad(
  purpose: 'request' | 'response',
  id: string,
  capabilityId: string,
  group: string,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      `skoobi.game_factory.${purpose}.v1`,
      id,
      capabilityId,
      group,
    ]),
  );
}

/** A private host RPC, without credentials or model-supplied actor identity. */
export async function requestHostGameFactory(input: {
  capability: string;
  groupFolder: string;
  ipcDirectory: string;
  mode: 'status' | 'control';
  payload: unknown;
  timeoutMs?: number;
}): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const fail = (error: string) => ({
    content: [{ type: 'text' as const, text: error }],
    isError: true,
  });
  const parts = input.capability.split('.');
  if (
    parts.length !== 2 ||
    !/^[A-Za-z0-9_-]{32}$/.test(parts[0]) ||
    !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
  )
    return fail('Game factory requires an authorized direct-message run.');
  const secret = Buffer.from(parts[1], 'base64url');
  const id = randomUUID();
  const requestPath = path.join(input.ipcDirectory, `${id}.request.json`);
  const tempPath = `${requestPath}.${process.pid}.tmp`;
  const resultPath = path.join(input.ipcDirectory, `${id}.result.json`);
  let plaintext: Buffer | undefined;
  try {
    plaintext = Buffer.from(
      JSON.stringify({ mode: input.mode, payload: input.payload }),
    );
    if (plaintext.length > 128 * 1024)
      return fail('Game factory request is too large.');
    const requestKey = key(secret, 'request');
    let sealed: Record<string, unknown>;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', requestKey, iv);
      cipher.setAAD(aad('request', id, parts[0], input.groupFolder));
      sealed = {
        type: 'game_factory',
        request_id: id,
        capability_id: parts[0],
        sealed_payload: {
          v: 1,
          iv: iv.toString('base64url'),
          ciphertext: Buffer.concat([
            cipher.update(plaintext),
            cipher.final(),
          ]).toString('base64url'),
          tag: cipher.getAuthTag().toString('base64url'),
        },
      };
    } finally {
      requestKey.fill(0);
      plaintext.fill(0);
    }
    fs.mkdirSync(input.ipcDirectory, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(sealed), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(tempPath, requestPath);
    const deadline =
      Date.now() + Math.min(30_000, Math.max(1, input.timeoutMs ?? 8000));
    while (Date.now() < deadline) {
      let fd: number;
      try {
        fd = fs.openSync(
          resultPath,
          fs.constants.O_RDONLY |
            fs.constants.O_NOFOLLOW |
            fs.constants.O_NONBLOCK,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          return fail('Unsafe game factory response.');
        await new Promise((resolve) => setTimeout(resolve, 40));
        continue;
      }
      let raw: Record<string, unknown>;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 200_000)
          return fail('Unsafe game factory response.');
        const buffer = Buffer.alloc(200_001);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (count > 200_000) return fail('Oversized game factory response.');
        raw = JSON.parse(buffer.subarray(0, count).toString('utf8')) as Record<
          string,
          unknown
        >;
      } finally {
        fs.closeSync(fd);
      }
      const body = raw?.sealed_payload as Record<string, unknown> | undefined;
      if (
        raw.type !== 'game_factory_result' ||
        raw.request_id !== id ||
        raw.capability_id !== parts[0] ||
        !body ||
        body.v !== 1 ||
        typeof body.iv !== 'string' ||
        !/^[A-Za-z0-9_-]{16}$/.test(body.iv) ||
        typeof body.tag !== 'string' ||
        !/^[A-Za-z0-9_-]{22}$/.test(body.tag) ||
        typeof body.ciphertext !== 'string' ||
        !/^[A-Za-z0-9_-]+$/.test(body.ciphertext)
      )
        return fail(
          'Unauthenticated game factory response; inspect or retry with the same operationId.',
        );
      const responseKey = key(secret, 'response');
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          responseKey,
          Buffer.from(body.iv, 'base64url'),
        );
        decipher.setAAD(aad('response', id, parts[0], input.groupFolder));
        decipher.setAuthTag(Buffer.from(body.tag, 'base64url'));
        plaintext = Buffer.concat([
          decipher.update(Buffer.from(body.ciphertext, 'base64url')),
          decipher.final(),
        ]);
        if (plaintext.length > 128 * 1024)
          return fail('Oversized game factory result.');
        const result = JSON.parse(plaintext.toString('utf8')) as {
          ok?: unknown;
          data?: unknown;
        };
        if (typeof result.ok !== 'boolean')
          return fail('Invalid game factory result.');
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          ...(!result.ok ? { isError: true } : {}),
        };
      } finally {
        responseKey.fill(0);
        plaintext?.fill(0);
      }
    }
    return fail(
      'Game factory request timed out; execution may still be in progress. Inspect or retry with the same operationId before starting another mutation.',
    );
  } catch {
    return fail(
      'Game factory transport failed; inspect or retry with the same operationId.',
    );
  } finally {
    secret.fill(0);
    plaintext?.fill(0);
    for (const file of [tempPath, requestPath, resultPath]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* Late results stay sealed to this run. */
      }
    }
  }
}
