import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Updated only with reviewed shipped worker changes, never from a model report.
export const DOCUMENT_WORKER_PINS: Record<string, string> = {
  'document-reader.mjs':
    '7fd3b002bceaef950b42df5ac5934bd29a62ad32cf16cb97e944eb92b659363c',
  'document-renderer.mjs':
    '778ec1f9f58523acba279a82842e9a093c921a142c2aba37349a0455b78cc47c',
  'document-ooxml.py':
    '6d091150badf85a44e19c2fafd230e4d3267498ae5c3fd70f0f7ea35c08fa63a',
};
const hash = (bytes: Buffer | string) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
function inside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function trustedDocumentRuntime(options: {
  scriptsDirectory: string;
  roots: string[];
  pythonCommand: string;
  sofficeCommand?: string;
  needsSpreadsheet: boolean;
}): {
  readerPath: string;
  rendererPath: string;
  pythonCommand: string;
  sofficeCommand?: string;
  fingerprint: string;
} {
  const roots = options.roots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        path.isAbsolute(root) &&
        path.normalize(root) === root
      )
        return root;
      throw error;
    }
  });
  const protectedPath = (filename: string, tree = false): string => {
    const real = fs.realpathSync(filename);
    if (
      roots.some((root) => inside(real, root) || (tree && inside(root, real)))
    )
      throw new Error('untrusted_host_path');
    return real;
  };
  const scripts = protectedPath(options.scriptsDirectory, true);
  const components: Array<[string, string]> = [];
  for (const [name, expected] of Object.entries(DOCUMENT_WORKER_PINS)) {
    const filename = protectedPath(path.join(scripts, name));
    const actual = hash(fs.readFileSync(filename));
    if (actual !== expected) throw new Error('checker_untrusted');
    components.push([name, actual]);
  }
  // Protect the actual host reconciliation code, not merely a script called by
  // it. Source execution is supported for tests; production uses built JS.
  const moduleDirectory = protectedPath(
    path.dirname(fileURLToPath(import.meta.url)),
    true,
  );
  for (const name of [
    'document-evidence',
    'document-reconciliation',
    'document-render',
    'document-trust',
    'artifact-acceptance',
  ]) {
    const compiled = path.join(moduleDirectory, `${name}.js`);
    const filename = protectedPath(
      fs.existsSync(compiled)
        ? compiled
        : path.join(moduleDirectory, `${name}.ts`),
    );
    components.push([name, hash(fs.readFileSync(filename))]);
  }
  for (const dependency of ['pdf-parse', 'read-excel-file/node']) {
    const entry = protectedPath(
      createRequire(path.join(scripts, 'document-reader.mjs')).resolve(
        dependency,
      ),
    );
    let installation = path.dirname(entry);
    while (
      path.basename(installation) !== 'node_modules' &&
      path.dirname(installation) !== installation
    )
      installation = path.dirname(installation);
    if (path.basename(installation) !== 'node_modules')
      throw new Error('untrusted_host_path');
    protectedPath(installation, true);
    components.push([dependency, hash(fs.readFileSync(entry))]);
  }
  protectedPath(process.execPath);
  const pythonCommand = protectedPath(options.pythonCommand);
  let sofficeCommand: string | undefined;
  if (options.needsSpreadsheet) {
    if (!options.sofficeCommand || !path.isAbsolute(options.sofficeCommand))
      throw new Error('environment_unavailable');
    sofficeCommand = protectedPath(options.sofficeCommand);
    // A wrapper can delegate to a writable executable. Trusted receipt mode
    // requires the actual native installation; diagnostics permit wrappers.
    const fd = fs.openSync(sofficeCommand, 'r');
    const magic = Buffer.alloc(2);
    try {
      fs.readSync(fd, magic, 0, 2, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (magic.toString() === '#!') throw new Error('environment_unavailable');
    let installation = path.dirname(sofficeCommand);
    if (sofficeCommand.includes('.app/'))
      installation = sofficeCommand.slice(
        0,
        sofficeCommand.indexOf('.app/') + 4,
      );
    protectedPath(installation, true);
    components.push(['soffice', hash(fs.readFileSync(sofficeCommand))]);
  }
  return {
    readerPath: path.join(scripts, 'document-reader.mjs'),
    rendererPath: path.join(scripts, 'document-renderer.mjs'),
    pythonCommand,
    sofficeCommand,
    fingerprint: hash(JSON.stringify(components)),
  };
}
