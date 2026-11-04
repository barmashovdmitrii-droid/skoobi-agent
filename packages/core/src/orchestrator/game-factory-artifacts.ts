import { spawn, spawnSync } from 'child_process';
import path from 'path';

import type { FactoryFile } from './game-factory-contracts.js';

export interface FactoryManifestLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  maxEntries?: number;
}

export interface CaptureFactoryManifestInput {
  sourceRoot: string;
  /** Portable, relative path within the explicitly selected source subtree. */
  entrypoint: string;
  /** Canonical host roots, never an allowlist supplied by an agent/IPC caller. */
  allowedRoots: string[];
  limits?: FactoryManifestLimits;
}

export interface FactoryManifest {
  readonly sourceRoot: string;
  readonly entrypoint: string;
  readonly files: FactoryFile[];
  readonly manifestSha256: string;
  readonly totalBytes: number;
}

export interface ImportFactorySourceInput extends CaptureFactoryManifestInput {
  /** Host-selected destination; its canonical existing parent must be owned and 0700. */
  destinationRoot: string;
}

export interface EnsureFactoryPrivateDirectoryInput {
  /** Existing canonical host root, owned and not writable by another user. */
  root: string;
  relativePath: string;
}

export interface FactoryFilesystemHelperOptions {
  /** Host deadline, may only reduce the 60-second cap. */
  timeoutMs?: number;
}

export interface BundleFactorySourceInput extends CaptureFactoryManifestInput {
  expectedManifestSha256: string;
  /** Compressed bytes; at most 4 MiB to leave room in the peer input envelope. */
  maxBytes?: number;
}

export interface FactorySourceBundle {
  name: 'source.zip';
  sha256: string;
  data: string;
  bytes: number;
  manifestSha256: string;
}

export interface ArchiveFactoryBuildInput extends CaptureFactoryManifestInput {
  expectedManifestSha256: string;
  /** Host-selected file inside an existing private directory. Never overwritten. */
  destinationFile: string;
  maxBytes?: number;
}

export interface FactoryBuildArchive {
  path: string;
  sha256: string;
  bytes: number;
  manifestSha256: string;
}

export interface ImportFactoryFileInput {
  sourceFile: string;
  allowedRoot: string;
  destinationRoot: string;
  maxBytes?: number;
}

const DEFAULT_LIMITS = {
  maxFiles: 4096,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  maxDepth: 24,
  maxEntries: 8192,
};
const HARD_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxDepth: 64,
  maxEntries: 20_000,
};

/*
 * Node's pathname-based safe-file-read helper protects the final component,
 * but cannot open children relative to an already-open directory. This fixed
 * stdlib helper uses openat/dir_fd throughout, including publication/cleanup.
 * It never executes imported code, a shell, build scripts, or network calls.
 */
const FILESYSTEM_HELPER = String.raw`
import base64, ctypes, errno, hashlib, io, json, os, secrets, signal, stat, sys, zipfile

def deadline_signal(signum, frame):
    raise TimeoutError('Factory filesystem deadline exceeded')

signal.signal(signal.SIGTERM, deadline_signal)

q = json.load(sys.stdin)
limits = q['limits']
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
BLOCKED_DIRS = {'node_modules', 'logs', 'log', 'store', 'state', 'sessions',
    'session', 'memory', 'conversations', 'credentials', 'secrets', 'auth',
    'ipc', 'cache', 'archives', 'archive', 'backups', 'backup', 'coverage'}
ALLOWED_EXTENSIONS = {'.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx',
    '.jsx', '.css', '.json', '.webmanifest', '.wasm', '.png', '.jpg', '.jpeg',
    '.webp', '.avif', '.gif', '.svg', '.ico', '.bmp', '.ktx', '.ktx2', '.basis',
    '.mp3', '.ogg', '.oga', '.opus', '.wav', '.m4a', '.aac', '.flac', '.mp4',
    '.webm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.glb', '.gltf', '.obj',
    '.mtl', '.bin', '.atlas', '.tmx', '.xml', '.csv', '.frag', '.vert', '.glsl',
    '.wgsl', '.fnt'}
PUBLIC_NOTICES = {'license', 'licence', 'notice', 'credits', 'attribution', 'ofl', 'ofl.txt',
    'license.txt', 'licence.txt', 'notice.txt', 'credits.txt', 'attribution.txt',
    'license.md', 'licence.md', 'notice.md', 'credits.md', 'attribution.md'}
PRIVATE_NAMES = {'package-lock.json', 'npm-shrinkwrap.json', 'auth.json',
    'credentials.json', 'secrets.json', 'tokens.json', 'config.local.json'}

def fail(message):
    raise ValueError(message)

def identity(s):
    return (s.st_dev, s.st_ino)

def stable(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid, s.st_size,
        s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)

def within(child, parent):
    return os.path.commonpath([child, parent]) == parent

def safe_name(name):
    return name not in ('', '.', '..') and '/' not in name and '\\' not in name and '\0' not in name and len(name.encode('utf-8')) <= 255

def excluded_name(name):
    low = name.lower()
    return low.startswith('.') or low in BLOCKED_DIRS or low in PRIVATE_NAMES or low.startswith(('credentials.', 'secrets.', 'tokens.', 'auth.', 'id_rsa', 'id_ed25519')) or low.endswith(('.private.json', '.private.txt', '.private.md'))

def allowed_file(name):
    low = name.lower()
    extension = os.path.splitext(low)[1]
    public_notice = low in PUBLIC_NOTICES or (low.startswith(('ofl-', 'license-', 'licence-', 'notice-', 'credits-', 'attribution-')) and extension in ('.txt', '.md'))
    return not excluded_name(name) and (extension in ALLOWED_EXTENSIONS or public_notice)

def bounded_names(fd, remaining):
    names = []
    with os.scandir(fd) as iterator:
        for entry in iterator:
            if len(names) >= remaining: fail('Source exceeds entry limit')
            names.append(entry.name)
    return sorted(names)

def open_absolute_directory(name):
    # All descriptors remain open until the operation ends. Ancestor renames
    # cannot redirect traversal; verify_bindings also rejects a stale pathname.
    chain = []
    fd = os.open('/', DIR_FLAGS)
    chain.append((None, '', fd, os.fstat(fd)))
    try:
        for part in name.split('/')[1:]:
            if not safe_name(part): fail('Invalid directory path')
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            chain.append((fd, part, child, os.fstat(child)))
            fd = child
        return fd, chain
    except BaseException:
        close_chain(chain)
        raise

def verify_bindings(chain):
    for parent, name, fd, original in chain:
        if identity(os.fstat(fd)) != identity(original): fail('Directory changed during operation')
        if parent is not None and identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(original):
            fail('Directory pathname changed during operation')

def close_chain(chain):
    for _, _, fd, _ in reversed(chain): os.close(fd)

def resolve_source():
    source = os.path.abspath(q['sourceRoot'])
    for configured in q['allowedRoots']:
        anchor = os.path.abspath(configured)
        canonical = os.path.realpath(anchor)
        if canonical == '/': fail('Filesystem root is not a source allowlist')
        if canonical != anchor: fail('Allowed roots must be canonical without symlinks')
        match = anchor if within(source, anchor) else canonical if within(source, canonical) else None
        if match is None: continue
        rel = os.path.relpath(source, match)
        parts = [] if rel == '.' else rel.split(os.sep)
        # Block selecting a private/runtime subtree itself, not just its files.
        if any(excluded_name(part) for part in canonical.split('/')[1:] + parts):
            fail('Private or runtime source paths are excluded')
        fd, chain = open_absolute_directory(canonical)
        try:
            for part in parts:
                if not safe_name(part): fail('Invalid source path')
                child = os.open(part, DIR_FLAGS, dir_fd=fd)
                chain.append((fd, part, child, os.fstat(child)))
                fd = child
            return os.path.join(canonical, *parts), fd, chain
        except BaseException:
            close_chain(chain)
            raise
    fail('Source is outside configured allowed roots')

def read_stable_file(parent, name, expected):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or stable(before) != stable(expected):
            fail('Unsafe or changed source file')
        if before.st_size > limits['maxFileBytes']: fail('File exceeds byte limit')
        chunks, remaining = [], before.st_size
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk: fail('File changed while being read')
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(fd, 1) or stable(os.fstat(fd)) != stable(before): fail('File changed while being read')
        if stable(os.stat(name, dir_fd=parent, follow_symlinks=False)) != stable(before): fail('File pathname changed while being read')
        return b''.join(chunks)
    finally:
        os.close(fd)

def write_file(parent, name, data):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0: fail('Incomplete private copy')
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)

def capture(root, root_fd, copy_fd=None, strict=False, archive=None):
    files, observed, total, entries = [], {}, 0, 0
    def walk(fd, prefix, depth, target):
        nonlocal total, entries
        if depth > limits['maxDepth']: fail('Source exceeds depth limit')
        before = os.fstat(fd)
        if strict and (before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) & 0o077): fail('Destination directory is not private')
        names = [q['entrypoint']] if q.get('singleFile') and not strict and not prefix else bounded_names(fd, limits['maxEntries'] - entries)
        observed[prefix] = ('directory', stable(before), names)
        entries += len(names)
        if entries > limits['maxEntries']: fail('Source exceeds entry limit')
        for name in names:
            if not safe_name(name): fail('Unsafe source filename')
            if excluded_name(name):
                if strict: fail('Destination contains excluded files')
                continue
            rel = prefix + '/' + name if prefix else name
            if len(rel.encode('utf-8')) > 1024: fail('Source path too long')
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(s.st_mode): fail('Source symlinks are not allowed')
            if stat.S_ISDIR(s.st_mode):
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                target_child = None
                try:
                    if identity(os.fstat(child)) != identity(s): fail('Directory changed during traversal')
                    if target is not None:
                        os.mkdir(name, 0o700, dir_fd=target)
                        target_child = os.open(name, DIR_FLAGS, dir_fd=target)
                    walk(child, rel, depth + 1, target_child)
                finally:
                    os.close(child)
                    if target_child is not None: os.close(target_child)
            elif not stat.S_ISREG(s.st_mode):
                fail('Special source files are not allowed')
            elif allowed_file(name):
                if strict and (s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o077): fail('Destination file is not private')
                if len(files) >= limits['maxFiles']: fail('Source exceeds file limit')
                if s.st_size > limits['maxTotalBytes'] - total: fail('Source exceeds total byte limit')
                data = read_stable_file(fd, name, s)
                if q.get('singleFile'):
                    ext = os.path.splitext(name)[1].lower()
                    valid_image_header = (ext == '.png' and data.startswith(b'\x89PNG\r\n\x1a\n')) or (ext in ('.jpg', '.jpeg') and data.startswith(b'\xff\xd8\xff')) or (ext == '.webp' and len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP' and int.from_bytes(data[4:8], 'little') + 8 == len(data))
                    if not valid_image_header: fail('Selected image header does not match its format')
                total += len(data)
                files.append({'path': rel, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)})
                observed[rel] = ('file', stable(s))
                if target is not None: write_file(target, name, data)
                if archive is not None:
                    info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
                    info.create_system = 3
                    info.external_attr = (stat.S_IFREG | 0o600) << 16
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, data, compresslevel=6)
            elif strict: fail('Destination contains excluded files')
        if stable(os.fstat(fd)) != stable(before): fail('Directory changed during traversal')
    walk(root_fd, '', 0, copy_fd)
    if q['entrypoint'] not in {f['path'] for f in files}: fail('Entrypoint is absent or excluded by the source allowlist')
    def verify(fd, prefix):
        record = observed[prefix]
        if stable(os.fstat(fd)) != record[1]: fail('Source tree changed during capture')
        if not (q.get('singleFile') and not strict and not prefix) and bounded_names(fd, limits['maxEntries']) != record[2]: fail('Source tree changed during capture')
        for name in record[2]:
            rel = prefix + '/' + name if prefix else name
            child_record = observed.get(rel)
            if child_record is None: continue
            s = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stable(s) != child_record[1]: fail('Source tree changed during capture')
            if child_record[0] == 'directory':
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                try: verify(child, rel)
                finally: os.close(child)
    verify(root_fd, '')
    files.sort(key=lambda item: item['path'])
    canonical = json.dumps({'version': 1, 'entrypoint': q['entrypoint'], 'files': files}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return {'sourceRoot': root, 'entrypoint': q['entrypoint'], 'files': files,
        'manifestSha256': hashlib.sha256(canonical).hexdigest(), 'totalBytes': total}

def remove_tree(parent, name):
    child = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        for item in os.listdir(child):
            s = os.stat(item, dir_fd=child, follow_symlinks=False)
            if stat.S_ISDIR(s.st_mode): remove_tree(child, item)
            else: os.unlink(item, dir_fd=child)
    finally: os.close(child)
    os.rmdir(name, dir_fd=parent)

def rename_exclusive(parent, old, new):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        fn, flag = libc.renameatx_np, 4  # RENAME_EXCL
    elif sys.platform.startswith('linux'):
        fn, flag = libc.renameat2, 1  # RENAME_NOREPLACE
    else: fail('Atomic no-replace directory publication is unsupported')
    fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    if fn(parent, os.fsencode(old), parent, os.fsencode(new), flag):
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))

def ensure_directory():
    root = os.path.abspath(q['sourceRoot'])
    if root == '/' or root != os.path.realpath(root): fail('Private directory root must be canonical')
    fd, chain = open_absolute_directory(root)
    try:
        s = os.fstat(fd)
        if s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o022: fail('Private directory root must be owned and not writable by other users')
        parts = q['relativePath'].split('/')
        if len(parts) > 32 or any(not safe_name(part) for part in parts): fail('Invalid private directory path')
        for part in parts:
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            s = os.fstat(child)
            chain.append((fd, part, child, s))
            fd = child
            if s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o077: fail('Existing factory directory is not private')
        verify_bindings(chain)
        return os.path.join(root, *parts)
    finally: close_chain(chain)

def publish_archive(data, manifest, source):
    filename = os.path.abspath(q['destinationFile'])
    parent, leaf = os.path.split(filename)
    if not safe_name(leaf) or parent != os.path.realpath(parent): fail('Archive destination must be canonical')
    if within(filename, source): fail('Archive destination overlaps source')
    fd, chain = open_absolute_directory(parent)
    stage = None
    digest = hashlib.sha256(data).hexdigest()
    try:
        s = os.fstat(fd)
        if s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o077: fail('Archive parent must be private and owned')
        def verify_existing():
            s = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
            if s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o077 or not stat.S_ISREG(s.st_mode) or s.st_nlink != 1:
                fail('Existing archive is unsafe')
            if s.st_size != len(data): fail('Existing archive differs')
            existing_fd = os.open(leaf, FILE_FLAGS, dir_fd=fd)
            try:
                if stable(os.fstat(existing_fd)) != stable(s): fail('Archive changed')
                h = hashlib.sha256()
                remaining = s.st_size
                while remaining:
                    part = os.read(existing_fd, min(remaining, 1024 * 1024))
                    if not part: fail('Archive changed')
                    h.update(part)
                    remaining -= len(part)
                if os.read(existing_fd, 1) or h.hexdigest() != digest or stable(os.fstat(existing_fd)) != stable(s): fail('Existing archive differs')
                if stable(os.stat(leaf, dir_fd=fd, follow_symlinks=False)) != stable(s): fail('Archive pathname changed')
            finally: os.close(existing_fd)
        try: os.stat(leaf, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            stage = '.factory-zip-' + secrets.token_hex(16)
            write_file(fd, stage, data)
            verify_bindings(chain)
            try: rename_exclusive(fd, stage, leaf)
            except OSError as error:
                if error.errno not in (errno.EEXIST, errno.ENOTEMPTY): raise
            else: stage = None
        verify_existing()
        verify_bindings(chain)
        os.fsync(fd)
        return {'path': filename, 'sha256': digest, 'bytes': len(data), 'manifestSha256': manifest['manifestSha256']}
    finally:
        if stage is not None: os.unlink(stage, dir_fd=fd)
        close_chain(chain)

def run():
    if q['operation'] == 'ensureDirectory': return ensure_directory()
    source, source_fd, source_chain = resolve_source()
    parent_chain, stage_name, parent_fd = [], None, None
    try:
        if q['operation'] == 'capture':
            result = capture(source, source_fd)
            verify_bindings(source_chain)
            return result
        if q['operation'] in ('bundle', 'archive'):
            class BoundedArchive(io.BytesIO):
                def write(self, data):
                    if self.tell() + len(data) > q['maxBytes']: fail('Source archive exceeds byte limit')
                    return super().write(data)
            output = BoundedArchive()
            with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=False) as archive:
                result = capture(source, source_fd, archive=archive)
            verify_bindings(source_chain)
            if result['manifestSha256'] != q['expectedManifestSha256']: fail('Source manifest changed before bundling')
            data = output.getvalue()
            if q['operation'] == 'archive': return publish_archive(data, result, source)
            return {'name': 'source.zip', 'sha256': hashlib.sha256(data).hexdigest(),
                'data': base64.b64encode(data).decode('ascii'), 'bytes': len(data),
                'manifestSha256': result['manifestSha256']}
        destination = os.path.abspath(q['destinationRoot'])
        parent_path, leaf = os.path.split(destination)
        if not safe_name(leaf): fail('Invalid destination directory')
        canonical_parent = os.path.realpath(parent_path)
        if canonical_parent != parent_path: fail('Destination parent must be canonical without symlinks')
        destination = os.path.join(canonical_parent, leaf)
        if within(destination, source) or within(source, destination): fail('Source and destination trees overlap')
        parent_fd, parent_chain = open_absolute_directory(canonical_parent)
        parent_stat = os.fstat(parent_fd)
        if parent_stat.st_uid != os.geteuid() or stat.S_IMODE(parent_stat.st_mode) & 0o077:
            fail('Destination parent must be private and owned by the service user')
        def existing(expected):
            fd = os.open(leaf, DIR_FLAGS, dir_fd=parent_fd)
            try:
                s = os.fstat(fd)
                if s.st_uid != os.geteuid() or stat.S_IMODE(s.st_mode) & 0o077: fail('Existing destination is not private')
                actual = capture(destination, fd, strict=True)
                if actual['manifestSha256'] != expected['manifestSha256']: fail('Destination already exists with different content')
                if identity(os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)) != identity(s): fail('Destination changed during verification')
                verify_bindings(parent_chain)
                return actual
            finally: os.close(fd)
        # Retrying after a registry failure does not overwrite an existing tree.
        try: os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError: pass
        else:
            expected = capture(source, source_fd)
            verify_bindings(source_chain)
            return existing(expected)
        stage_name = '.factory-import-' + secrets.token_hex(16)
        os.mkdir(stage_name, 0o700, dir_fd=parent_fd)
        stage_fd = os.open(stage_name, DIR_FLAGS, dir_fd=parent_fd)
        try:
            expected = capture(source, source_fd, stage_fd)
            copied = capture(destination, stage_fd, strict=True)
            if copied['manifestSha256'] != expected['manifestSha256']: fail('Private copy verification failed')
            verify_bindings(source_chain)
            verify_bindings(parent_chain)
            try: rename_exclusive(parent_fd, stage_name, leaf)
            except OSError as error:
                if error.errno not in (errno.EEXIST, errno.ENOTEMPTY): raise
                return existing(expected)
            stage_name = None
            if identity(os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)) != identity(os.fstat(stage_fd)):
                fail('Published destination changed')
            verify_bindings(parent_chain)
            return copied
        finally: os.close(stage_fd)
    finally:
        if stage_name is not None and parent_fd is not None: remove_tree(parent_fd, stage_name)
        close_chain(parent_chain)
        close_chain(source_chain)

try:
    print(json.dumps({'ok': True, 'result': run()}, ensure_ascii=False, separators=(',', ':')))
except Exception as error:
    # Never echo source contents, environment, or a Python traceback to callers.
    print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
    sys.exit(1)
`;

function normalizedInput(input: CaptureFactoryManifestInput) {
  if (
    typeof input.sourceRoot !== 'string' ||
    input.sourceRoot.length > 4096 ||
    !path.isAbsolute(input.sourceRoot) ||
    input.sourceRoot.includes('\0') ||
    !Array.isArray(input.allowedRoots) ||
    input.allowedRoots.length === 0 ||
    input.allowedRoots.length > 32 ||
    input.allowedRoots.some(
      (root) =>
        typeof root !== 'string' ||
        root.length > 4096 ||
        !path.isAbsolute(root) ||
        root.includes('\0'),
    )
  ) {
    throw new Error('Factory source requires explicit absolute allowed roots');
  }
  if (
    typeof input.entrypoint !== 'string' ||
    input.entrypoint.length > 1024 ||
    input.entrypoint.includes('\0') ||
    input.entrypoint.includes('\\') ||
    input.entrypoint
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Factory entrypoint must be a portable relative path');
  }
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const key of Object.keys(
    DEFAULT_LIMITS,
  ) as (keyof typeof DEFAULT_LIMITS)[]) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] <= 0 ||
      limits[key] > HARD_LIMITS[key]
    ) {
      throw new Error(`Invalid factory manifest limit: ${key}`);
    }
  }
  return {
    sourceRoot: input.sourceRoot,
    entrypoint: input.entrypoint,
    allowedRoots: input.allowedRoots,
    limits,
  };
}

function parseHelperResult(
  stdout: string,
  status: number | null,
  error?: Error,
): unknown {
  let response: { ok?: boolean; error?: string; result?: unknown };
  try {
    response = JSON.parse(stdout || '{}');
  } catch {
    throw new Error('Factory filesystem helper returned invalid output');
  }
  if (status !== 0 || !response.ok || !response.result) {
    throw new Error(
      `Factory filesystem operation failed: ${response.error || error?.message || 'helper failed'}`,
    );
  }
  return response.result;
}

function executeFilesystemHelper(input: Record<string, unknown>): unknown {
  const result = spawnSync(
    process.platform === 'darwin' ? '/usr/bin/python3' : 'python3',
    ['-I', '-c', FILESYSTEM_HELPER],
    {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return parseHelperResult(result.stdout, result.status, result.error);
}

function executeFilesystemHelperAsync(
  input: Record<string, unknown>,
  options: FactoryFilesystemHelperOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('Invalid factory filesystem deadline');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'darwin' ? '/usr/bin/python3' : 'python3',
      ['-I', '-c', FILESYSTEM_HELPER],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      // Python converts SIGTERM into an exception, running staged-copy cleanup.
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const timeout = setTimeout(
      () => stop(new Error('Factory filesystem deadline exceeded')),
      timeoutMs,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 16 * 1024 * 1024)
        stop(new Error('Factory filesystem output exceeded its cap'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 64 * 1024)
        stop(
          new Error('Factory filesystem diagnostic output exceeded its cap'),
        );
    });
    child.once('error', (error) => {
      failure = error;
    });
    child.stdin.on('error', (error) => {
      if (!failure) stop(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (failure) {
        reject(failure);
        return;
      }
      try {
        resolve(
          parseHelperResult(Buffer.concat(chunks).toString('utf8'), code),
        );
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function freezeManifest(manifest: FactoryManifest): FactoryManifest {
  for (const file of manifest.files) Object.freeze(file);
  Object.freeze(manifest.files);
  return Object.freeze(manifest);
}

function invokeHelper(
  operation: 'capture' | 'import',
  input: CaptureFactoryManifestInput,
  destinationRoot?: string,
): FactoryManifest {
  const manifest = executeFilesystemHelper({
    ...normalizedInput(input),
    operation,
    destinationRoot,
  }) as FactoryManifest;
  return freezeManifest(manifest);
}

/** Create private descendants through pinned directory descriptors, never symlinks. */
function normalizedDirectoryInput(input: EnsureFactoryPrivateDirectoryInput) {
  if (
    typeof input.root !== 'string' ||
    input.root.length > 4096 ||
    !path.isAbsolute(input.root) ||
    input.root.includes('\0') ||
    typeof input.relativePath !== 'string' ||
    input.relativePath.length > 1024 ||
    input.relativePath.includes('\\') ||
    input.relativePath.includes('\0') ||
    input.relativePath
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid private factory directory input');
  return {
    operation: 'ensureDirectory',
    sourceRoot: input.root,
    relativePath: input.relativePath,
    limits: DEFAULT_LIMITS,
  };
}

export function ensureFactoryPrivateDirectory(
  input: EnsureFactoryPrivateDirectoryInput,
): string {
  const result = executeFilesystemHelper(normalizedDirectoryInput(input));
  if (typeof result !== 'string')
    throw new Error('Invalid private directory result');
  return result;
}

/** Capture host-observed bytes, not hashes asserted by an agent or game code. */
export function captureFactoryManifest(
  input: CaptureFactoryManifestInput,
): FactoryManifest {
  return invokeHelper('capture', input);
}

/** Copy only allowed source/assets into a new private, atomically published tree. */
export function importFactorySource(
  input: ImportFactorySourceInput,
): FactoryManifest {
  validateDestination(input.destinationRoot);
  return invokeHelper('import', input, input.destinationRoot);
}

function validateDestination(destinationRoot: string): void {
  if (
    typeof destinationRoot !== 'string' ||
    destinationRoot.length > 4096 ||
    !path.isAbsolute(destinationRoot) ||
    destinationRoot.includes('\0')
  ) {
    throw new Error(
      'Factory destination must be an absolute host-selected path',
    );
  }
}

/** Production callers await this outside database transactions. */
export async function captureFactoryManifestAsync(
  input: CaptureFactoryManifestInput,
  options?: FactoryFilesystemHelperOptions,
): Promise<FactoryManifest> {
  return freezeManifest(
    (await executeFilesystemHelperAsync(
      { ...normalizedInput(input), operation: 'capture' },
      options,
    )) as FactoryManifest,
  );
}

export async function importFactorySourceAsync(
  input: ImportFactorySourceInput,
  options?: FactoryFilesystemHelperOptions,
): Promise<FactoryManifest> {
  validateDestination(input.destinationRoot);
  return freezeManifest(
    (await executeFilesystemHelperAsync(
      {
        ...normalizedInput(input),
        operation: 'import',
        destinationRoot: input.destinationRoot,
      },
      options,
    )) as FactoryManifest,
  );
}

export async function ensureFactoryPrivateDirectoryAsync(
  input: EnsureFactoryPrivateDirectoryInput,
  options?: FactoryFilesystemHelperOptions,
): Promise<string> {
  const result = await executeFilesystemHelperAsync(
    normalizedDirectoryInput(input),
    options,
  );
  if (typeof result !== 'string')
    throw new Error('Invalid private directory result');
  return result;
}

/** Portable private peer input, built from host-read bytes, never agent-supplied ZIP data. */
export async function bundleFactorySource(
  input: BundleFactorySourceInput,
  options?: FactoryFilesystemHelperOptions,
): Promise<FactorySourceBundle> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedManifestSha256))
    throw new Error('An exact expected source manifest is required');
  const maxBytes = input.maxBytes ?? 4 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 4 * 1024 * 1024
  )
    throw new Error('Invalid bounded peer archive size');
  return Object.freeze(
    (await executeFilesystemHelperAsync(
      {
        ...normalizedInput(input),
        operation: 'bundle',
        expectedManifestSha256: input.expectedManifestSha256,
        maxBytes,
      },
      options,
    )) as FactorySourceBundle,
  );
}

/** Writes a repeatable release candidate ZIP without returning its contents to the model. */
export async function archiveFactoryBuild(
  input: ArchiveFactoryBuildInput,
  options?: FactoryFilesystemHelperOptions,
): Promise<FactoryBuildArchive> {
  validateDestination(input.destinationFile);
  if (!/^[a-f0-9]{64}$/.test(input.expectedManifestSha256))
    throw new Error('An exact expected source manifest is required');
  const maxBytes = input.maxBytes ?? 110 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 256 * 1024 * 1024
  )
    throw new Error('Invalid bounded release archive size');
  return Object.freeze(
    (await executeFilesystemHelperAsync(
      {
        ...normalizedInput(input),
        operation: 'archive',
        destinationFile: input.destinationFile,
        expectedManifestSha256: input.expectedManifestSha256,
        maxBytes,
      },
      options,
    )) as FactoryBuildArchive,
  );
}

/** Selects a single image by host-verified path, never copies its sibling artifacts. */
export async function importFactoryFileAsync(
  input: ImportFactoryFileInput,
): Promise<{
  sourceRoot: string;
  file: { path: string; sha256: string; bytes: number };
}> {
  validateDestination(input.destinationRoot);
  const maxBytes = input.maxBytes ?? 49 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 49 * 1024 * 1024 ||
    !path.isAbsolute(input.sourceFile) ||
    !/\.(png|jpe?g|webp)$/i.test(input.sourceFile)
  )
    throw new Error('A bounded supported image file is required');
  const entrypoint = path.basename(input.sourceFile);
  const result = (await executeFilesystemHelperAsync({
    ...normalizedInput({
      sourceRoot: path.dirname(input.sourceFile),
      entrypoint,
      allowedRoots: [input.allowedRoot],
      limits: { maxFiles: 1, maxFileBytes: maxBytes, maxTotalBytes: maxBytes },
    }),
    operation: 'import',
    singleFile: true,
    destinationRoot: input.destinationRoot,
  })) as FactoryManifest;
  if (result.files.length !== 1 || result.files[0].path !== entrypoint)
    throw new Error('Single image import mismatch');
  const file = result.files[0];
  return {
    sourceRoot: result.sourceRoot,
    file: { path: file.path, sha256: file.sha256, bytes: file.size },
  };
}
