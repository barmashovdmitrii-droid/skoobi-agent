import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function buildExtensions({
  root = process.cwd(),
  compile = (directory) => spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--project', 'tsconfig.json'], { cwd: directory, stdio: 'inherit' }),
  report = console.error,
} = {}) {
  const extensions = path.join(root, 'extensions');
  if (!fs.existsSync(extensions)) return 0;
  for (const entry of fs.readdirSync(extensions, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !entry.name.startsWith('claudeclaw-')) continue;
    const directory = path.join(extensions, entry.name);
    if (!fs.existsSync(path.join(directory, 'tsconfig.json'))) continue;
    try {
      const result = compile(directory);
      if (result.error || result.status !== 0) {
        report(`Extension build failed: ${entry.name}`);
        return 1;
      }
    } catch {
      report(`Extension compiler could not start: ${entry.name}`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = buildExtensions();
}
