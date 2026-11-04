import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** A versioned code tree must never become the helper's private state root. */
export function resolveHelperInstancePaths(moduleUrl, explicitEnvFile) {
  const codeRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
  if (explicitEnvFile === undefined) {
    return {projectRoot: codeRoot, envFile: path.join(codeRoot, '.env'),
      logFile: path.join(codeRoot, 'logs', 'skoobi-helper.log')};
  }
  if (typeof explicitEnvFile !== 'string' || !path.isAbsolute(explicitEnvFile) ||
      path.normalize(explicitEnvFile) !== explicitEnvFile || /[\0\r\n]/.test(explicitEnvFile)) {
    throw new Error('Invalid explicit helper environment path');
  }
  const projectRoot = path.dirname(explicitEnvFile);
  const directory = fs.lstatSync(projectRoot);
  const file = fs.lstatSync(explicitEnvFile);
  const uid = process.getuid?.();
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      fs.realpathSync(projectRoot) !== projectRoot || directory.mode & 0o022 ||
      (uid !== undefined && directory.uid !== uid) ||
      !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.mode & 0o077 ||
      (uid !== undefined && file.uid !== uid)) {
    throw new Error('Unsafe explicit helper environment path');
  }
  return {projectRoot, envFile: explicitEnvFile,
    logFile: path.join(projectRoot, 'logs', 'skoobi-helper.log')};
}
