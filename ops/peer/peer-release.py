#!/usr/bin/env python3
"""Produce a pinned, code-only peer bundle and build it in an empty native stage.

No service, model, Telegram or private credential is used. Run `pack` from a clean
reviewed checkout, transfer the resulting bundle over the maintenance transport,
then run `build` on the target. The live instance is never a build directory.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
import posixpath
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('peer_deployment', Path(__file__).with_name('peer-deployment.py'))
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)

SOURCE_ENTRIES = ('.claude', '.claude-plugin', '.env.example', '.gitattributes', '.gitignore',
                  '.prettierrc', 'AGENTS.md', 'CLAUDE.md', 'LICENSE', 'README.md',
                  'agent', 'apps', 'assets', 'bin', 'config', 'docs', 'evals', 'helper',
                  'ops', 'packages', 'patches', 'runtime', 'scripts', 'setup', 'skills',
                  'src', 'package.json', 'package-lock.json', 'tsconfig.base.json',
                  'tsconfig.json', 'vitest.config.ts')
MAX_SOURCE_BYTES = 128 * 1024 * 1024


def run_logged(label, argv, cwd, env, log_root, timeout=1800):
    """Bound real execution, output, and descendants; receipts never forge checks."""
    log = log_root / (label + '.private.log')
    fd = os.open(log, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    start = time.monotonic()
    child = subprocess.Popen([str(x) for x in argv], cwd=cwd, env=env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True)
    selector = selectors.DefaultSelector(); selector.register(child.stdout, selectors.EVENT_READ)
    total = 0
    try:
        with os.fdopen(fd, 'wb') as output:
            while selector.get_map():
                if time.monotonic() - start > timeout: deployment.fail('build_command_timeout')
                for key, _ in selector.select(.2):
                    block = os.read(key.fd, 65536)
                    if not block:
                        selector.unregister(key.fileobj); continue
                    total += len(block)
                    if total > 128 * 1024 * 1024: deployment.fail('build_log_size_limit')
                    output.write(block)
            code = child.wait(timeout=5)
            output.flush(); os.fsync(output.fileno())
        if code != 0: deployment.fail('build_check_failed_' + label)
        return {'check': label, 'exitCode': code, 'durationSeconds': round(time.monotonic() - start, 2),
                'logSha256': deployment.digest(log), 'logBytes': total}
    finally:
        selector.close()
        if child.poll() is None:
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                child.wait(timeout=5)
        child.stdout.close()


def safe_members(archive):
    members = archive.getmembers(); total = 0; seen = set(); links = set()
    if len(members) > 5000: deployment.fail('source_archive_member_limit')
    for member in members:
        name = member.name.rstrip('/')
        parts = name.split('/')
        if not name or name.startswith('/') or any(p in ('', '.', '..') for p in parts) or '\\' in name or name in seen or any(ord(c) < 32 for c in name):
            deployment.fail('unsafe_source_archive_path')
        seen.add(name)
        if parts[0] not in SOURCE_ENTRIES or parts[0] in deployment.PRIVATE_TOP:
            deployment.fail('source_archive_not_allowlisted')
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if not member.linkname or member.linkname.startswith('/') or '\\' in member.linkname or target == '..' or target.startswith('../') or target.split('/')[0] not in SOURCE_ENTRIES:
                deployment.fail('source_archive_link_escape')
            links.add(name)
        elif not member.isfile() and not member.isdir():
            deployment.fail('source_archive_special_file')
        if not member.issym() and member.mode & 0o022: deployment.fail('source_archive_writable_mode')
        total += member.size
        if total > MAX_SOURCE_BYTES: deployment.fail('source_archive_size_limit')
    for name in seen:
        parts = name.split('/')
        if any('/'.join(parts[:i]) in links for i in range(1, len(parts))):
            deployment.fail('source_archive_symlink_parent')
    return members


def extract_source(archive_path, target):
    target = Path(target)
    if target.exists(): deployment.fail('source_stage_must_be_new')
    with tarfile.open(archive_path, 'r:*') as archive:
        members = safe_members(archive)
        target.mkdir(mode=0o700)
        # Members never descend through a symlink; links are published last.
        for member in members:
            p = target / member.name
            if member.issym(): continue
            if member.isdir():
                p.mkdir(mode=0o700, parents=True, exist_ok=True)
            else:
                p.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, member.mode & 0o755)
                with os.fdopen(fd, 'wb') as output, archive.extractfile(member) as source:
                    shutil.copyfileobj(source, output)
        for member in members:
            if member.issym():
                p = target / member.name; p.parent.mkdir(mode=0o700, parents=True, exist_ok=True); p.symlink_to(member.linkname)
                if not deployment.contained(p.resolve(), target.resolve()): deployment.fail('source_archive_link_escape')
        return len(members)


def pack(source, commit, output, toolchain):
    source = deployment.directory(source); output = deployment.directory(output)
    if not re.fullmatch('[0-9a-f]{40}', commit): deployment.fail('source_commit_invalid')
    actual = deployment.command(['git', '-C', source, 'rev-parse', 'HEAD']).strip()
    if actual != commit: deployment.fail('source_commit_mismatch')
    if deployment.command(['git', '-C', source, 'status', '--porcelain', '--untracked-files=all']).strip():
        deployment.fail('source_checkout_not_clean')
    for name in ('peer-release.py', 'peer-deployment.py'):
        committed = subprocess.run(['git', '-C', str(source), 'show', commit + ':ops/peer/' + name], capture_output=True, check=True).stdout
        if hashlib.sha256(committed).hexdigest() != deployment.digest(Path(__file__).with_name(name)):
            deployment.fail('builder_not_from_reviewed_source_commit')
    tracked = set(deployment.command(['git', '-C', source, 'ls-tree', '--name-only', commit]).splitlines())
    entries = [name for name in SOURCE_ENTRIES if name in tracked]
    # Git's default tar.umask=0002 produces group-writable archive members.
    # Pin just this invocation; neither repository nor user config is changed.
    body = subprocess.run(['git', '-C', str(source), '-c', 'tar.umask=0022', 'archive', '--format=tar', commit, '--', *entries], capture_output=True, check=True).stdout
    if len(body) > MAX_SOURCE_BYTES: deployment.fail('source_archive_size_limit')
    with tarfile.open(fileobj=io.BytesIO(body)) as archive: safe_members(archive)
    manifest = deployment.read_json(toolchain, False)
    if manifest.get('version') != '0.166.0' or manifest.get('platform') != 'darwin' or manifest.get('arch') != 'arm64':
        deployment.fail('reviewed_native_toolchain_required')
    files = {'source.tar': body, 'codex-toolchain.json': Path(toolchain).read_bytes()}
    for name, data in files.items():
        fd = os.open(output / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as stream: stream.write(data)
    receipt = {'schema': 1, 'sourceCommit': commit, 'entries': entries,
               'archiveSha256': deployment.digest(output / 'source.tar'),
               'toolchainSha256': deployment.digest(output / 'codex-toolchain.json'),
               'cliVersion': manifest['version'], 'personalStateIncluded': False,
               'sourceTopEntryCount': len(entries), 'reviewedBuilderSha256': deployment.digest(__file__),
               'reviewedControllerSha256': deployment.digest(Path(__file__).with_name('peer-deployment.py'))}
    deployment.save(output / 'source-receipt.private.json', receipt, True)
    return {'status': 'packed', 'sourceCommit': commit, 'privateStateIncluded': False}


def build_environment(stage, code, node, tmp, native):
    home = stage / 'isolated-home'; home.mkdir(mode=0o700)
    # npm rejects loading the same path as both user and global configuration.
    # Distinct empty files keep account/user registry credentials out of builds.
    configs = [home / 'npm-user.conf', home / 'npm-global.conf']
    for config in configs:
        fd = os.open(config, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600); os.close(fd)
    codex_tools = code / native['destination'] / Path(native['binary']).parent.parent / 'codex-path'
    return {'HOME': str(home), 'PATH': str(node.parent) + ':' + str(codex_tools) + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
           'TMPDIR': str(tmp), 'CI': 'true', 'HUSKY': '0', 'LC_ALL': 'en_US.UTF-8',
           'npm_config_cache': str(home / 'npm-cache'), 'npm_config_userconfig': str(configs[0]),
           'npm_config_globalconfig': str(configs[1]), 'XDG_CONFIG_HOME': str(home / 'config'),
           'XDG_CACHE_HOME': str(home / 'cache'), 'XDG_STATE_HOME': str(home / 'state'),
           'PLAYWRIGHT_BROWSERS_PATH': str(code / '.peer-browsers')}


def detach_internal_hardlinks(root):
    """npm/esbuild links its two executables; retain bytes as independent files.

    Never accept a link to a file outside the new release, and never follow a
    symlink directory. The deployment controller continues to reject hardlinks.
    """
    root = deployment.directory(root); groups = {}
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(current) / name).is_symlink()]
        for name in files:
            p = Path(current) / name; s = p.lstat()
            if stat.S_ISREG(s.st_mode) and s.st_nlink > 1:
                groups.setdefault((s.st_dev, s.st_ino), []).append(p)
    # Validate all groups before the first rewrite.
    for paths in groups.values():
        for p in paths:
            s = p.lstat()
            if s.st_uid != os.getuid() or s.st_nlink != len(paths) or not stat.S_ISREG(s.st_mode):
                deployment.fail('external_build_hardlink')
    for paths in groups.values():
        for p in paths[:-1]:
            before = p.lstat(); expected = deployment.digest(p)
            fd, temp = tempfile.mkstemp(prefix='.peer-detach-', dir=p.parent)
            try:
                with os.fdopen(fd, 'wb') as output, p.open('rb') as source:
                    shutil.copyfileobj(source, output); output.flush(); os.fsync(output.fileno())
                os.chmod(temp, stat.S_IMODE(before.st_mode))
                after = p.lstat()
                if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or deployment.digest(temp) != expected:
                    deployment.fail('build_hardlink_changed')
                os.replace(temp, p)
            finally:
                if os.path.lexists(temp): os.unlink(temp)
    return len(groups)


def build(bundle, stage, node):
    # Destructive-operation test fixtures deliberately accept only OS temp
    # locations. Keep an owned private directory there, never disable the guard.
    with tempfile.TemporaryDirectory(prefix='skoobi-peer-build-', dir=Path('/tmp').resolve()) as tmp:
        return build_native(bundle, stage, node, Path(tmp).resolve())


def build_native(bundle, stage, node, tmp):
    if sys.platform != 'darwin' or os.uname().machine != 'arm64': deployment.fail('native_darwin_arm64_required')
    bundle = deployment.directory(bundle); stage = Path(stage).absolute()
    deployment.directory(stage.parent)
    if stage.exists(): deployment.fail('build_stage_must_be_new')
    node = deployment.regular(node)
    receipt = deployment.read_json(bundle / 'source-receipt.private.json')
    if deployment.digest(bundle / 'source.tar') != receipt['archiveSha256'] or deployment.digest(bundle / 'codex-toolchain.json') != receipt['toolchainSha256']:
        deployment.fail('source_bundle_changed')
    if receipt.get('reviewedBuilderSha256') != deployment.digest(__file__) or receipt.get('reviewedControllerSha256') != deployment.digest(Path(__file__).with_name('peer-deployment.py')):
        deployment.fail('source_builder_changed')
    stage.mkdir(mode=0o700); code = stage / 'release'; logs = stage / 'checks'; logs.mkdir(mode=0o700)
    extract_source(bundle / 'source.tar', code)
    for name, expected in [('peer-release.py', receipt['reviewedBuilderSha256']), ('peer-deployment.py', receipt['reviewedControllerSha256'])]:
        if deployment.digest(code / 'ops/peer' / name) != expected:
            deployment.fail('source_build_controller_mismatch')
    (code / 'runtime/codex-toolchain.json').write_bytes((bundle / 'codex-toolchain.json').read_bytes())
    native = deployment.read_json(code / 'runtime/codex-toolchain.json', False)
    bridge_files = [{'name': name, 'sha256': deployment.digest(code / 'ops/peer' / name)} for name in
                    ('skoobi-peer-core.mjs', 'skoobi-peer-contract.mjs', 'skoobi-peer-worker.mjs', 'skoobi-peer-runtime.mjs')]
    bridge_sha = hashlib.sha256(json.dumps(bridge_files, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    deployment.save(code / 'runtime/peer-release.json',
                    {'schema': 1, 'sourceCommit': receipt['sourceCommit'], 'sourceArchiveSha256': receipt['archiveSha256'],
                     'cliVersion': native['version'], 'cliBinarySha256': native['binarySha256'],
                     'bridgeFiles': bridge_files, 'bridgeSha256': bridge_sha}, True)
    env = build_environment(stage, code, node, tmp, native)
    version = deployment.command([node, '--version'], env=env).strip()
    if not version.startswith('v22.'): deployment.fail('native_node22_required')
    npm = node.parent / 'npm'
    if not npm.is_file(): deployment.fail('matching_npm_required')
    checks = []
    def run(label, args, cwd=code, timeout=1800):
        value = run_logged(label, args, cwd, env, logs, timeout)
        checks.append(value); deployment.save(stage / 'build-progress.private.json', {'checks': checks, 'sourceCommit': receipt['sourceCommit']})
    run('install_root', [npm, 'ci', '--no-audit', '--no-fund'])
    run('install_runner', [npm, 'ci', '--no-audit', '--no-fund'], code / 'agent/runner')
    run('pinned_cli', [node, 'scripts/codex-toolchain.mjs', '--install'])
    run('browser', [node, 'node_modules/playwright/cli.js', 'install', 'chromium'])
    run('build', [npm, 'run', 'build'])
    run('typecheck', [npm, 'run', 'typecheck'])
    run('tests', [npm, 'test'], timeout=2400)
    files = sorted((code / 'ops/peer').glob('*.node-test.mjs'))
    if not files: deployment.fail('peer_tests_missing')
    run('peer', [node, '--test', *files], timeout=180)
    run('deployment', ['/usr/bin/python3', 'ops/peer/peer-deployment.test.py'], timeout=180)
    run('release_builder', ['/usr/bin/python3', 'ops/peer/peer-release.test.py'], timeout=180)
    run('native_runtime', [node, 'scripts/codex-toolchain.mjs', '--check'])
    run('native_sqlite', [node, '-e', "const D=require('better-sqlite3');const d=new D(':memory:');if(d.prepare('SELECT 42 n').get().n!==42)process.exit(1);d.close();"])
    # Syntax check only: never execute the entrypoint or create worker state here.
    run('worker_adapter', [node, '--check', 'scripts/skoobi-peer-worker.mjs'])
    if b'ops/peer/skoobi-peer-worker.mjs' not in (code / 'scripts/skoobi-peer-worker.mjs').read_bytes():
        deployment.fail('stable_worker_adapter_missing')
    for name in ('data', 'logs', 'groups', 'store'):
        p = code / name
        if p.exists():
            if p.is_symlink() or not p.is_dir() or list(p.iterdir()): deployment.fail('build_left_private_state')
            p.rmdir()
    # Imports/tests may create bytecode under source. It has no runtime purpose.
    for p in sorted(code.rglob('__pycache__'), reverse=True):
        if p.is_dir() and not p.is_symlink() and 'node_modules' not in p.parts:
            shutil.rmtree(p)
    detached = detach_internal_hardlinks(code)
    record = deployment.release_record(code)
    verified = {'schema': 1, 'status': 'verified', 'protocol': 2, 'sourceCommit': receipt['sourceCommit'],
                'cliVersion': receipt['cliVersion'], 'nodeVersion': version, 'nodeSha256': deployment.digest(node),
                'platform': sys.platform, 'arch': os.uname().machine,
                'releaseRecord': record, 'checkReceipts': checks,
                'checks': {'nativeRuntime': True, 'build': True, 'tests': True,
                           'workerAdapter': True, 'privateStateExcluded': True},
                'builtAt': time.time(), 'modelCalled': False, 'serviceStarted': False,
                'detachedInternalHardlinkGroups': detached}
    deployment.save(stage / 'release-receipt.private.json', verified, True)
    return {'status': 'verified', 'sourceCommit': receipt['sourceCommit'],
            'checks': len(checks), 'files': record['tree']['files'], 'liveMutated': False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    p = commands.add_parser('pack')
    for arg in ('source', 'commit', 'output', 'toolchain'): p.add_argument('--' + arg, required=True)
    b = commands.add_parser('build')
    for arg in ('bundle', 'stage', 'node'): b.add_argument('--' + arg, required=True)
    args = parser.parse_args()
    result = pack(args.source, args.commit, args.output, args.toolchain) if args.action == 'pack' else build(args.bundle, args.stage, args.node)
    print(json.dumps(result))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[a-z0-9_]+', str(error)) else type(error).__name__
        print(json.dumps({'status': 'failed', 'code': code}), file=sys.stderr); sys.exit(1)
