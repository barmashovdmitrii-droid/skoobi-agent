import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { snapshotDocument } from './document-evidence.js';

export interface DocumentRenderResult {
  status: 'rendered' | 'incomplete';
  inputSha256: string;
  pdfSha256?: string;
  renderer?: string;
  pages: Array<{
    page: number;
    width: number;
    height: number;
    sha256: string;
    file: string;
  }>;
  text?: string;
  code?: string;
}

export async function renderCalculationDocument(options: {
  filename: string;
  expectedSha256: string;
  outputDirectory: string;
  rendererPath: string;
  sofficeCommand?: string;
  pythonCommand?: string;
}): Promise<DocumentRenderResult> {
  let created = false;
  try {
    const { snapshot, bytes } = snapshotDocument(options.filename);
    if (snapshot.sha256 !== options.expectedSha256) throw new Error('changed');
    const format = path.extname(options.filename).slice(1).toLowerCase();
    if (!['pdf', 'xlsx'].includes(format)) throw new Error('format');
    fs.mkdirSync(options.outputDirectory, { mode: 0o700 });
    created = true;
    const result = await new Promise<DocumentRenderResult>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--max-old-space-size=256',
            options.rendererPath,
            format,
            path.resolve(options.outputDirectory),
            options.sofficeCommand || 'soffice',
            options.pythonCommand || 'python3',
          ],
          {
            stdio: ['pipe', 'pipe', 'ignore'],
            detached: process.platform !== 'win32',
            env: { PATH: process.env.PATH || '' },
          },
        );
        const stop = () => {
          try {
            if (process.platform !== 'win32' && child.pid)
              process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {}
        };
        const timer = setTimeout(stop, 45_000);
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) stop();
          else chunks.push(chunk);
        });
        child.stdin.on('error', () => {});
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          stop(); // Clean up any viewer descendant left in this private group.
          if (code !== 0) return reject(new Error('render_failed'));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            reject(new Error('render_failed'));
          }
        });
        child.stdin.end(bytes);
      },
    );
    if (
      result.status !== 'rendered' ||
      result.inputSha256 !== snapshot.sha256 ||
      snapshotDocument(options.filename).snapshot.sha256 !== snapshot.sha256
    )
      throw new Error('changed');
    return result;
  } catch {
    if (created)
      fs.rmSync(options.outputDirectory, { recursive: true, force: true });
    return {
      status: 'incomplete',
      inputSha256: options.expectedSha256,
      pages: [],
      code: 'render_unavailable_or_incomplete',
    };
  }
}
