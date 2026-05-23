/**
 * Telegram photo download → saves to group folder so agent can Read it.
 * Claude has native vision — once the file path is in the prompt, Read tool sees it.
 */

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import https from 'https';

import { logger } from './orchestrator/logger.js';
import { resolveGroupFolderPath } from './orchestrator/group-folder.js';

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
 * Downloads a Telegram photo to <group>/received/<timestamp>-<fileId>.jpg.
 * Returns the absolute host path agent can Read, or null on error.
 */
export async function downloadTelegramPhoto(
  botToken: string,
  fileId: string,
  groupFolder: string,
): Promise<string | null> {
  try {
    // Step 1: getFile metadata
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
      logger.warn({ fileId, fileInfo }, 'Failed to get Telegram photo info');
      return null;
    }

    // Step 2: save to group's received/ dir with sensible filename
    const groupDir = resolveGroupFolderPath(groupFolder);
    const receivedDir = path.join(groupDir, 'received');
    await fs.mkdir(receivedDir, { recursive: true });

    const ext = path.extname(fileInfo.result.file_path) || '.jpg';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(receivedDir, `${ts}-${fileId.slice(-8)}${ext}`);

    const dlUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.result.file_path}`;
    await downloadUrl(dlUrl, dest);

    const stat = await fs.stat(dest);
    logger.info({ fileId, dest, bytes: stat.size }, 'Saved Telegram photo');
    return dest;
  } catch (err) {
    logger.error({ err, fileId }, 'Telegram photo download failed');
    return null;
  }
}
