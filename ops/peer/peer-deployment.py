#!/usr/bin/env python3
"""Private, operator-run deployment of the headless peer; never executes a job.

The source is generic. Plans, receipts, backups and release trees are private
operator files outside Git. Inspect/prepare do not mutate a running instance.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import plistlib
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
import uuid

SCHEMA = 1
POINTER = '.peer-code-current'
PRIVATE_TOP = {'.env', '.git', '.ssh', '.codex', 'data', 'store', 'groups',
               'logs', 'owner-context', '.peer-installation.json', POINTER}
TERMINAL = {'succeeded', 'failed', 'cancelled', 'rejected', 'expired', 'interrupted',
            'needs_review', 'accepted', 'delivered'}
REQUIRED_BUILD_CHECKS = ('install_root', 'install_runner', 'pinned_cli', 'browser',
                         'build', 'typecheck', 'tests', 'peer', 'deployment',
                         'release_builder', 'native_runtime', 'native_sqlite', 'worker_adapter')


def fail(code):
    raise RuntimeError(code)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def directory(path):
    path = Path(path).absolute()
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or path.resolve() != path or s.st_uid != os.getuid() or s.st_mode & 0o022:
        fail('unsafe_directory')
    return path


def regular(path, private=False):
    p = Path(path)
    s = p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_nlink != 1 or s.st_uid != os.getuid() or s.st_mode & (0o077 if private else 0o022):
        fail('unsafe_file')
    return p


def read_json(path, private=True):
    p = regular(path, private)
    if p.stat().st_size > 16 * 1024 * 1024:
        fail('oversize_json')
    return json.loads(p.read_text())


def save(path, value, exclusive=False):
    p = Path(path)
    directory(p.parent)
    tmp = p.with_name('.' + p.name + '.' + uuid.uuid4().hex)
    data = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if exclusive:
            os.link(tmp, p, follow_symlinks=False)
            tmp.unlink()
        else:
            if p.exists():
                regular(p, True)
            os.replace(tmp, p)
        fd = os.open(p.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if tmp.exists():
            tmp.unlink()


def contained(p, root):
    return p == root or root in p.parents


def tree_record(path, containment=None):
    """Hash names, modes, regular bytes and link text without following links."""
    path = Path(path)
    h = hashlib.sha256()
    count = size = 0
    def visit(p, relative):
        nonlocal count, size
        s = p.lstat()
        if s.st_uid != os.getuid():
            fail('foreign_tree_owner')
        mode = stat.S_IMODE(s.st_mode)
        if stat.S_ISLNK(s.st_mode):
            text = os.readlink(p)
            if containment is not None and (os.path.isabs(text) or not contained(p.resolve(), containment)):
                fail('release_symlink_escape')
            item = ['link', relative, mode, text]
        elif stat.S_ISDIR(s.st_mode):
            if mode & 0o022:
                fail('writable_release_directory')
            item = ['dir', relative, mode]
        elif stat.S_ISREG(s.st_mode):
            if s.st_nlink != 1 or mode & 0o022:
                fail('unsafe_release_regular')
            before = (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            hashed = digest(p)
            a = p.lstat()
            if before != (a.st_dev, a.st_ino, a.st_size, a.st_mtime_ns, a.st_ctime_ns):
                fail('tree_changed_while_hashing')
            item = ['file', relative, mode, s.st_size, hashed]
            count += 1
            size += s.st_size
        else:
            fail('special_file_in_release')
        h.update(json.dumps(item, ensure_ascii=False, separators=(',', ':')).encode() + b'\n')
        if stat.S_ISDIR(s.st_mode):
            for child in sorted(p.iterdir(), key=lambda x: x.name):
                visit(child, relative + '/' + child.name)
    visit(path, '.')
    return {'sha256': h.hexdigest(), 'files': count, 'bytes': size}


def release_record(release):
    release = directory(release)
    names = sorted(p.name for p in release.iterdir())
    if not names or any(name in PRIVATE_TOP or name.startswith('.peer-install') for name in names):
        fail('private_state_in_release')
    required = {'package.json', 'node_modules', 'dist', 'agent', 'packages', 'ops', 'scripts', 'runtime', 'helper'}
    if not required.issubset(names):
        fail('incomplete_release')
    return {'entries': names, 'tree': tree_record(release, release)}


def command(args, timeout=30, env=None, cwd=None):
    p = subprocess.run([str(x) for x in args], capture_output=True, timeout=timeout, env=env, cwd=cwd)
    if p.returncode:
        fail('command_failed_' + Path(str(args[0])).name)
    return p.stdout.decode(errors='replace')


def service(label):
    if not re.fullmatch(r'com\.skoobi\.peer\.[A-Za-z0-9_.-]+\.(worker|helper)', label):
        fail('unexpected_service_label')
    p = Path.home() / 'Library/LaunchAgents' / (label + '.plist')
    regular(p, True)
    value = plistlib.loads(p.read_bytes())
    if value.get('Label') != label:
        fail('service_identity_mismatch')
    out = subprocess.run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'], capture_output=True, text=True)
    pid_match = re.search(r'^\s*pid = (\d+)\s*$', out.stdout, re.M)
    return {'label': label, 'path': str(p), 'sha256': digest(p), 'loaded': out.returncode == 0,
            'pid': int(pid_match[1]) if pid_match else None, 'definition': value}


def job_snapshot(root):
    jobs = root / 'jobs'
    result = {}
    if not jobs.exists():
        return result
    directory(jobs)
    for item in sorted(jobs.iterdir()):
        if item.name.startswith('.'):
            continue
        if not re.fullmatch(r'[0-9a-f-]{36}', item.name):
            fail('unexpected_job_entry')
        directory(item)
        data = read_json(item / 'state.json')
        if data.get('id') != item.name or not isinstance(data.get('state'), str):
            fail('unreadable_job_state')
        result[item.name] = {'state': data['state'], 'schema': data.get('schema', 1),
                             'stateSha256': digest(item / 'state.json')}
    return result


def assert_idle(config):
    states = job_snapshot(Path(config['stateRoot']))
    if any(value['state'] not in TERMINAL for value in states.values()):
        fail('worker_has_pending_or_running_jobs')
    p = Path(config['stateRoot']) / 'heartbeat.json'
    if p.exists():
        heartbeat = read_json(p)
        if heartbeat.get('currentJobId'):
            fail('worker_heartbeat_busy')
    return states


def inventory(root):
    root = directory(root)
    config_path = root / 'data/peer-network/worker.json'
    config = read_json(config_path)
    if config.get('role') != 'worker' or Path(config.get('projectRoot', '')).resolve() != root:
        fail('not_expected_worker')
    state = directory(config['stateRoot'])
    if not contained(state, root / 'data/peer-network'):
        fail('worker_state_outside_instance')
    node = regular(config['nodeCommand'])
    auth = regular(config.get('authJsonPath') or Path.home() / '.codex/auth.json', True)
    if not contained(auth.resolve(), Path.home().resolve()):
        fail('own_user_auth_required')
    env = dict(os.environ, PATH=str(node.parent) + ':/usr/bin:/bin:/usr/sbin:/sbin')
    result = {'schema': SCHEMA, 'root': str(root), 'configPath': str(config_path),
              'configSha256': digest(config_path), 'environmentSha256': digest(regular(root / '.env', True)),
              'nodeCommand': str(node), 'nodeSha256': digest(node),
              'authJsonPath': str(auth), 'authSha256': digest(auth),
              'nodeVersion': command([node, '--version'], env=env).strip(),
              'model': config['model'], 'reasoningEffort': config['reasoningEffort'],
              'services': [service(config['label']), service(config['helperLabel'])],
              'jobs': job_snapshot(state), 'stateRoot': str(state)}
    result['pointer'] = os.readlink(root / POINTER) if (root / POINTER).is_symlink() else None
    return result


def patch_environment(before, command_path):
    text = before.decode('utf-8')
    lines = text.splitlines(keepends=True)
    hits = [i for i, line in enumerate(lines) if re.match(r'^SKOOBI_CODEX_COMMAND\s*=', line)]
    if len(hits) != 1:
        fail('codex_environment_binding_not_unique')
    index = hits[0]
    ending = '\r\n' if lines[index].endswith('\r\n') else '\n'
    lines[index] = 'SKOOBI_CODEX_COMMAND=' + json.dumps(command_path) + ending
    return ''.join(lines).encode()


def replace_bytes(path, expected, data):
    p = regular(path, True)
    if digest(p) != expected:
        fail('private_configuration_changed')
    tmp = p.with_name('.' + p.name + '.' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, stat.S_IMODE(p.stat().st_mode))
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        if digest(p) != expected:
            fail('private_configuration_changed')
        os.replace(tmp, p)
    finally:
        if tmp.exists(): tmp.unlink()


def prepare(root, release, receipt_path, plan_path, enable_gui=False):
    root = directory(root); release = directory(release)
    if contained(release, root) or root.stat().st_dev != release.stat().st_dev:
        fail('release_must_be_external_same_volume')
    receipt = read_json(receipt_path)
    record = release_record(release)
    if receipt.get('releaseRecord') != record or receipt.get('status') != 'verified' or receipt.get('protocol') != 2:
        fail('release_receipt_mismatch')
    checks = receipt.get('checks', {})
    if not all(checks.get(key) is True for key in ('nativeRuntime', 'build', 'tests', 'workerAdapter', 'privateStateExcluded')):
        fail('release_checks_incomplete')
    inv = inventory(root)
    if receipt.get('nodeSha256') != inv['nodeSha256']:
        fail('native_build_node_differs_from_worker')
    received_checks = receipt.get('checkReceipts', [])
    if not isinstance(received_checks, list) or len(received_checks) != len(REQUIRED_BUILD_CHECKS):
        fail('native_build_receipts_missing')
    for label in REQUIRED_BUILD_CHECKS:
        matching = [entry for entry in received_checks if entry.get('check') == label]
        if len(matching) != 1 or matching[0].get('exitCode') != 0:
            fail('native_build_receipt_failed')
        log = Path(receipt_path).parent / 'checks' / (label + '.private.log')
        regular(log, True)
        if log.stat().st_size != matching[0].get('logBytes') or digest(log) != matching[0].get('logSha256'):
            fail('native_build_log_changed')
    if not re.fullmatch(r'[0-9a-f]{40}', receipt.get('sourceCommit', '')):
        fail('release_source_identity_missing')
    if not all(s['loaded'] and s['pid'] for s in inv['services']):
        fail('worker_services_not_running')
    config = read_json(inv['configPath'])
    existing = {}
    for name in record['entries']:
        p = root / name
        if p.exists() or p.is_symlink():
            if p.is_symlink() and os.readlink(p) != POINTER + '/' + name:
                fail('unmanaged_code_symlink_collision')
            existing[name] = tree_record(p)
        else:
            existing[name] = None
    target = directory(Path(plan_path).parent)
    if contained(target, root) or contained(target, release):
        fail('deployment_plan_inside_managed_tree')
    manifest = read_json(release / 'runtime/codex-toolchain.json', False)
    if manifest.get('version') != receipt.get('cliVersion'):
        fail('release_cli_version_mismatch')
    cli = str(root / manifest['destination'] / manifest['launcher'])
    changed = dict(config, protocol=2, codexCommand=cli, authJsonPath=inv['authJsonPath'])
    if enable_gui:
        changed['allowGui'] = True  # Each GUI task still requires its explicit bounded slot.
    after_env = patch_environment((root / '.env').read_bytes(), cli)
    plan = {'schema': SCHEMA, 'status': 'prepared', 'helperSha256': digest(__file__),
            'root': str(root), 'release': str(release), 'releaseRecord': record,
            'receiptPath': str(Path(receipt_path).absolute()), 'receiptSha256': digest(receipt_path),
            'inventory': inv, 'existingCode': existing, 'createdAt': time.time(),
            'configAfter': changed, 'environmentAfterSha256': hashlib.sha256(after_env).hexdigest(),
            'converted': [], 'pendingConversion': None, 'afterConfigHashes': {},
            'newProtocol': 2, 'previousProtocol': 2 if inv['pointer'] else 1}
    if inv['pointer']:
        previous = (root / inv['pointer']).resolve()
        plan['previousRelease'] = str(directory(previous))
        plan['previousReleaseRecord'] = release_record(previous)
    save(plan_path, plan, True)
    return {'status': 'prepared', 'codeEntries': len(existing), 'liveMutated': False}


def load_plan(path):
    p = regular(path, True); plan = read_json(p)
    if plan.get('schema') != SCHEMA or plan.get('helperSha256') != digest(__file__):
        fail('reviewed_controller_changed')
    directory(p.parent); directory(plan['root']); directory(plan['release'])
    if digest(plan['receiptPath']) != plan['receiptSha256']:
        fail('release_receipt_changed')
    return p, plan


@contextlib.contextmanager
def locked(plan_path):
    path = Path(plan_path).parent / 'deployment.guard'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or s.st_mode & 0o077:
            fail('unsafe_deployment_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def validate_baseline(plan):
    root = Path(plan['root']); inv = plan['inventory']
    if digest(root / '.env') != inv['environmentSha256'] or digest(inv['configPath']) != inv['configSha256']:
        fail('configuration_changed_since_prepare')
    if digest(inv['nodeCommand']) != inv['nodeSha256']:
        fail('node_changed_since_prepare')
    if digest(regular(inv['authJsonPath'], True)) != inv['authSha256']:
        fail('own_auth_changed_since_prepare')
    for s in inv['services']:
        if digest(s['path']) != s['sha256']:
            fail('service_changed_since_prepare')
    if release_record(plan['release']) != plan['releaseRecord']:
        fail('release_changed_since_prepare')
    pointer = root / POINTER
    if plan['inventory']['pointer']:
        if not pointer.is_symlink() or os.readlink(pointer) != plan['inventory']['pointer']:
            fail('release_pointer_changed')
        if release_record(plan['previousRelease']) != plan['previousReleaseRecord']:
            fail('previous_release_changed')
    elif pointer.exists() or pointer.is_symlink():
        fail('release_pointer_collision')
    for name, expected in plan['existingCode'].items():
        p = root / name
        current = tree_record(p) if p.exists() or p.is_symlink() else None
        if current != expected:
            fail('code_changed_since_prepare')


def process_alive(pid):
    if pid is None: return False
    if not isinstance(pid, int) or pid <= 1: fail('invalid_service_pid')
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True


def stop_services(plan):
    for s in plan['inventory']['services']:
        current = service(s['label'])
        if current['sha256'] != s['sha256']:
            fail('service_changed_before_stop')
        if current['loaded']:
            command(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{s["label"]}'])
        deadline = time.monotonic() + 20
        # launchd can unload a job while its former process still handles TERM.
        # A reused PID conservatively blocks; never kill a possibly new owner.
        while service(s['label'])['loaded'] or process_alive(current['pid']):
            if time.monotonic() > deadline: fail('service_did_not_stop')
            time.sleep(.1)


def backup_state(plan, folder):
    root = Path(plan['root']); folder.mkdir(mode=0o700)
    for name in ('.env',):
        shutil.copy2(root / name, folder / name)
    shutil.copy2(plan['inventory']['configPath'], folder / 'worker-config.json')
    for s in plan['inventory']['services']:
        shutil.copy2(s['path'], folder / (s['label'] + '.plist'))
    # A consistent database backup, never an implicit restore after activation.
    db_path = root / 'store/messages.db'
    if db_path.exists():
        regular(db_path, True)
        source = sqlite3.connect(db_path.as_uri() + '?mode=ro', uri=True)
        target = sqlite3.connect(folder / 'messages.db')
        try:
            source.backup(target)
            if target.execute('PRAGMA quick_check').fetchone()[0] != 'ok': fail('database_backup_invalid')
        finally:
            target.close(); source.close()
        os.chmod(folder / 'messages.db', 0o600)
    # Jobs, context and artifact history are copied using APFS; live copies stay put.
    command(['/bin/cp', '-c', '-R', plan['inventory']['stateRoot'], folder / 'peer-state'], timeout=120)


def switch_pointer(root, release):
    root = directory(root); release = directory(release)
    pointer = root / POINTER
    if pointer.exists() and not pointer.is_symlink(): fail('pointer_collision')
    tmp = root / (POINTER + '.' + uuid.uuid4().hex)
    tmp.symlink_to(os.path.relpath(release, root))
    os.replace(tmp, pointer)
    fd = os.open(root, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def convert_code(plan_path, plan):
    root = Path(plan['root']); old = plan_path.parent / 'previous-code'
    if not old.exists(): old.mkdir(mode=0o700)
    if not plan['inventory']['pointer']:
        for name, previous in plan['existingCode'].items():
            if name in plan['converted']: continue
            source = root / name; destination = old / name
            plan['pendingConversion'] = name; save(plan_path, plan)
            if destination.exists() or destination.is_symlink(): fail('backup_code_collision')
            if previous is not None:
                if tree_record(source) != previous: fail('code_changed_before_conversion')
                source.rename(destination)
            elif source.exists() or source.is_symlink(): fail('new_code_collision')
            source.symlink_to(POINTER + '/' + name)
            plan['converted'].append(name); plan['pendingConversion'] = None; save(plan_path, plan)
    switch_pointer(root, plan['release'])
    plan['status'] = 'code_switched'; save(plan_path, plan)


def configured_files(plan_path, plan):
    root = Path(plan['root']); inv = plan['inventory']; backup = plan_path.parent / 'backup'
    mappings = [(root / '.env', inv['environmentSha256'],
                 patch_environment((backup / '.env').read_bytes(), plan['configAfter']['codexCommand'])),
                (Path(inv['configPath']), inv['configSha256'],
                 (json.dumps(plan['configAfter'], ensure_ascii=False, indent=2) + '\n').encode())]
    browser = root / POINTER / '.peer-browsers'
    if browser.is_dir():
        for s in inv['services']:
            content = dict(s['definition']); env = dict(content.get('EnvironmentVariables', {}))
            env['PLAYWRIGHT_BROWSERS_PATH'] = str(browser); content['EnvironmentVariables'] = env
            mappings.append((Path(s['path']), s['sha256'], plistlib.dumps(content)))
    for p, before, data in mappings:
        after = hashlib.sha256(data).hexdigest()
        plan['afterConfigHashes'][str(p)] = after; save(plan_path, plan)
        if digest(p) == after: continue
        replace_bytes(p, before, data)
    plan['status'] = 'configured'; save(plan_path, plan)


def start_services(plan_path, plan):
    for s in reversed(plan['inventory']['services']):
        command(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', s['path']])
    plan['status'] = 'started'; plan['startedAt'] = time.time(); save(plan_path, plan)
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        states = [service(s['label']) for s in plan['inventory']['services']]
        if all(s['loaded'] and s['pid'] and s['pid'] != old['pid'] for s, old in zip(states, plan['inventory']['services'])):
            heartbeat = read_json(Path(plan['inventory']['stateRoot']) / 'heartbeat.json')
            if heartbeat.get('pid') == states[0]['pid'] and not heartbeat.get('currentJobId'):
                plan['newPids'] = [s['pid'] for s in states]
                plan['status'] = 'started_maintenance'; save(plan_path, plan)
                return
        time.sleep(.5)
    fail('new_service_health_unconfirmed')


def activate(plan_path, coordinator_receipt):
    with locked(plan_path):
        path, plan = load_plan(plan_path)
        if plan['status'] != 'prepared': fail('activation_requires_prepared_plan')
        # Operator supplies a concrete receipt only after quiescing Mini's producer.
        receipt = read_json(coordinator_receipt)
        checked = receipt.get('checkedAt')
        if receipt.get('status') != 'quiesced' or receipt.get('newSubmissionsAllowed') is not False or not isinstance(checked, (int, float)) or not math.isfinite(checked) or not -10 <= time.time() - checked <= 120:
            fail('fresh_coordinator_quiescence_required')
        validate_baseline(plan)
        config = read_json(plan['inventory']['configPath']); before_jobs = assert_idle(config)
        gate = Path(config['stateRoot']) / 'maintenance.json'
        token = uuid.uuid4().hex + uuid.uuid4().hex
        value = {'schema': 1, 'tokenSha256': hashlib.sha256(token.encode()).hexdigest(),
                 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                 'expiresAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + 3600))}
        plan['maintenanceGate'] = value; plan['coordinatorReceiptSha256'] = digest(coordinator_receipt)
        plan['status'] = 'quiescing'; save(path, plan)
        save(gate, value, True)
        stop_services(plan)
        if assert_idle(config) != before_jobs: fail('jobs_changed_while_stopping')
        plan['activationJobs'] = before_jobs; plan['status'] = 'stopped'; save(path, plan)
        backup_state(plan, path.parent / 'backup')
        if assert_idle(config) != before_jobs: fail('jobs_changed_during_backup')
        convert_code(path, plan)
        configured_files(path, plan)
        start_services(path, plan)
        return {'status': plan['status'], 'jobsRetained': len(before_jobs), 'maintenanceStillClosed': True}


def release_maintenance(plan_path, validation_path):
    with locked(plan_path):
        path, plan = load_plan(plan_path)
        if plan['status'] != 'started_maintenance': fail('not_waiting_for_validation')
        validation = read_json(validation_path)
        if validation.get('releaseTreeSha256') != plan['releaseRecord']['tree']['sha256'] or not all(validation.get(k) is True for k in ('actualRuntimeVerified', 'rpcHealthVerified', 'configurationPreserved', 'isolatedSmokePassed')):
            fail('postdeploy_validation_incomplete')
        if release_record(plan['release']) != plan['releaseRecord']:
            fail('release_changed_before_smoke')
        assert_current_configuration(plan)
        assert_idle(read_json(plan['inventory']['configPath']))
        gate = Path(plan['inventory']['stateRoot']) / 'maintenance.json'
        if read_json(gate) != plan['maintenanceGate']: fail('maintenance_gate_changed')
        gate.unlink()
        plan['status'] = 'smoke_ready'; plan['validationSha256'] = digest(validation_path); save(path, plan)
        return {'status': 'smoke_ready', 'coordinatorStillRequiresExplicitResume': True}


def assert_current_configuration(plan):
    root = Path(plan['root']); inv = plan['inventory']
    expected = {str(root / '.env'): inv['environmentSha256'], inv['configPath']: inv['configSha256']}
    expected.update({s['path']: s['sha256'] for s in inv['services']})
    expected.update(plan['afterConfigHashes'])
    for target, hashed in expected.items():
        if digest(regular(target, True)) != hashed: fail('deployed_configuration_changed')
    pointer = root / POINTER
    if not pointer.is_symlink() or pointer.resolve() != Path(plan['release']): fail('deployed_pointer_changed')


def complete(plan_path, validation_path):
    with locked(plan_path):
        path, plan = load_plan(plan_path)
        if plan['status'] != 'smoke_ready': fail('not_waiting_for_quiet_smoke')
        validation = read_json(validation_path)
        if validation.get('releaseTreeSha256') != plan['releaseRecord']['tree']['sha256'] or not all(validation.get(k) is True for k in ('quietSmokePassed', 'notifyDisabled', 'artifactCriteriaPassed', 'noExternalDelivery')):
            fail('quiet_smoke_validation_incomplete')
        if any(not service(s['label'])['pid'] for s in plan['inventory']['services']):
            fail('service_unavailable_after_smoke')
        assert_current_configuration(plan)
        assert_idle(read_json(plan['inventory']['configPath']))
        plan['status'] = 'deployed'; plan['smokeValidationSha256'] = digest(validation_path); save(path, plan)
        return {'status': 'deployed', 'coordinatorRequiresExplicitResume': True}


def restore_initial_code(path, plan):
    root = Path(plan['root']); old = path.parent / 'previous-code'
    # Journal before each rename makes an interruption recoverable without guessing.
    for name, previous in reversed(list(plan['existingCode'].items())):
        source = root / name; saved = old / name
        if saved.exists() or saved.is_symlink():
            if tree_record(saved) != previous: fail('saved_code_changed')
            if source.is_symlink() and os.readlink(source) == POINTER + '/' + name:
                source.unlink()
            elif source.exists() or source.is_symlink(): fail('rollback_code_collision')
            saved.rename(source)
        elif previous is None:
            if source.is_symlink() and os.readlink(source) == POINTER + '/' + name: source.unlink()
            elif source.exists() or source.is_symlink(): fail('rollback_new_path_collision')
        elif tree_record(source) != previous:
            fail('original_code_unrecoverable')
    pointer = root / POINTER
    if pointer.is_symlink():
        if pointer.resolve() != Path(plan['release']): fail('rollback_pointer_changed')
        pointer.unlink()


def rollback(plan_path):
    with locked(plan_path):
        path, plan = load_plan(plan_path)
        if plan['status'] in ('prepared', 'rolled_back'): fail('nothing_to_rollback')
        root = Path(plan['root']); inv = plan['inventory']; config = read_json(inv['configPath'])
        jobs = assert_idle(config)
        if plan['previousProtocol'] < 2 and (jobs != plan.get('activationJobs', inv['jobs'])):
            fail('legacy_rollback_cannot_resume_changed_job_history')
        if inv['pointer'] and release_record(plan['previousRelease']) != plan['previousReleaseRecord']:
            fail('previous_release_changed')
        gate = Path(inv['stateRoot']) / 'maintenance.json'
        if gate.exists() and read_json(gate) != plan['maintenanceGate']: fail('maintenance_gate_changed')
        # Refuse late user changes before touching services/code.
        backups = {str(root / '.env'): path.parent / 'backup/.env',
                   inv['configPath']: path.parent / 'backup/worker-config.json'}
        backups.update({s['path']: path.parent / 'backup' / (s['label'] + '.plist') for s in inv['services']})
        if plan['status'] in ('quiescing', 'stopped') and not all(p.exists() for p in backups.values()):
            validate_baseline(plan)
            if read_json(gate) != plan['maintenanceGate']: fail('maintenance_gate_changed')
            gate.unlink()
            for s in reversed(inv['services']):
                if not service(s['label'])['loaded']:
                    command(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', s['path']])
            plan['status'] = 'rolled_back'; save(path, plan)
            return {'status': 'rolled_back', 'liveStateRestoredFromBackup': False}
        for target, backup in backups.items():
            allowed = {digest(backup), plan['afterConfigHashes'].get(target)}
            if digest(target) not in allowed: fail('rollback_preserves_late_configuration_edit')
        if not gate.exists(): save(gate, plan['maintenanceGate'], True)
        # A changed plist is expected only when it matches our exact written bytes.
        for s in inv['services']:
            if service(s['label'])['loaded']:
                command(['/bin/launchctl', 'bootout', f'gui/{os.getuid()}/{s["label"]}'])
        if assert_idle(config) != jobs: fail('jobs_changed_before_rollback')
        if inv['pointer']:
            previous = (root / inv['pointer']).resolve()
            switch_pointer(root, previous)
        else:
            restore_initial_code(path, plan)
        for target, backup in backups.items():
            if digest(target) != digest(backup): replace_bytes(target, plan['afterConfigHashes'][target], backup.read_bytes())
        # Never restore messages.db or peer job data: new user facts/results survive.
        if read_json(gate) != plan['maintenanceGate']: fail('maintenance_gate_changed')
        gate.unlink()
        for s in reversed(inv['services']): command(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', s['path']])
        plan['status'] = 'rolled_back'; save(path, plan)
        return {'status': 'rolled_back', 'liveStateRestoredFromBackup': False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    inspect = commands.add_parser('inventory'); inspect.add_argument('--root', required=True); inspect.add_argument('--output', required=True)
    prep = commands.add_parser('prepare')
    for arg in ('root', 'release', 'receipt', 'plan'): prep.add_argument('--' + arg, required=True)
    prep.add_argument('--enable-gui', action='store_true', help='Preserve approved GUI capability; individual tasks still require an explicit slot.')
    act = commands.add_parser('activate'); act.add_argument('--plan', required=True); act.add_argument('--coordinator-receipt', required=True)
    finish = commands.add_parser('release-maintenance'); finish.add_argument('--plan', required=True); finish.add_argument('--validation', required=True)
    done = commands.add_parser('complete'); done.add_argument('--plan', required=True); done.add_argument('--validation', required=True)
    roll = commands.add_parser('rollback'); roll.add_argument('--plan', required=True)
    args = parser.parse_args()
    if args.action == 'inventory': save(args.output, inventory(args.root), True); result = {'status': 'inventory_saved', 'liveMutated': False}
    elif args.action == 'prepare': result = prepare(args.root, args.release, args.receipt, args.plan, args.enable_gui)
    elif args.action == 'activate': result = activate(args.plan, args.coordinator_receipt)
    elif args.action == 'release-maintenance': result = release_maintenance(args.plan, args.validation)
    elif args.action == 'complete': result = complete(args.plan, args.validation)
    else: result = rollback(args.plan)
    print(json.dumps(result))


if __name__ == '__main__':
    try: main()
    except Exception as error:
        # Never print source values, private paths, config or command output.
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch('[a-z0-9_]+', str(error)) else type(error).__name__
        print(json.dumps({'status': 'failed', 'code': code}), file=sys.stderr)
        sys.exit(1)
