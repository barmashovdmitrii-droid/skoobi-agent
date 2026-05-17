/**
 * Telegram audio/voice download → saves to group folder so agent can Read it.
 * Mirrors photo-telegram.ts. Used for both `message:voice` and `message:audio`.
 */

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import https from 'https';

import { logger } from './orchestrator/logger.js';
import { resolveGroupFolderPath } from './orchestrator/group-folder.js';
import { basenameOnly } from './lib/log-sanitize.js';

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Downloads a Telegram voice/audio file to <group>/received/<timestamp>-<kind>-<fileId>.<ext>.
 * Returns the absolute host path the agent can Read, or null on error.
 *
 * @param kind "voice" for OGG opus voice notes, "audio" for music/audio messages
 */
export async function downloadTelegramAudio(
  botToken: string,
  fileId: string,
  groupFolder: string,
  kind: 'voice' | 'audio' = 'voice',
): Promise<string | null> {
  try {
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`;
    const fileInfo = await new Promise<any>((resolve, reject) => {
      https
        .get(infoUrl, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    });

    if (!fileInfo.ok || !fileInfo.result?.file_path) {
      logger.warn({ fileId, fileInfo }, 'Failed to get Telegram audio info');
      return null;
    }

    const groupDir = resolveGroupFolderPath(groupFolder);
    const receivedDir = path.join(groupDir, 'received');
    await fs.mkdir(receivedDir, { recursive: true });

    const remotePath = String(fileInfo.result.file_path);
    let ext = path.extname(remotePath);
    if (!ext) ext = kind === 'voice' ? '.oga' : '.mp3';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(
      receivedDir,
      `${ts}-${kind}-${fileId.slice(-8)}${ext}`,
    );

    const dlUrl = `https://api.telegram.org/file/bot${botToken}/${remotePath}`;
    await downloadUrl(dlUrl, dest);

    const stat = await fs.stat(dest);
    logger.info(
      { fileId, destBasename: basenameOnly(dest), kind, bytes: stat.size },
      'Saved Telegram audio',
    );
    return dest;
  } catch (err) {
    logger.error({ err, fileId, kind }, 'Telegram audio download failed');
    return null;
  }
}
