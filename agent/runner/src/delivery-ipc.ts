import fs from 'node:fs';
import path from 'node:path';

/** Bounded receipt wait. A timeout is pending, never a channel ACK. */
export async function waitForDeliveryReceipt(input: {
  directory: string;
  requestId: string;
  deliveryId: string;
  timeoutMs?: number;
  kind?: 'delivery' | 'voice';
}): Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}> {
  const valid = (v: string) =>
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v);
  if (!valid(input.requestId) || !valid(input.deliveryId))
    throw new Error('invalid_delivery_id');
  const voice = input.kind === 'voice',
    idKey = voice ? 'assetId' : 'deliveryId';
  const filename = path.join(
    input.directory,
    `${input.requestId}.${voice ? 'voice' : 'delivery'}.json`,
  );
  const until =
    Date.now() + Math.min(35_000, Math.max(0, input.timeoutMs ?? 35_000));
  while (true) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        filename,
        fs.constants.O_RDONLY |
          fs.constants.O_NOFOLLOW |
          fs.constants.O_NONBLOCK,
      );
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 16_384 ||
        stat.size < 2
      )
        throw new Error('unsafe_receipt');
      const bytes = Buffer.alloc(stat.size);
      const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(fd);
      if (
        n !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs
      )
        throw new Error('receipt_changed');
      const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      if (
        !(
          voice
            ? ['generating', 'ready', 'unknown', 'expired']
            : ['checking', 'sending', 'delivered', 'blocked', 'unknown']
        ).includes(String(raw.state)) ||
        !valid(String(raw[idKey])) ||
        typeof raw.code !== 'string' ||
        !/^[a-z0-9_]{1,100}$/.test(raw.code)
      )
        throw new Error('invalid_receipt');
      // Explicit allowlist: no channel error, host paths, or arbitrary metadata.
      const result: Record<string, unknown> = {
        [idKey]: raw[idKey],
        state: raw.state,
        code: raw.code,
      };
      if (voice) {
        if (
          typeof raw.durationSeconds === 'number' &&
          Number.isFinite(raw.durationSeconds)
        )
          result.durationSeconds = raw.durationSeconds;
        if (
          typeof raw.textSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(raw.textSha256)
        )
          result.textSha256 = raw.textSha256;
        if (
          typeof raw.expiresAt === 'string' &&
          Number.isFinite(Date.parse(raw.expiresAt))
        )
          result.expiresAt = raw.expiresAt;
        for (const field of [
          'configuredProvider',
          'configuredVoice',
          'derivation',
        ])
          if (typeof raw[field] === 'string')
            result[field] = (raw[field] as string).slice(0, 160);
        if (Array.isArray(raw.files) && raw.files.length <= 24)
          result.files = raw.files
            .filter(
              (f) =>
                f &&
                ['ogg', 'mp3', 'wav'].includes(f.format) &&
                Number.isInteger(f.part) &&
                f.part >= 1 &&
                f.part <= 8 &&
                f.name === `part-${f.part}.${f.format}` &&
                /^[a-f0-9]{64}$/.test(f.sha256) &&
                Number.isSafeInteger(f.bytes),
            )
            .map((f) => ({
              part: f.part,
              format: f.format,
              name: f.name,
              bytes: f.bytes,
              sha256: f.sha256,
            }));
        if (Array.isArray(raw.localFiles) && raw.localFiles.length <= 24)
          result.localFiles = raw.localFiles
            .filter(
              (f) =>
                f &&
                ['ogg', 'mp3', 'wav'].includes(f.format) &&
                Number.isInteger(f.part) &&
                f.part >= 1 &&
                f.part <= 8 &&
                typeof f.path === 'string' &&
                path.isAbsolute(f.path) &&
                !f.path.includes('\0'),
            )
            .map((f) => ({ part: f.part, format: f.format, path: f.path }));
      }
      if (
        typeof raw.acknowledgedAt === 'string' &&
        Number.isFinite(Date.parse(raw.acknowledgedAt))
      )
        result.acknowledgedAt = raw.acknowledgedAt;
      const binding = raw.voiceAsset as Record<string, unknown> | undefined;
      if (
        binding &&
        valid(String(binding.assetId)) &&
        Number.isInteger(binding.part) &&
        Number.isInteger(binding.totalParts) &&
        Number(binding.part) >= 1 &&
        Number(binding.part) <= Number(binding.totalParts) &&
        Number(binding.totalParts) <= 8
      )
        result.voiceAsset = {
          assetId: binding.assetId,
          part: binding.part,
          totalParts: binding.totalParts,
        };
      const artifact = raw.artifact as Record<string, unknown> | undefined;
      if (
        artifact &&
        typeof artifact.name === 'string' &&
        !/[\\/\0]/.test(artifact.name) &&
        artifact.name.length <= 255 &&
        /^[a-f0-9]{64}$/.test(String(artifact.sha256)) &&
        Number.isSafeInteger(artifact.bytes)
      )
        result.artifact = {
          name: artifact.name,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
        };
      fs.unlinkSync(filename);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        ...(['blocked', 'unknown', 'expired'].includes(String(raw.state))
          ? { isError: true }
          : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                [idKey]: input.deliveryId,
                state: 'unknown',
                code: 'receipt_unavailable_query_status',
              }),
            },
          ],
          isError: true,
        };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (Date.now() >= until)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              [idKey]: input.deliveryId,
              state: voice ? 'generating' : 'checking',
              code: voice
                ? 'pending_query_voice_audio_status'
                : 'pending_query_delivery_status',
            }),
          },
        ],
      };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))),
    );
  }
}
