/**
 * Telegram photo download → saves to group folder so agent can Read it.
 * Claude has native vision — once the file path is in the prompt, Read tool sees it.
 */

import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import https from 'https';

import { logger } from '@skoobi/shared/logger';
import { resolveGroupFolderPath } from '@skoobi/shared/group-folder';

// A hung Telegram CDN socket (half-open, no FIN/RST) would otherwise stall the
// awaiting grammY handler forever, freezing the bot's whole sequential update
// loop for every tenant. Cap each connect/read phase so a single flaky transfer
// can never become a full-bot outage. (finding #9)
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 30_000;
const TELEGRAM_METADATA_TIMEOUT_MS = 15_000;

function downloadUrl(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let settled = false;

    // Unlink the (already-created) partial/0-byte dest before rejecting so
    // failed downloads don't litter the group's received/ dir, mirroring the
    // document/video helpers. (findings #31, #70)
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      file.destroy();
      void fs.unlink(dest).catch(() => {});
      reject(err);
    };

    const req = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume(); // drain so the socket can be freed
        fail(new Error(`HTTP ${response.statusCode} downloading ${url}`));
        return;
      }
      // pipe() does NOT forward source-stream errors to the destination, so a
      // mid-download TCP reset / premature close emits 'error' on `response`
      // with no listener -> uncaughtException -> the host's global handler
      // process.exit(1)s the whole orchestrator. Listen here. (finding #31)
      response.on('error', fail);
      // Inactivity timeout on the body stream: if bytes stop flowing on a
      // half-open socket the request-level timer above may not fire. (finding #9)
      response.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error(`timeout downloading ${url}`));
      });
      response.pipe(file);
      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(() => resolve());
      });
      file.on('error', fail);
    });

    // Connect/idle-socket timeout: destroy() makes req emit 'error'. (finding #9)
    req.setTimeout(TELEGRAM_DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`timeout downloading ${url}`));
    });
    req.on('error', fail);
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
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      const req = https.get(infoUrl, (res) => {
        // Listen for body-stream errors and bound the read so a hung getFile
        // can't stall the bot's update loop. (findings #9, #31)
        res.on('error', fail);
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e as Error);
          }
        });
      });
      req.setTimeout(TELEGRAM_METADATA_TIMEOUT_MS, () => {
        req.destroy(new Error(`timeout fetching ${infoUrl}`));
      });
      req.on('error', fail);
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
    logger.info(
      { fileId, dest, bytes: stat.size },
      'Saved Telegram photo',
    );
    return dest;
  } catch (err) {
    logger.error({ err, fileId }, 'Telegram photo download failed');
    return null;
  }
}
