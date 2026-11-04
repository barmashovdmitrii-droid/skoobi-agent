#!/usr/bin/env python3
"""Selective file edits in copies created by this tool. Never shell/API/DB undo.

Journals are private and bounded. Workspaces are retained when snapshots expire.
The cooperating writer lock does not claim atomic CAS against an unrelated
concurrent editor: reads are revalidated immediately before the atomic replace.
"""
import argparse
import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid

MAX_FILE = 1024 * 1024
MAX_JOURNAL = 32 * 1024 * 1024
MAX_OPERATIONS = 100
TTL = 30 * 86400
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
NOFOLLOW = getattr(os, 'O_NOFOLLOW', 0)


def fail(code):
    raise ValueError(code)


def relative(value):
    if not isinstance(value, str) or len(value) > 1024 or '\\' in value or '\0' in value:
        fail('invalid_path')
    parts = value.split('/')
    if any(not p or p in ('.', '..', '.git') for p in parts) or value.startswith('/'):
        fail('invalid_path')
    return parts


def real_directory(path, create=False):
    path = Path(os.path.abspath(path))
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if create:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
        info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            fail('unsafe_directory')
    return path


@contextlib.contextmanager
def parent_fd(root, name, create=False):
    parts = relative(name)
    root = real_directory(root)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW)
    try:
        for part in parts[:-1]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        # Keep an anchored handle; final components never follow symlinks.
        yield fd, parts[-1]
    finally:
        os.close(fd)


def read_at(fd, name, limit=MAX_FILE):
    try:
        handle = os.open(name, os.O_RDONLY | NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return None, 0o600
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            fail('unsafe_file')
        chunks, size = [], 0
        while True:
            chunk = os.read(handle, min(65536, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                fail('file_too_large')
            chunks.append(chunk)
        after = os.fstat(handle)
        if (info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
            fail('file_changed')
        return b''.join(chunks), stat.S_IMODE(info.st_mode) & 0o777
    finally:
        os.close(handle)


def fingerprint(data):
    return None if data is None else hashlib.sha256(data).hexdigest()


def snapshot(data):
    return {'sha256': fingerprint(data), 'bytes': None if data is None else base64.b64encode(data).decode('ascii')}


def restore(snapshot_value):
    if not isinstance(snapshot_value, dict) or set(snapshot_value) != {'sha256', 'bytes'}:
        fail('invalid_snapshot')
    data = None if snapshot_value['bytes'] is None else base64.b64decode(snapshot_value['bytes'], validate=True)
    if (data is not None and len(data) > MAX_FILE) or fingerprint(data) != snapshot_value['sha256']:
        fail('invalid_snapshot')
    return data


def replace_at(fd, name, expected, content, mode):
    # Fail closed on a changed entry, including a late symlink/hard link.
    current, _ = read_at(fd, name)
    if current != expected:
        fail('concurrent_edit')
    if content is None:
        if current is not None:
            os.unlink(name, dir_fd=fd)
        os.fsync(fd)
        return
    temp = '.skoobi-' + str(uuid.uuid4()) + '.tmp'
    handle = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(handle, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fchmod(stream.fileno(), mode)
            os.fsync(stream.fileno())
        current, _ = read_at(fd, name)
        if current != expected:
            fail('concurrent_edit')
        os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temp, dir_fd=fd)
        except FileNotFoundError:
            pass


def write_json(directory, value):
    data = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    if len(data) > MAX_JOURNAL:
        fail('snapshot_capacity')
    with parent_fd(directory, 'journal.json') as (fd, name):
        old, _ = read_at(fd, name, MAX_JOURNAL)
        # Journal replacement uses its own bounded atomic writer, not file limit.
        temp = '.journal-' + str(uuid.uuid4())
        handle = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=fd)
        try:
            with os.fdopen(handle, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if read_at(fd, name, MAX_JOURNAL)[0] != old:
                fail('journal_changed')
            os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(temp, dir_fd=fd)
            except FileNotFoundError:
                pass


@contextlib.contextmanager
def locked_task(state, task_id):
    if not UUID.fullmatch(task_id):
        fail('invalid_task')
    directory = real_directory(real_directory(state) / task_id)
    handle = os.open(directory / 'lock', os.O_RDWR | os.O_CREAT | NOFOLLOW, 0o600)
    try:
        info = os.fstat(handle)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            fail('unsafe_lock')
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with parent_fd(directory, 'journal.json') as (fd, name):
            raw, _ = read_at(fd, name, MAX_JOURNAL)
        journal = json.loads(raw)
        if journal.get('schema') != 1 or journal.get('taskId') != task_id or len(journal['operations']) > MAX_OPERATIONS:
            fail('invalid_journal')
        workspace = real_directory(directory / 'work')
        info = workspace.stat()
        if journal['workspaceIdentity'] != [info.st_dev, info.st_ino]:
            fail('workspace_replaced')
        yield directory, workspace, journal
    finally:
        os.close(handle)


def initialize(state, source, names):
    state = real_directory(state, create=True)
    source = real_directory(source)
    if not names or len(names) > 32 or len(set(names)) != len(names):
        fail('invalid_source_list')
    if len(list(state.iterdir())) >= 100:
        fail('workspace_capacity')
    # Validate/read everything before creating a workspace. Sources are read-only.
    entries, total = [], 0
    for name in names:
        with parent_fd(source, name) as (fd, leaf):
            data, mode = read_at(fd, leaf)
        if data is None:
            fail('source_missing')
        total += len(data)
        if total > 16 * MAX_FILE:
            fail('source_capacity')
        entries.append((name, data, mode))
    task_id = str(uuid.uuid4())
    directory = state / task_id
    directory.mkdir(mode=0o700)
    workspace = directory / 'work'
    workspace.mkdir(mode=0o700)
    for name, data, mode in entries:
        with parent_fd(workspace, name, create=True) as (fd, leaf):
            replace_at(fd, leaf, None, data, mode)
    info = workspace.stat()
    write_json(directory, {'schema': 1, 'taskId': task_id, 'createdAt': time.time(),
                          'workspaceIdentity': [info.st_dev, info.st_ino], 'operations': []})
    return {'taskId': task_id, 'workspace': str(workspace), 'copiedFiles': len(entries)}


def recover(operation, workspace):
    if operation['status'] not in ('prepared', 'undo_prepared'):
        return
    with parent_fd(workspace, operation['path']) as (fd, name):
        current, _ = read_at(fd, name)
    before, after = restore(operation['before']), restore(operation['after'])
    if operation['status'] == 'prepared':
        operation['status'] = 'applied' if current == after else 'not_applied' if current == before else 'unknown'
    else:
        target = restore(operation['undoTarget'])
        operation['status'] = 'undone' if current == target else 'applied' if fingerprint(current) == operation['undoFrom'] else 'unknown'


def edit(state, task_id, name, content, operation_id=None):
    relative(name)
    if content is not None and len(content) > MAX_FILE:
        fail('file_too_large')
    operation_id = operation_id or str(uuid.uuid4())
    if not UUID.fullmatch(operation_id):
        fail('invalid_operation')
    with locked_task(state, task_id) as (directory, workspace, journal):
        for existing in journal['operations']:
            if existing['id'] == operation_id:
                if existing['path'] != name or existing['after']['sha256'] != fingerprint(content):
                    fail('operation_id_conflict')
                recover(existing, workspace)
                write_json(directory, journal)
                return {'operationId': operation_id, 'status': existing['status']}
        if len(journal['operations']) >= MAX_OPERATIONS:
            fail('operation_capacity')
        with parent_fd(workspace, name, create=True) as (fd, leaf):
            before, mode = read_at(fd, leaf)
            operation = {'id': operation_id, 'path': name, 'createdAt': time.time(), 'status': 'prepared',
                         'mode': mode, 'before': snapshot(before), 'after': snapshot(content)}
            journal['operations'].append(operation)
            write_json(directory, journal)  # Durable intent before any edit.
            replace_at(fd, leaf, before, content, mode)
            operation['status'] = 'applied'
            write_json(directory, journal)
        return {'operationId': operation_id, 'status': 'applied', 'sha256': fingerprint(content)}


def merge_undo(current, after, before):
    if current == after:
        return before
    if current is None or after is None or before is None or any(b'\0' in value for value in (current, after, before)):
        fail('manual_edit_conflict')
    try:
        for value in (current, after, before):
            value.decode('utf8', errors='strict')
    except UnicodeDecodeError:
        fail('manual_edit_conflict')
    with tempfile.TemporaryDirectory(prefix='skoobi-undo-merge-') as temp:
        paths = [Path(temp) / name for name in ('current', 'agent', 'baseline')]
        for file, data in zip(paths, (current, after, before)):
            file.write_bytes(data)
            file.chmod(0o600)
        outcome = subprocess.run(['git', 'merge-file', '--stdout', *map(str, paths)],
                                 cwd=temp, env={'PATH': os.environ.get('PATH', ''), 'GIT_CONFIG_NOSYSTEM': '1',
                                                'GIT_CONFIG_GLOBAL': os.devnull},
                                 capture_output=True, timeout=5, check=False)
        if outcome.returncode != 0 or len(outcome.stdout) > MAX_FILE:
            fail('manual_edit_conflict')
        return outcome.stdout


def undo(state, task_id, operation_id):
    with locked_task(state, task_id) as (directory, workspace, journal):
        operation = next((entry for entry in journal['operations'] if entry['id'] == operation_id), None)
        if not operation:
            fail('operation_missing')
        if time.time() - operation['createdAt'] > TTL or operation['status'] == 'expired':
            fail('snapshot_expired')
        recover(operation, workspace)
        if operation['status'] == 'undone':
            return {'operationId': operation_id, 'status': 'undone'}
        if operation['status'] not in ('applied', 'conflict'):
            fail('operation_outcome_unknown')
        # Later supported edits of the same file are owned by another operation.
        # Undo those first; this operation cannot silently remove their changes.
        later = journal['operations'][journal['operations'].index(operation) + 1:]
        if any(entry['path'] == operation['path'] and entry['status'] not in ('undone', 'not_applied') for entry in later):
            fail('later_operation_conflict')
        before, after = restore(operation['before']), restore(operation['after'])
        with parent_fd(workspace, operation['path']) as (fd, leaf):
            current, current_mode = read_at(fd, leaf)
            try:
                if before is None and current is not None and current_mode != operation['mode']:
                    fail('manual_edit_conflict')
                target = merge_undo(current, after, before)
            except (ValueError, OSError, subprocess.SubprocessError):
                operation['status'] = 'conflict'
                write_json(directory, journal)
                return {'operationId': operation_id, 'status': 'conflict', 'currentPreserved': True}
            operation.update(status='undo_prepared', undoFrom=fingerprint(current), undoTarget=snapshot(target))
            write_json(directory, journal)
            replace_at(fd, leaf, current, target, current_mode if current is not None else operation['mode'])
            operation['status'] = 'undone'
            write_json(directory, journal)
        return {'operationId': operation_id, 'status': 'undone', 'sha256': fingerprint(target)}


def status(state, task_id, prune=False):
    with locked_task(state, task_id) as (directory, workspace, journal):
        for operation in journal['operations']:
            if operation['status'] == 'expired':
                continue
            if prune and time.time() - operation['createdAt'] > TTL:
                # Expiration removes only private snapshots, never working files.
                for key in ('before', 'after', 'undoTarget'):
                    if key in operation:
                        operation[key] = {'sha256': operation[key]['sha256'], 'expired': True}
                operation['status'] = 'expired'
            else:
                recover(operation, workspace)
        write_json(directory, journal)
        return {'taskId': task_id, 'workspace': str(workspace), 'operations': [
            {key: entry[key] for key in ('id', 'path', 'status', 'createdAt')} for entry in journal['operations']]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, help='Private journal/workspace directory; never a live project directory')
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init')
    init.add_argument('--source', required=True)
    init.add_argument('--file', action='append', required=True)
    change = commands.add_parser('edit')
    change.add_argument('--task', required=True)
    change.add_argument('--file', required=True)
    change.add_argument('--operation-id')
    change.add_argument('--delete', action='store_true')
    back = commands.add_parser('undo')
    back.add_argument('--task', required=True)
    back.add_argument('--operation', required=True)
    show = commands.add_parser('status')
    show.add_argument('--task', required=True)
    show.add_argument('--prune-expired', action='store_true')
    args = parser.parse_args()
    if args.command == 'init':
        result = initialize(args.state, args.source, args.file)
    elif args.command == 'edit':
        content = None if args.delete else sys.stdin.buffer.read(MAX_FILE + 1)
        result = edit(args.state, args.task, args.file, content, args.operation_id)
    elif args.command == 'undo':
        result = undo(args.state, args.task, args.operation)
    else:
        result = status(args.state, args.task, args.prune_expired)
    print(json.dumps(result, ensure_ascii=False))
    if result.get('status') == 'conflict':
        return 3
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        # Do not echo source text, paths or arbitrary child stderr.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch('[a-z_]{1,80}', str(error)) else 'file_task_failed'
        print(json.dumps({'error': code}), file=sys.stderr)
        sys.exit(2)
