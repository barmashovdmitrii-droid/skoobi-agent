#!/usr/bin/env python3
"""Explicit, resumable checks and a non-force private feature-branch publication.

This is an operator tool, not an execution sandbox or a public export procedure.
State and receipts must remain outside the checkout. Nothing runs at startup.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

VERSION = 1
STEPS = ('install_root', 'install_runner', 'browser', 'build', 'typecheck', 'test', 'shell', 'scan')
TIMEOUTS = dict(install_root=900, install_runner=600, browser=600, build=900,
                typecheck=900, test=1800, shell=120, scan=600, publish=180)
MAX_LOG = 2 * 1024 * 1024
MAX_JSON = 2 * 1024 * 1024
MAX_FILE = 64 * 1024 * 1024
MAX_TREE = 256 * 1024 * 1024
MAX_AGE = 86400
SHA = re.compile(r'^[0-9a-f]{40}$')
ID = re.compile(r'^[0-9a-f]{32}$')
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)
SCRIPT = Path(__file__).resolve()


def fail(code):
    raise ValueError(code)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def implementation_hash():
    return digest(SCRIPT.read_bytes())


def private_dir(path, create=False):
    path = Path(os.path.abspath(path))
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current /= part
        if create:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail('unsafe_directory')
    return path


def read_bytes(path, limit=MAX_JSON):
    fd = os.open(path, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit or info.st_nlink != 1:
            fail('unsafe_file')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            fail('file_too_large')
        return data
    finally:
        os.close(fd)


def atomic(path, data):
    parent = private_dir(path.parent)
    temp = parent / ('.write-' + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if path.is_symlink():
            fail('unsafe_file')
        os.replace(temp, path)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


def save(path, value):
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    if len(data) > MAX_JSON:
        fail('state_capacity')
    atomic(path, data)


def load(path):
    return json.loads(read_bytes(path))


@contextlib.contextmanager
def locked(directory):
    fd = os.open(directory / 'lock', os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield fd
    finally:
        os.close(fd)


def environment(auth=False):
    # Do not pass service credentials, npm hooks options, or Git overrides to checks.
    keep = ('PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT')
    env = {key: os.environ[key] for key in keep if key in os.environ}
    env.update(CI='1', HUSKY='0', GIT_TERMINAL_PROMPT='0', GIT_CONFIG_NOSYSTEM='1',
               GIT_CONFIG_GLOBAL=os.devnull, PYTHONDONTWRITEBYTECODE='1')
    if auth:
        for key in ('HOME', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN'):
            if key in os.environ:
                env[key] = os.environ[key]
    return env


def capture(args, cwd=None, auth=False, timeout=60):
    # Metadata commands only. Their output is never printed by the CLI.
    if auth:
        # Explicit GitHub metadata/transport needs the operator's existing auth.
        return capture_metadata(args, cwd, environment(True), timeout)
    # Even `gh --version` can initialize state. An absent HOME can make a tool
    # resolve .local against cwd, dirtying the very checkout being fingerprinted.
    # Never use the operator's HOME or a shared fixed /tmp HOME for unauthenticated
    # commands. Each invocation owns a private temporary tree, including XDG.
    current = Path(cwd or os.getcwd()).resolve()
    bases = (Path('/private/tmp'), Path('/tmp'), Path('/var/tmp'))
    base = next((candidate.resolve() for candidate in bases
                 if candidate.is_dir() and candidate.resolve() != current
                 and current not in candidate.resolve().parents), None)
    if base is None:
        fail('metadata_home_unavailable')
    with tempfile.TemporaryDirectory(prefix='private-update-metadata-', dir=base) as temporary:
        home = Path(temporary)
        env = environment(False)
        env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / 'config'),
                   XDG_STATE_HOME=str(home / 'state'), XDG_DATA_HOME=str(home / 'share'),
                   XDG_CACHE_HOME=str(home / 'cache'), GH_CONFIG_DIR=str(home / 'config/gh'),
                   npm_config_cache=str(home / 'cache/npm'), TMPDIR=str(home / 'tmp'))
        for relative in ('config/gh', 'state', 'share', 'cache/npm', 'tmp'):
            (home / relative).mkdir(mode=0o700, parents=True, exist_ok=True)
        return capture_metadata(args, cwd, env, timeout)


def capture_metadata(args, cwd, env, timeout):
    process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
    selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    deadline = time.monotonic() + timeout
    completed = False
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                fail('metadata_command_timeout')
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fd, 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                output[key.data].extend(chunk)
                if len(output[key.data]) > MAX_JSON:
                    fail('metadata_output_limit')
        if process.wait(timeout=max(0.01, deadline - time.monotonic())):
            fail('metadata_command_failed')
        completed = True
        return bytes(output['stdout'])
    finally:
        selector.close()
        if not completed:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        process.stdout.close()
        process.stderr.close()


def git_args(*args, hooks=None):
    return ['git', '-c', 'core.hooksPath=' + str(hooks or os.devnull),
            '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
            '-c', 'credential.helper=!gh auth git-credential',
            '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', *args]


def git(repo, *args):
    return capture(git_args('-C', str(repo), *args))


def validate_target(repo, branch):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}', repo):
        fail('invalid_repository')
    if not re.fullmatch(r'(?:feature|fix|chore)/[A-Za-z0-9][A-Za-z0-9._/-]{0,119}', branch):
        fail('feature_branch_required')
    if any(part.lower() in ('main', 'master', 'prod', 'production', 'release') or
           part in ('', '.', '..') or part.endswith('.lock') for part in branch.split('/')):
        fail('protected_branch')
    if '..' in branch or branch.endswith(('/', '.')):
        fail('invalid_branch')


def validate_base_ref(branch):
    # Read-only branch name, not an arbitrary revision/refspec or push target.
    if not isinstance(branch, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,149}', branch):
        fail('invalid_base_ref')
    if ('..' in branch or branch.endswith(('/', '.')) or
            any(part in ('', '.', '..') or part.endswith('.lock') for part in branch.split('/'))):
        fail('invalid_base_ref')


def private_repo(repo):
    raw = capture(['gh', 'api', 'repos/' + repo], auth=True)
    value = json.loads(raw)
    if value.get('private') is not True or value.get('full_name', '').lower() != repo.lower():
        fail('private_repository_required')
    branch = value.get('default_branch')
    if not isinstance(branch, str) or not re.fullmatch(r'[A-Za-z0-9._/-]{1,150}', branch):
        fail('invalid_default_branch')
    return branch


def remote_ref(repo, branch):
    ref = 'refs/heads/' + branch
    data = capture(git_args('ls-remote', '--heads', 'https://github.com/' + repo + '.git', ref), auth=True)
    rows = data.decode().splitlines()
    if not rows:
        return None
    if len(rows) != 1:
        fail('ambiguous_remote_ref')
    parts = rows[0].split('\t')
    if len(parts) != 2 or not SHA.fullmatch(parts[0]) or parts[1] != ref:
        fail('invalid_remote_ref')
    return parts[0]


def validate_tracked_path(name):
    parts = name.split('/')
    if name.startswith('/') or '\\' in name or any(p in ('', '.', '..', '.git') for p in parts):
        fail('unsafe_tracked_path')
    if any((p == '.env' or p.startswith('.env.') and p not in ('.env.example', '.env.sample', '.env.template')) for p in parts):
        fail('tracked_private_state')
    if parts[0] in ('store', 'groups', 'logs', 'data', 'node_modules'):
        fail('tracked_private_state')


def snapshot(repo, destination=None, allow_ignored_runtime=False):
    if git(repo, 'status', '--porcelain=v1', '--untracked-files=all').strip():
        fail('dirty_checkout')
    for name in ('.env', '.claudeclaw.json', 'store', 'groups', 'logs', 'data'):
        if allow_ignored_runtime:
            continue
        runtime = repo / name
        try:
            info = runtime.lstat()
        except FileNotFoundError:
            continue
        # Tests may leave an empty directory, which has no data and is not a
        # Git entry. Configuration files, links (even dangling), regular files,
        # and directories containing even one nested entry remain forbidden.
        if name.startswith('.') or not stat.S_ISDIR(info.st_mode):
            fail('runtime_state_in_checkout')
        try:
            fd = os.open(runtime, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
            try:
                with os.scandir(fd) as entries:
                    if next(entries, None) is not None:
                        fail('runtime_state_in_checkout')
            finally:
                os.close(fd)
        except OSError:
            fail('runtime_state_in_checkout')
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    if not SHA.fullmatch(head):
        fail('invalid_head')
    entries = git(repo, 'ls-files', '-s', '-z').split(b'\0')
    hasher, total, count = hashlib.sha256(), 0, 0
    for row in entries:
        if not row:
            continue
        metadata, raw_name = row.split(b'\t', 1)
        mode, _, stage = metadata.decode().split()
        name = raw_name.decode('utf-8')
        validate_tracked_path(name)
        if stage != '0' or mode not in ('100644', '100755', '120000'):
            fail('unsupported_git_entry')
        file = repo / name
        if mode == '120000':
            if not file.is_symlink():
                fail('changed_symlink')
            target = os.readlink(file)
            try:
                file.resolve(strict=True).relative_to(repo.resolve())
            except (ValueError, OSError):
                fail('escaping_symlink')
            data = target.encode()
        else:
            private_dir(file.parent)
            data = read_bytes(file, MAX_FILE)
        total += len(data)
        count += 1
        if total > MAX_TREE or count > 50000:
            fail('tree_capacity')
        hasher.update(mode.encode() + b'\0' + raw_name + b'\0' + str(len(data)).encode() + b'\0' + data)
        if destination:
            out = destination / name
            out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # A link is scanned as its literal text; its in-tree target is scanned separately.
            out.write_bytes(data)
            out.chmod(0o600)
    if git(repo, 'rev-parse', 'HEAD').decode().strip() != head or git(repo, 'status', '--porcelain=v1', '--untracked-files=all').strip():
        fail('checkout_changed')
    return {'head': head, 'treeSha256': hasher.hexdigest(), 'files': count, 'bytes': total}


def versions(repo):
    result = {}
    for name, command in (
        ('git', ['git', '--version']), ('gh', ['gh', '--version']),
        ('gitleaks', ['gitleaks', 'version']),
        ('node', ['bash', 'scripts/with-node22.sh', 'node', '--version']),
        ('npm', ['bash', 'scripts/with-node22.sh', 'npm', '--version']),
    ):
        result[name] = capture(command, cwd=repo).decode().splitlines()[0][:200]
    if not result['node'].startswith('v22.'):
        fail('node22_required')
    return result


def task_dir(root, task):
    if not ID.fullmatch(task):
        fail('invalid_workflow_id')
    return private_dir(private_dir(root) / task)


def state_at(directory):
    state = load(directory / 'state.json')
    if state.get('version') != VERSION or state.get('implementationSha256') != implementation_hash():
        fail('implementation_changed_new_workflow_required')
    if state.get('taskId') != directory.name:
        fail('state_identity_mismatch')
    validate_target(state['repository'], state['branch'])
    workspace = private_dir(directory / 'workspace')
    if [workspace.stat().st_dev, workspace.stat().st_ino] != state['workspaceIdentity']:
        fail('workspace_replaced')
    return state


def write_state(directory, state):
    save(directory / 'state.json', state)


def prepare(root, source, repository, branch, base_ref=None):
    validate_target(repository, branch)
    if base_ref is not None:
        validate_base_ref(base_ref)
        if base_ref == branch:
            fail('base_ref_is_publication_target')
    source = private_dir(Path(source).resolve())
    root = private_dir(Path(root).resolve(), create=True)
    if source == root or source in root.parents or root in source.parents:
        fail('state_must_be_outside_source')
    if len(list(root.iterdir())) >= 16:
        fail('workflow_capacity')
    before = snapshot(source, allow_ignored_runtime=True)
    default = private_repo(repository)
    if branch == default:
        fail('protected_branch')
    remote = remote_ref(repository, branch)
    base_branch = branch if remote else (base_ref or default)
    validate_base_ref(base_branch)
    base = remote or remote_ref(repository, base_branch)
    if base is None:
        fail('missing_remote_base')
    task = uuid.uuid4().hex
    directory = root / task
    directory.mkdir(mode=0o700)
    workspace = directory / 'workspace'
    # --no-hardlinks and disabled hooks prevent sharing mutable Git objects or executing source hooks.
    capture(['git', '-c', 'core.hooksPath=' + os.devnull, '-c', 'protocol.file.allow=always',
             'clone', '--no-hardlinks', '--no-local', '--no-checkout', str(source), str(workspace)], timeout=120)
    git(workspace, 'remote', 'remove', 'origin')
    git(workspace, 'checkout', '--detach', before['head'])
    after = snapshot(workspace)
    if before != after or snapshot(source, allow_ignored_runtime=True) != before:
        fail('source_changed_during_prepare')
    if subprocess.run(git_args('-C', str(workspace), 'cat-file', '-e', base + '^{commit}'),
                      env=environment(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
        capture(git_args('-C', str(workspace), 'fetch', '--no-tags', 'https://github.com/' + repository + '.git',
                         'refs/heads/' + base_branch), auth=True, timeout=120)
    capture(git_args('-C', str(workspace), 'merge-base', '--is-ancestor', base, before['head']))
    (directory / 'logs').mkdir(mode=0o700)
    (directory / 'receipts').mkdir(mode=0o700)
    (directory / 'test-state').mkdir(mode=0o700)
    state = {'version': VERSION, 'taskId': task, 'implementationSha256': implementation_hash(),
             'createdAt': time.time(), 'source': str(source), 'sourceInput': before,
             'repository': repository, 'branch': branch, 'defaultBranchAtPrepare': default,
             'baseBranchAtPrepare': base_branch,
             'expectedRemote': remote, 'baseCommit': base, 'generation': 1, 'input': after,
             'gitConfigSha256': digest(read_bytes(workspace / '.git/config')),
             'tools': versions(workspace), 'receipts': {}, 'attempts': {}, 'history': [], 'active': None,
             'status': 'prepared', 'workspaceIdentity': [workspace.stat().st_dev, workspace.stat().st_ino]}
    write_state(directory, state)
    save(directory / 'prepare-receipt.json', {'version': VERSION, 'outcome': 'succeeded', 'input': after,
                                             'completedAt': time.time(), 'implementationSha256': implementation_hash()})
    return {'taskId': task, 'workspace': str(workspace), 'status': 'prepared'}


def process_birth(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.stdout.decode().strip() if result.returncode == 0 else None


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def reconcile(directory, state):
    active = state.get('active')
    if not active:
        return
    receipt = directory / 'receipts' / (active['nonce'] + '.json')
    if receipt.exists():
        value = load(receipt)
        if (value.get('nonce'), value.get('input'), value.get('step'), value.get('implementationSha256')) != (
                active['nonce'], state['input'], active['step'], state['implementationSha256']):
            fail('receipt_mismatch')
        state['history'].append(value)
        if value['outcome'] == 'succeeded':
            state['receipts'][active['step']] = value
        state['active'] = None
        state['status'] = value['outcome']
        write_state(directory, state)
        return
    if alive(active.get('pid')):
        fail('step_still_running_or_identity_unknown')
    # Never restart a potentially still-running orphan command group.
    running = directory / 'receipts' / (active['nonce'] + '.running.json')
    if running.exists():
        process = load(running)
        try:
            os.killpg(process['pid'], 0)
        except ProcessLookupError:
            pass
        except (PermissionError, KeyError):
            fail('orphan_process_state_unknown')
        else:
            fail('orphan_command_still_running')
    state['history'].append({**active, 'outcome': 'interrupted', 'completedAt': time.time()})
    state['active'] = None
    state['status'] = 'interrupted'
    write_state(directory, state)


def check_current(directory, state):
    if (directory / 'cancelled.json').exists():
        fail('workflow_cancelled')
    if time.time() - state['createdAt'] > MAX_AGE:
        fail('workflow_expired')
    if digest(read_bytes(directory / 'workspace/.git/config')) != state['gitConfigSha256']:
        fail('git_configuration_changed')
    current = snapshot(directory / 'workspace')
    changed = current != state['input']
    if current != state['input']:
        if state['generation'] >= 3 or 'publish' in state['receipts']:
            fail('new_workflow_required')
        state['generation'] += 1
        state['input'] = current
        state['receipts'] = {}
        state['attempts'] = {}
        state['status'] = 'inputs_changed_checks_invalidated'
        write_state(directory, state)
    if versions(directory / 'workspace') != state['tools']:
        fail('tool_versions_changed_new_workflow_required')
    return changed


def command_plan(step, workspace):
    prefix = ['bash', 'scripts/with-node22.sh']
    if step == 'install_root':
        return [(prefix + ['npm', 'ci', '--no-audit', '--no-fund'], workspace)]
    if step == 'install_runner':
        return [(prefix + ['npm', '--prefix', 'agent/runner', 'ci', '--no-audit', '--no-fund'], workspace)]
    if step == 'browser':
        return [(prefix + ['node', 'node_modules/playwright/cli.js', 'install', 'chromium'], workspace)]
    if step in ('build', 'typecheck'):
        return [(prefix + ['npm', 'run', step], workspace)]
    if step == 'test':
        return [(prefix + ['npm', 'test'], workspace)]
    if step == 'shell':
        return [(['bash', '-n', str(file)], workspace) for file in sorted((workspace / 'scripts').glob('*.sh'))]
    fail('unknown_step')


def run_command(directory, active, args, cwd, log, deadline, auth=False):
    if (directory / 'cancelled.json').exists():
        fail('workflow_cancelled')
    if time.monotonic() >= deadline:
        fail('timeout')
    env = environment(auth)
    env['SKOOBI_TEST_STATE_ROOT'] = str(directory / 'test-state')
    # Build tools receive a private home, not host npm/Git service configuration.
    if not auth:
        home = directory / 'tool-home'
        home.mkdir(mode=0o700, exist_ok=True)
        env['HOME'] = str(home)
        env['npm_config_cache'] = str(directory / 'cache/npm')
        env['XDG_CACHE_HOME'] = str(directory / 'cache')
        env['PLAYWRIGHT_BROWSERS_PATH'] = str(directory / 'cache/browsers')
    read_gate, write_gate = os.pipe()
    # Popen itself starts only a trusted gate. Persist the owned process group
    # before any checkout command can run. Supervisor death before release
    # closes the pipe and the gate exits without executing the requested action.
    gate_code = ('import os,sys\nfd=int(sys.argv[1])\nrelease=os.read(fd,1)\nos.close(fd)\n'
                 'if release!=b"1": sys.exit(125)\n'
                 'os.execvpe(sys.argv[2],sys.argv[2:],os.environ)\n')
    process = None
    try:
        process = subprocess.Popen([sys.executable, '-I', '-c', gate_code, str(read_gate), *args],
                                   cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   start_new_session=True, pass_fds=(read_gate,))
        os.close(read_gate)
        read_gate = None
        save(directory / 'receipts' / (active['nonce'] + '.running.json'),
             {'pid': process.pid, 'birth': process_birth(process.pid)})
        if (directory / 'cancelled.json').exists():
            fail('workflow_cancelled')
        if time.monotonic() >= deadline:
            fail('timeout')
        os.write(write_gate, b'1')
    except Exception:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            process.stdout.close()
        raise
    finally:
        if read_gate is not None:
            os.close(read_gate)
        os.close(write_gate)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    outcome, stop_at, written = None, None, 0
    try:
        while selector.get_map() or process.poll() is None:
            if outcome is None and ((directory / 'cancelled.json').exists() or time.monotonic() >= deadline):
                outcome = 'cancelled' if (directory / 'cancelled.json').exists() else 'timeout'
                stop_at = time.monotonic()
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            if stop_at is not None and time.monotonic() - stop_at >= 2:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if time.monotonic() - stop_at >= 5:
                    fail('process_tree_unconfirmed')
            for key, _ in selector.select(0.1):
                data = os.read(key.fd, 65536)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    available = MAX_LOG - log.tell()
                    if available > 0:
                        log.write(data[:available])
                    written += len(data)
            if process.poll() is not None and not selector.get_map():
                break
        code = process.wait()
        if outcome:
            fail(outcome)
        if code:
            fail('command_failed')
    finally:
        selector.close()
        process.stdout.close()
        if outcome is not None or process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        (directory / 'receipts' / (active['nonce'] + '.running.json')).unlink(missing_ok=True)


def execute_step(directory, state, active, log):
    workspace = directory / 'workspace'
    step = active['step']
    deadline = time.monotonic() + TIMEOUTS[step]
    if step == 'publish':
        publish_step(directory, state, active, log, deadline)
    elif step == 'scan':
        with tempfile.TemporaryDirectory(prefix='publication-', dir=directory) as temp:
            tree = Path(temp)
            if snapshot(workspace, tree) != state['input']:
                fail('checkout_changed')
            config = directory / 'scanner.toml'
            atomic(config, b'[extend]\nuseDefault = true\n')
            ignore = directory / 'scanner.ignore'
            atomic(ignore, b'')
            common = ['gitleaks', '--no-banner', '--no-color', '--redact=100', '--ignore-gitleaks-allow',
                      '--config', str(config), '--gitleaks-ignore-path', str(ignore), '--timeout', '300']
            run_command(directory, active, common + ['dir', str(tree)], directory, log, deadline)
            run_command(directory, active, common + ['git', str(workspace), '--log-opts',
                        state['baseCommit'] + '..' + state['input']['head']], directory, log, deadline)
    else:
        for args, cwd in command_plan(step, workspace):
            run_command(directory, active, args, cwd, log, deadline)


def prepush_hook(directory, state):
    hooks = directory / 'hooks'
    hooks.mkdir(mode=0o700, exist_ok=True)
    expected = state['expectedRemote'] or '0' * 40
    # Exact numeric/hex/ref literals only, no shell interpolation from repository content.
    spec = {'head': state['input']['head'], 'expected': expected, 'ref': 'refs/heads/' + state['branch']}
    source = ('#!' + sys.executable + '\nimport json,sys\ns=' + repr(spec) + '\n'
              'rows=[x.split() for x in sys.stdin.read(4097).splitlines()]\n'
              'ok=len(rows)==1 and len(rows[0])==4 and rows[0][1]==s["head"] '
              'and rows[0][2]==s["ref"] and rows[0][3]==s["expected"]\n'
              'sys.exit(0 if ok else 1)\n')
    atomic(hooks / 'pre-push', source.encode())
    (hooks / 'pre-push').chmod(0o700)
    return hooks


def publish_step(directory, state, active, log, deadline):
    default = private_repo(state['repository'])
    if state['branch'] == default:
        fail('protected_branch')
    if digest(read_bytes(directory / 'workspace/.git/config')) != state['gitConfigSha256']:
        fail('git_configuration_changed')
    current = remote_ref(state['repository'], state['branch'])
    head = state['input']['head']
    if current == head:
        return  # Transport reconciliation: never repeat a confirmed exact commit.
    if current != state['expectedRemote']:
        fail('remote_changed_no_overwrite')
    workspace = directory / 'workspace'
    capture(git_args('-C', str(workspace), 'merge-base', '--is-ancestor', state['baseCommit'], head))
    hooks = prepush_hook(directory, state)
    args = git_args('-C', str(workspace), 'push', '--porcelain', '--no-follow-tags',
                    'https://github.com/' + state['repository'] + '.git',
                    head + ':refs/heads/' + state['branch'], hooks=hooks)
    # Even a nonzero/timeout response may have reached GitHub. Receipt requires a read-back.
    transport_error = None
    try:
        run_command(directory, active, args, workspace, log, deadline, auth=True)
    except ValueError as error:
        transport_error = str(error)
    if (directory / 'cancelled.json').exists():
        fail('cancelled_publication_outcome_unconfirmed')
    observed = remote_ref(state['repository'], state['branch'])
    if observed == head:
        return
    if observed != state['expectedRemote']:
        fail('remote_changed_no_overwrite')
    fail('push_unconfirmed' if transport_error else 'push_not_observed')


def step_child(directory, state, active, gate, inherited_lock):
    os.close(inherited_lock)
    # The parent records our identity before releasing this gate. No command can start earlier.
    if os.read(gate, 1) != b'1':
        os._exit(0)
    os.close(gate)
    started = time.time()
    outcome, reason = 'succeeded', None
    log_path = directory / 'logs' / (active['nonce'] + '.log')
    try:
        with os.fdopen(os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600), 'wb') as log:
            if (directory / 'cancelled.json').exists():
                fail('workflow_cancelled')
            if implementation_hash() != state['implementationSha256'] or snapshot(directory / 'workspace') != state['input']:
                fail('checkout_changed')
            execute_step(directory, state, active, log)
            log.flush()
            os.fsync(log.fileno())
            if (snapshot(directory / 'workspace') != state['input'] or
                    digest(read_bytes(directory / 'workspace/.git/config')) != state['gitConfigSha256']):
                fail('checkout_changed')
    except Exception as error:
        outcome = 'cancelled' if (directory / 'cancelled.json').exists() else 'failed'
        reason = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z_]+', str(error)) else 'step_error'
    value = {'version': VERSION, 'nonce': active['nonce'], 'step': active['step'], 'input': state['input'],
             'implementationSha256': state['implementationSha256'], 'generation': state['generation'],
             'startedAt': started, 'completedAt': time.time(), 'outcome': outcome, 'reason': reason}
    save(directory / 'receipts' / (active['nonce'] + '.json'), value)
    os._exit(0)


def launch(directory, state, step, lock):
    count = state['attempts'].get(step, 0)
    if count >= 2:
        fail('step_attempts_exhausted')
    active = {'nonce': uuid.uuid4().hex, 'step': step, 'startedAt': time.time(), 'pid': None, 'birth': None}
    state['attempts'][step] = count + 1
    state['active'] = active
    state['status'] = 'running'
    write_state(directory, state)
    read_gate, write_gate = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(write_gate)
        step_child(directory, state, active, read_gate, lock)
    os.close(read_gate)
    try:
        active['pid'] = pid
        active['birth'] = process_birth(pid)
        write_state(directory, state)
        os.write(write_gate, b'1')
    finally:
        os.close(write_gate)
    os.waitpid(pid, 0)
    reconcile(directory, state)
    if step not in state['receipts']:
        fail('step_did_not_succeed')


def run(root, task, publish=False):
    directory = task_dir(root, task)
    with locked(directory) as lock:
        state = state_at(directory)
        reconcile(directory, state)
        check_current(directory, state)
        if publish:
            if any(step not in state['receipts'] for step in STEPS):
                fail('required_checks_missing')
            if state['attempts'].get('publish', 0) >= 2 and 'publish' not in state['receipts']:
                # Exhausting execution attempts still permits read-only confirmation.
                if private_repo(state['repository']) == state['branch']:
                    fail('protected_branch')
                if remote_ref(state['repository'], state['branch']) != state['input']['head']:
                    fail('step_attempts_exhausted')
                confirmed = {'version': VERSION, 'nonce': uuid.uuid4().hex, 'step': 'publish',
                             'input': state['input'], 'implementationSha256': state['implementationSha256'],
                             'generation': state['generation'], 'startedAt': time.time(),
                             'completedAt': time.time(), 'outcome': 'succeeded',
                             'reason': 'remote_exact_commit_confirmed_without_push'}
                save(directory / 'receipts' / (confirmed['nonce'] + '.json'), confirmed)
                state['receipts']['publish'] = confirmed
                state['history'].append(confirmed)
                write_state(directory, state)
            steps = ('publish',)
        else:
            steps = STEPS
        for step in steps:
            if step not in state['receipts']:
                launch(directory, state, step, lock)
                if check_current(directory, state):
                    fail('inputs_changed_checks_invalidated')
        state['status'] = 'published' if 'publish' in state['receipts'] else 'verified'
        write_state(directory, state)
        return status(root, task)


def cancel(root, task):
    directory = task_dir(root, task)
    # A durable marker is checked by the active supervisor, which signals only its owned process group.
    save(directory / 'cancelled.json', {'cancelledAt': time.time()})
    return {'taskId': task, 'status': 'cancel_requested', 'resumeAllowed': False}


def status(root, task):
    directory = task_dir(root, task)
    state = state_at(directory)
    return {'taskId': task, 'status': 'cancelled' if (directory / 'cancelled.json').exists() else state['status'],
            'generation': state['generation'], 'head': state['input']['head'],
            'completedSteps': list(state['receipts']), 'activeStep': (state.get('active') or {}).get('step'),
            'publication': 'confirmed' if 'publish' in state['receipts'] else 'not_confirmed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, help='Private state directory outside every source checkout')
    commands = parser.add_subparsers(dest='action', required=True)
    initial = commands.add_parser('prepare')
    initial.add_argument('--source', required=True)
    initial.add_argument('--repo', required=True)
    initial.add_argument('--branch', required=True)
    initial.add_argument('--base-ref', help='Read-only starting branch for a new feature target; default is repository default branch')
    for name in ('run', 'resume', 'publish', 'cancel', 'status'):
        commands.add_parser(name).add_argument('task_id')
    args = parser.parse_args()
    try:
        if args.action == 'prepare':
            result = prepare(args.state, args.source, args.repo, args.branch, args.base_ref)
        elif args.action in ('run', 'resume', 'publish'):
            result = run(args.state, args.task_id, publish=args.action == 'publish')
        elif args.action == 'cancel':
            result = cancel(args.state, args.task_id)
        else:
            result = status(args.state, args.task_id)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r'[a-z_]+', str(error)) else 'workflow_error'
        print(json.dumps({'error': code}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
