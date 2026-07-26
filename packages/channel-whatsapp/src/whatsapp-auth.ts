/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Run from the INSTANCE directory (store/auth lands in cwd):
 *   npm run auth:whatsapp
 *   npm run auth:whatsapp -- --pairing-code --phone 7702…
 */
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import readline from 'readline';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { secureAuthDirectory, writePrivateFile } from './auth-storage.js';
import { installBaileysConsolePrivacyGuard } from './baileys-log-privacy.js';
import {
  AuthReconnectGate,
  CredentialSaveBarrier,
} from './whatsapp-auth-flow.js';
import { STORE_DIR } from './channel-config.js';

installBaileysConsolePrivacyGuard();

const AUTH_DIR = path.join(STORE_DIR, 'auth');
const QR_FILE = path.join(STORE_DIR, 'qr-data.txt');
const STATUS_FILE = path.join(STORE_DIR, 'auth-status.txt');

const logger = pino({
  // Baileys may attach authenticated PN/LID metadata even to transport logs.
  // The interactive CLI prints only its own fixed status messages instead.
  level: 'silent',
});
const reconnectGate = new AuthReconnectGate();

// Check for --pairing-code flag and phone number
const usePairingCode = process.argv.includes('--pairing-code');
const phoneArg = process.argv.find((_, i, arr) => arr[i - 1] === '--phone');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function connectSocket(
  phoneNumber?: string,
  isReconnect = false,
): Promise<void> {
  const socketGeneration = reconnectGate.beginSocket();
  const isCurrentSocket = (): boolean =>
    reconnectGate.isCurrent(socketGeneration);
  secureAuthDirectory(AUTH_DIR);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered && !isReconnect) {
    writePrivateFile(STATUS_FILE, 'already_authenticated');
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    process.exit(0);
  }

  const { version } = await fetchLatestWaWebVersion({}).catch(() => {
    logger.warn('Failed to fetch latest WA Web version, using default');
    return { version: undefined };
  });
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Clawdio'),
  });
  const credentialSaves = new CredentialSaveBarrier();
  let connectionClosed = false;
  let completionStarted = false;
  const saveCredentialsDurably = (): Promise<void> => {
    const attempt = credentialSaves.enqueue(async () => {
      await saveCreds();
      secureAuthDirectory(AUTH_DIR);
    });
    void attempt.catch(() => {
      console.error('Failed to save WhatsApp credentials securely.');
    });
    return attempt;
  };

  if (usePairingCode && phoneNumber && !state.creds.me) {
    // Request pairing code after a short delay for connection to initialize
    // Only on first connect (not reconnect after 515)
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber!);
        console.log(`\n🔗 Your pairing code: ${code}\n`);
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter this code: ${code}\n`);
        // The pairing code is intentionally shown only in this interactive
        // terminal. Never persist it to a status/log file.
        writePrivateFile(STATUS_FILE, 'pairing_code_ready');
      } catch {
        console.error('Failed to request pairing code.');
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    if (!isCurrentSocket()) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Write raw QR data to file so the setup skill can render it
      writePrivateFile(QR_FILE, qr);
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      if (connectionClosed || completionStarted) return;
      connectionClosed = true;
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        writePrivateFile(STATUS_FILE, 'failed:logged_out');
        console.log('\n✗ Logged out. Delete store/auth and try again.');
        process.exit(1);
      } else if (reason === DisconnectReason.timedOut) {
        writePrivateFile(STATUS_FILE, 'failed:qr_timeout');
        console.log('\n✗ QR code timed out. Please try again.');
        process.exit(1);
      } else if (reason === 515) {
        // 515 = stream error, often happens after pairing succeeds but before
        // registration completes. The next auth state must never be opened
        // before all credential writes accumulated by this socket are durable.
        console.log('\n⟳ Stream error (515) after pairing — reconnecting...');
        void reconnectGate
          .reconnectAfterCredentialSave(
            socketGeneration,
            () => credentialSaves.drain(),
            () => connectSocket(phoneNumber, true),
          )
          .catch(() => {
            writePrivateFile(STATUS_FILE, 'failed:credential_save');
            console.error(
              'WhatsApp credentials were not saved; reconnect cancelled.',
            );
            process.exit(1);
          });
      } else {
        writePrivateFile(STATUS_FILE, `failed:${reason || 'unknown'}`);
        console.log('\n✗ Connection failed. Please try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      if (connectionClosed || completionStarted) return;
      completionStarted = true;
      void (async () => {
        try {
          // Do not report success or exit until the final credential snapshot
          // and its permissions are durably written.
          await saveCredentialsDurably();
          await credentialSaves.drain();
          writePrivateFile(STATUS_FILE, 'authenticated');
          try {
            fs.unlinkSync(QR_FILE);
          } catch {}
          console.log('\n✓ Successfully authenticated with WhatsApp!');
          console.log('  Credentials saved to store/auth/');
          console.log('  You can now start the Skoobi service.\n');
          process.exit(0);
        } catch {
          writePrivateFile(STATUS_FILE, 'failed:credential_save');
          console.error('WhatsApp connected, but credentials were not saved.');
          process.exit(1);
        }
      })();
    }
  });

  sock.ev.on('creds.update', () => {
    if (!isCurrentSocket() || connectionClosed || completionStarted) return;
    void saveCredentialsDurably().catch(() => undefined);
  });
}

async function authenticate(): Promise<void> {
  secureAuthDirectory(AUTH_DIR);

  // Clean up any stale QR/status files from previous runs
  try {
    fs.unlinkSync(QR_FILE);
  } catch {}
  try {
    fs.unlinkSync(STATUS_FILE);
  } catch {}

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter your phone number (with country code, no + or spaces, e.g. 14155551234): ',
    );
  }

  console.log('Starting WhatsApp authentication...\n');

  await connectSocket(phoneNumber);
}

authenticate().catch(() => {
  console.error('Authentication failed.');
  process.exit(1);
});
