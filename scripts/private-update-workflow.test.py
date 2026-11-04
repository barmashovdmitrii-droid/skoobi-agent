import importlib.util
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('private-update-workflow.py')
spec = importlib.util.spec_from_file_location('private_update', SCRIPT)
workflow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(workflow)


def command(*args, cwd=None):
    result = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1'}, check=True)
    return result.stdout.decode().strip()


def wait_until(predicate, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.03)
    raise AssertionError('fixture condition timed out')


class PrivateUpdate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='private-update-fixture-')
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'
        self.source.mkdir()
        command('git', 'init', '-q', '-b', 'main', str(self.source))
        command('git', 'config', 'user.name', 'Fixture', cwd=self.source)
        command('git', 'config', 'user.email', 'fixture@example.invalid', cwd=self.source)
        (self.source / 'file.txt').write_text('initial\n')
        (self.source / '.gitignore').write_text('.env\nnode_modules/\n')
        command('git', 'add', '.', cwd=self.source)
        command('git', 'commit', '-qm', 'fixture baseline', cwd=self.source)
        self.base = command('git', 'rev-parse', 'HEAD', cwd=self.source)
        self.remote = self.root / 'remote.git'
        command('git', 'init', '--bare', '-q', str(self.remote))
        command('git', 'push', '-q', str(self.remote), 'HEAD:refs/heads/main', cwd=self.source)
        (self.source / '.env').write_text('PRIVATE_FIXTURE=not_copied\n')
        self.state = self.root / 'state'
        self.counter = self.root / 'counts.jsonl'
        self.started = self.root / 'started'
        self.original_remote = workflow.remote_ref
        self.original_private = workflow.private_repo
        self.original_versions = workflow.versions
        self.patches = [
            patch.object(workflow, 'private_repo', return_value='main'),
            patch.object(workflow, 'remote_ref', side_effect=self.read_remote),
            patch.object(workflow, 'versions', return_value={'node': 'v22.fixture', 'git': 'fixture'}),
        ]
        for item in self.patches:
            item.start()
        prepared = workflow.prepare(self.state, self.source, 'example/project', 'feature/update')
        self.task = prepared['taskId']
        self.directory = self.state / self.task
        self.workspace = Path(prepared['workspace'])
        self.fixture = self.root / 'command.py'
        self.fixture.write_text(
            'import json,sys,time\nfrom pathlib import Path\n'
            'counter,started,step,delay,fail=sys.argv[1:]\n'
            'with open(counter,"a") as stream: stream.write(json.dumps(step)+"\\n"); stream.flush()\n'
            'Path(started).write_text(step)\n'
            'time.sleep(float(delay))\nsys.exit(int(fail))\n')

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def read_remote(self, repository, branch):
        result = subprocess.run(['git', '--git-dir', str(self.remote), 'for-each-ref', '--format=%(objectname)', 'refs/heads/' + branch],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if result.returncode != 0:
            raise ValueError('metadata_command_failed')
        return result.stdout.decode().strip() or None

    def load(self):
        return workflow.load(self.directory / 'state.json')

    def counts(self):
        return [json.loads(x) for x in self.counter.read_text().splitlines()] if self.counter.exists() else []

    def executor(self, delay_step=None, fail_step=None):
        def execute(directory, state, active, log):
            step = active['step']
            args = [sys.executable, str(self.fixture), str(self.counter), str(self.started), step,
                    '0.8' if step == delay_step else '0', '1' if step == fail_step else '0']
            workflow.run_command(directory, active, args, directory / 'workspace', log, time.monotonic() + 5)
        return execute

    def verify(self):
        with patch.object(workflow, 'execute_step', side_effect=self.executor()):
            return workflow.run(self.state, self.task)

    def commit(self, text):
        (self.workspace / 'file.txt').write_text(text)
        command('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                'add', 'file.txt', cwd=self.workspace)
        command('git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                'commit', '-qm', 'fixture change', cwd=self.workspace)

    def test_prepare_is_clean_copy_no_live_state_and_private_receipts(self):
        self.assertFalse((self.workspace / '.env').exists())
        self.assertTrue((self.source / '.env').exists())
        self.assertEqual(command('git', 'remote', cwd=self.workspace), '')
        self.assertEqual(self.load()['input']['head'], self.base)
        self.assertEqual((self.directory / 'state.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.load()['sourceInput'], self.load()['input'])
        self.assertEqual(workflow.status(self.state, self.task)['completedSteps'], [])

    def test_forbidden_targets_scope_and_tracked_private_paths(self):
        for branch in ['main', 'prod', 'release/v1', 'feature/main', 'feature/a..b', 'feature/x.lock', 'feature/a//b']:
            with self.assertRaises(ValueError):
                workflow.validate_target('example/project', branch)
        for repo in ['https://example.invalid/x', 'example/project.git?x', 'a/b/c', 'a/--config']:
            with self.assertRaises(ValueError):
                workflow.validate_target(repo, 'feature/update')
        for name in ['.env', 'sub/.env.secret', '../x', 'groups/private/input', 'data/token']:
            with self.assertRaises(ValueError):
                workflow.validate_tracked_path(name)
        with self.assertRaisesRegex(ValueError, 'outside_source'):
            workflow.prepare(self.source / 'state', self.source, 'example/project', 'feature/update')
        with self.assertRaisesRegex(ValueError, 'invalid_workflow_id'):
            workflow.status(self.state, '../source')

    def test_only_empty_ordinary_runtime_directories_are_allowed(self):
        for name in ('store', 'groups', 'logs', 'data'):
            (self.workspace / name).mkdir()
        self.assertEqual(workflow.snapshot(self.workspace), self.load()['input'])
        exported = self.root / 'tracked-export'
        exported.mkdir()
        workflow.snapshot(self.workspace, exported)
        for name in ('store', 'groups', 'logs', 'data'):
            self.assertFalse((exported / name).exists())

    def test_runtime_nested_entries_files_and_symlinks_remain_forbidden_even_when_ignored(self):
        with (self.workspace / '.git/info/exclude').open('a') as exclude:
            exclude.write('\n/store\n/groups\n/logs\n/data\n/.env\n/.claudeclaw.json\n')
        outside = self.root / 'empty-link-target'
        outside.mkdir()
        for name in ('store', 'groups', 'logs', 'data'):
            candidate = self.workspace / name
            candidate.write_bytes(b'')
            with self.assertRaisesRegex(ValueError, 'runtime_state_in_checkout'):
                workflow.snapshot(self.workspace)
            candidate.unlink()
            candidate.mkdir()
            (candidate / 'empty-child').mkdir()
            with self.assertRaisesRegex(ValueError, 'runtime_state_in_checkout'):
                workflow.snapshot(self.workspace)
            (candidate / 'empty-child').rmdir()
            (candidate / 'empty-file').write_bytes(b'')
            with self.assertRaisesRegex(ValueError, 'runtime_state_in_checkout'):
                workflow.snapshot(self.workspace)
            (candidate / 'empty-file').unlink()
            candidate.rmdir()
            for target in (outside, self.root / 'missing-target'):
                candidate.symlink_to(target, target_is_directory=True)
                with self.assertRaisesRegex(ValueError, 'runtime_state_in_checkout'):
                    workflow.snapshot(self.workspace)
                candidate.unlink()
        for name in ('.env', '.claudeclaw.json'):
            candidate = self.workspace / name
            candidate.write_bytes(b'')
            with self.assertRaisesRegex(ValueError, 'runtime_state_in_checkout'):
                workflow.snapshot(self.workspace)
            candidate.unlink()
            candidate.mkdir()
            with self.assertRaisesRegex(ValueError, 'runtime_state_in_checkout'):
                workflow.snapshot(self.workspace)
            candidate.rmdir()

    def test_explicit_read_only_base_handles_diverged_default_without_publishing_base(self):
        command('git', 'checkout', '--orphan', 'prod-fixture', cwd=self.source)
        command('git', 'rm', '--cached', '-r', '.', cwd=self.source)
        (self.source / 'file.txt').write_text('independent production baseline\n')
        command('git', 'add', '.', cwd=self.source)
        command('git', 'commit', '-qm', 'independent fixture baseline', cwd=self.source)
        prod = command('git', 'rev-parse', 'HEAD', cwd=self.source)
        command('git', 'push', '-q', str(self.remote), 'HEAD:refs/heads/prod', cwd=self.source)
        with self.assertRaisesRegex(ValueError, 'metadata_command_failed'):
            workflow.prepare(self.state, self.source, 'example/project', 'feature/from-prod')
        prepared = workflow.prepare(self.state, self.source, 'example/project', 'feature/from-prod', 'prod')
        self.task = prepared['taskId']
        self.directory = self.state / self.task
        self.workspace = Path(prepared['workspace'])
        self.assertEqual(self.load()['baseBranchAtPrepare'], 'prod')
        self.assertEqual(self.load()['baseCommit'], prod)
        self.assertEqual(self.load()['branch'], 'feature/from-prod')
        self.commit('feature derived from approved production baseline\n')
        self.verify()
        with patch.object(workflow, 'run_command', side_effect=self.push_transport()):
            self.assertEqual(workflow.run(self.state, self.task, publish=True)['publication'], 'confirmed')
        self.assertEqual(self.read_remote('example/project', 'prod'), prod)
        self.assertEqual(self.read_remote('example/project', 'main'), self.base)
        self.assertEqual(self.read_remote('example/project', 'feature/from-prod'), self.load()['input']['head'])

    def test_base_ref_is_strict_read_only_branch_and_existing_target_keeps_its_cas_base(self):
        for value in ['--all', '../prod', 'prod:main', 'HEAD~1', 'prod.lock', 'prod//x', 'prod/']:
            with self.assertRaisesRegex(ValueError, 'invalid_base_ref'):
                workflow.validate_base_ref(value)
        with self.assertRaisesRegex(ValueError, 'base_ref_is_publication_target'):
            workflow.prepare(self.state, self.source, 'example/project', 'feature/update', 'feature/update')
        command('git', '--git-dir', str(self.remote), 'update-ref', 'refs/heads/feature/existing', self.base)
        prepared = workflow.prepare(self.state, self.source, 'example/project', 'feature/existing', 'prod')
        state = workflow.load(self.state / prepared['taskId'] / 'state.json')
        self.assertEqual(state['baseBranchAtPrepare'], 'feature/existing')
        self.assertEqual(state['baseCommit'], self.base)
        self.assertEqual(state['expectedRemote'], self.base)

    def test_all_receipts_are_real_commands_and_resume_does_not_repeat(self):
        self.assertEqual(self.verify()['status'], 'verified')
        self.assertEqual(self.counts(), list(workflow.STEPS))
        self.assertEqual(self.verify()['status'], 'verified')
        self.assertEqual(self.counts(), list(workflow.STEPS))
        state = self.load()
        for step in workflow.STEPS:
            receipt = state['receipts'][step]
            self.assertEqual(receipt['input'], state['input'])
            self.assertEqual(receipt['implementationSha256'], workflow.implementation_hash())
            self.assertGreaterEqual(receipt['completedAt'], receipt['startedAt'])
        self.assertEqual(command('git', 'rev-parse', 'HEAD', cwd=self.source), self.base)

    def test_changed_inputs_invalidate_receipts_and_dirty_tree_refuses_publication(self):
        self.verify()
        (self.workspace / 'file.txt').write_text('dirty')
        with self.assertRaisesRegex(ValueError, 'dirty_checkout'):
            workflow.run(self.state, self.task, publish=True)
        self.commit('new committed input\n')
        with self.assertRaisesRegex(ValueError, 'required_checks_missing'):
            workflow.run(self.state, self.task, publish=True)
        self.assertEqual(self.load()['receipts'], {})
        self.assertEqual(self.load()['generation'], 2)
        self.verify()
        self.assertEqual(self.counts().count('install_root'), 2)

    def test_failed_step_is_bounded_and_successful_predecessors_not_replayed(self):
        with patch.object(workflow, 'execute_step', side_effect=self.executor(fail_step='test')):
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, 'step_did_not_succeed'):
                    workflow.run(self.state, self.task)
            with self.assertRaisesRegex(ValueError, 'step_attempts_exhausted'):
                workflow.run(self.state, self.task)
        self.assertEqual(self.counts().count('build'), 1)
        self.assertEqual(self.counts().count('test'), 2)
        self.assertNotIn('scan', self.counts())
        self.assertNotIn('test', self.load()['receipts'])

    def test_real_sigkill_parent_keeps_actual_step_receipt_and_waits_for_explicit_resume(self):
        with patch.object(workflow, 'execute_step', side_effect=self.executor(delay_step='install_root')):
            pid = os.fork()
            if pid == 0:
                try:
                    workflow.run(self.state, self.task)
                finally:
                    os._exit(0)
            try:
                wait_until(self.started.exists)
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
                with self.assertRaisesRegex(ValueError, 'still_running'):
                    workflow.run(self.state, self.task)
                active = self.load()['active']
                wait_until(lambda: (self.directory / 'receipts' / (active['nonce'] + '.json')).exists())
                time.sleep(0.15)
                self.assertEqual(self.counts(), ['install_root'])
                self.assertEqual(workflow.run(self.state, self.task)['status'], 'verified')
                self.assertEqual(self.counts(), list(workflow.STEPS))
            finally:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except (ProcessLookupError, ChildProcessError):
                    pass

    def test_supervisor_killed_before_command_pid_persistence_cannot_execute_untracked_action(self):
        marker = self.root / 'before-command-record.json'
        original_save = workflow.save
        def pause_before_command_record(path, value):
            if path.name.endswith('.running.json'):
                original_save(marker, value)
                while True:
                    time.sleep(.05)
            return original_save(path, value)
        with patch.object(workflow, 'execute_step', side_effect=self.executor()), \
                patch.object(workflow, 'save', side_effect=pause_before_command_record):
            pid = os.fork()
            if pid == 0:
                try:
                    workflow.run(self.state, self.task)
                except ValueError:
                    pass
                finally:
                    os._exit(0)
            try:
                wait_until(marker.exists)
                active = self.load()['active']
                gated_pid = workflow.load(marker)['pid']
                self.assertFalse((self.directory / 'receipts' / (active['nonce'] + '.running.json')).exists())
                self.assertEqual(self.counts(), [])
                os.kill(active['pid'], signal.SIGKILL)
                os.waitpid(pid, 0)
                wait_until(lambda: not workflow.alive(gated_pid))
                self.assertEqual(self.counts(), [])
            finally:
                try:
                    os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
                except (ProcessLookupError, ChildProcessError):
                    pass
        self.assertEqual(self.verify()['status'], 'verified')
        self.assertEqual(self.counts(), list(workflow.STEPS))

    def test_failed_command_pid_write_never_releases_execution_gate(self):
        with patch.object(workflow, 'save', side_effect=ValueError('storage_failure')), tempfile.TemporaryFile() as log:
            with self.assertRaisesRegex(ValueError, 'storage_failure'):
                workflow.run_command(self.directory, {'nonce': 'd' * 32},
                    [sys.executable, str(self.fixture), str(self.counter), str(self.started), 'unexpected', '0', '0'],
                    self.workspace, log, time.monotonic() + 5)
        self.assertEqual(self.counts(), [])

    def test_cancel_is_durable_and_active_process_finishes_before_receipt(self):
        with patch.object(workflow, 'execute_step', side_effect=self.executor(delay_step='install_root')):
            pid = os.fork()
            if pid == 0:
                try:
                    workflow.run(self.state, self.task)
                except ValueError:
                    pass
                finally:
                    os._exit(0)
            wait_until(self.started.exists)
            active = self.load()['active']
            running_path = self.directory / 'receipts' / (active['nonce'] + '.running.json')
            wait_until(running_path.exists)
            command_pid = workflow.load(running_path)['pid']
            workflow.cancel(self.state, self.task)
            os.waitpid(pid, 0)
            self.assertFalse(workflow.alive(command_pid))
            self.assertEqual(workflow.status(self.state, self.task)['status'], 'cancelled')
            with self.assertRaisesRegex(ValueError, 'workflow_cancelled'):
                workflow.run(self.state, self.task)
            self.assertEqual(self.counts(), ['install_root'])
            self.assertNotIn('install_root', self.load()['receipts'])

    def push_transport(self, lost_response=False, concurrent=False):
        def transport(directory, active, args, cwd, log, deadline, auth=False):
            state = self.load()
            if concurrent:
                command('git', '--git-dir', str(self.remote), 'update-ref', 'refs/heads/feature/update', self.base)
            hooks = directory / 'hooks'
            result = subprocess.run(['git', '-c', 'core.hooksPath=' + str(hooks), 'push', '--porcelain',
                                     str(self.remote), state['input']['head'] + ':refs/heads/' + state['branch']],
                                    cwd=cwd, stdout=log, stderr=log)
            with self.counter.open('a') as stream:
                stream.write(json.dumps('push') + '\n')
            if result.returncode or lost_response:
                raise ValueError('command_failed')
        return transport

    def test_unknown_push_response_reconciles_exact_ref_and_never_pushes_twice(self):
        self.commit('feature\n')
        self.verify()
        with patch.object(workflow, 'run_command', side_effect=self.push_transport(lost_response=True)):
            self.assertEqual(workflow.run(self.state, self.task, publish=True)['publication'], 'confirmed')
            self.assertEqual(workflow.run(self.state, self.task, publish=True)['publication'], 'confirmed')
        self.assertEqual(self.read_remote('example/project', 'feature/update'), self.load()['input']['head'])
        self.assertEqual(self.counts().count('push'), 1)

    def test_pre_push_hook_rejects_remote_race_without_force(self):
        self.commit('feature\n')
        self.verify()
        with patch.object(workflow, 'run_command', side_effect=self.push_transport(concurrent=True)):
            with self.assertRaisesRegex(ValueError, 'step_did_not_succeed'):
                workflow.run(self.state, self.task, publish=True)
        self.assertEqual(self.read_remote('example/project', 'feature/update'), self.base)
        self.assertNotIn('publish', self.load()['receipts'])
        self.assertEqual(self.load()['history'][-1]['reason'], 'remote_changed_no_overwrite')

    def test_remote_read_unknown_or_public_never_pushes(self):
        self.verify()
        for method, kwargs in [('remote_ref', {'side_effect': ValueError('metadata_command_failed')}),
                               ('private_repo', {'side_effect': ValueError('private_repository_required')})]:
            with patch.object(workflow, method, **kwargs), patch.object(workflow, 'run_command') as transport:
                with self.assertRaisesRegex(ValueError, 'step_did_not_succeed'):
                    workflow.run(self.state, self.task, publish=True)
                transport.assert_not_called()
        self.assertIsNone(self.read_remote('example/project', 'feature/update'))

    def test_scanner_cannot_use_checkout_allowlist_and_covers_tree_and_commits(self):
        recorded = []
        def record(directory, active, args, cwd, log, deadline, auth=False):
            recorded.append(args)
        state = self.load()
        with patch.object(workflow, 'run_command', side_effect=record), tempfile.TemporaryFile() as log:
            workflow.execute_step(self.directory, state, {'step': 'scan', 'nonce': 'a' * 32}, log)
        self.assertEqual(len(recorded), 2)
        self.assertIn('--ignore-gitleaks-allow', recorded[0])
        self.assertIn('--redact=100', recorded[0])
        self.assertIn('dir', recorded[0])
        self.assertIn(state['baseCommit'] + '..' + state['input']['head'], recorded[1])
        self.assertEqual((self.directory / 'scanner.toml').read_text(), '[extend]\nuseDefault = true\n')
        self.assertEqual((self.directory / 'scanner.ignore').read_text(), '')

    def test_changed_git_configuration_or_implementation_invalidates_authority(self):
        with (self.workspace / '.git/config').open('a') as stream:
            stream.write('\n[url "ssh://example.invalid/"]\n\tinsteadOf = https://github.com/\n')
        with self.assertRaisesRegex(ValueError, 'git_configuration_changed'):
            workflow.run(self.state, self.task)
        with patch.object(workflow, 'implementation_hash', return_value='0' * 64):
            with self.assertRaisesRegex(ValueError, 'implementation_changed'):
                workflow.status(self.state, self.task)

    def test_exhausted_push_attempts_can_only_confirm_existing_exact_commit(self):
        self.verify()
        state = self.load()
        state['attempts']['publish'] = 2
        workflow.write_state(self.directory, state)
        with patch.object(workflow, 'run_command') as transport:
            with self.assertRaisesRegex(ValueError, 'step_attempts_exhausted'):
                workflow.run(self.state, self.task, publish=True)
            command('git', '--git-dir', str(self.remote), 'update-ref',
                    'refs/heads/feature/update', state['input']['head'])
            self.assertEqual(workflow.run(self.state, self.task, publish=True)['publication'], 'confirmed')
            transport.assert_not_called()
        self.assertEqual(self.load()['attempts']['publish'], 2)

    def test_command_deadline_kills_owned_grandchild_and_caps_private_output(self):
        heartbeat = self.root / 'heartbeat'
        child = self.root / 'child.py'
        child.write_text('import signal,time,sys\nfrom pathlib import Path\n'
                         'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n'
                         'while True:\n Path(sys.argv[1]).write_text(str(time.time())); time.sleep(.02)\n')
        wrapper = self.root / 'wrapper.py'
        wrapper.write_text('import subprocess,sys,time\n'
                           'subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2]], '
                           'stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\n'
                           'print("x" * (3*1024*1024),flush=True)\ntime.sleep(20)\n')
        log_path = self.directory / 'logs' / 'deadline.log'
        with log_path.open('wb') as log:
            with self.assertRaisesRegex(ValueError, 'timeout'):
                workflow.run_command(self.directory, {'nonce': 'b' * 32},
                    [sys.executable, str(wrapper), str(child), str(heartbeat)],
                    self.workspace, log, time.monotonic() + .4)
        self.assertTrue(heartbeat.exists())
        at_end = heartbeat.read_text()
        time.sleep(.12)
        self.assertEqual(heartbeat.read_text(), at_end)
        self.assertEqual(log_path.stat().st_size, workflow.MAX_LOG)

    def test_command_environment_uses_private_home_and_cache_without_service_secrets(self):
        output = self.root / 'environment.json'
        code = ('import os,json,sys; '
                'open(sys.argv[1],"w").write(json.dumps({k:os.environ.get(k) for k in '
                '["HOME","npm_config_cache","XDG_CACHE_HOME","PLAYWRIGHT_BROWSERS_PATH",'
                '"SERVICE_FIXTURE_SECRET","GH_TOKEN"]}))')
        with patch.dict(os.environ, {'SERVICE_FIXTURE_SECRET': 'synthetic', 'GH_TOKEN': 'synthetic'}):
            with tempfile.TemporaryFile() as log:
                workflow.run_command(self.directory, {'nonce': 'c' * 32},
                    [sys.executable, '-c', code, str(output)], self.workspace, log, time.monotonic() + 5)
        observed = json.loads(output.read_text())
        for key in ('HOME', 'npm_config_cache', 'XDG_CACHE_HOME', 'PLAYWRIGHT_BROWSERS_PATH'):
            Path(observed[key]).relative_to(self.directory)
        self.assertIsNone(observed['SERVICE_FIXTURE_SECRET'])
        self.assertIsNone(observed['GH_TOKEN'])

    def test_metadata_reader_fails_closed_and_never_confuses_error_with_absent(self):
        with patch.object(workflow, 'remote_ref', wraps=spec.loader and self.read_remote):
            self.assertIsNone(workflow.remote_ref('example/project', 'feature/absent'))
        original_remote = self.original_remote
        with patch.object(workflow, 'capture', return_value=b''):
            self.assertIsNone(original_remote('example/project', 'feature/absent'))
        with patch.object(workflow, 'capture', side_effect=ValueError('metadata_command_failed')):
            with self.assertRaisesRegex(ValueError, 'metadata_command_failed'):
                original_remote('example/project', 'feature/absent')
        original_private = self.original_private
        with patch.object(workflow, 'capture', return_value=b'{"private":false,"full_name":"example/project","default_branch":"main"}'):
            with self.assertRaisesRegex(ValueError, 'private_repository_required'):
                original_private('example/project')

    def test_unauthenticated_metadata_has_unique_private_home_xdg_and_cleanup(self):
        code = ('import os,json; from pathlib import Path; '
                'keys=["HOME","XDG_CONFIG_HOME","XDG_STATE_HOME","XDG_DATA_HOME",'
                '"XDG_CACHE_HOME","GH_CONFIG_DIR","npm_config_cache","TMPDIR"]; '
                'paths={k:os.environ[k] for k in keys}; '
                '[Path(p,"fixture-state").write_text("synthetic") for p in paths.values()]; '
                'print(json.dumps(paths))')
        results = []
        with patch.dict(os.environ, {'HOME': str(self.root / 'operator-home'),
                                    'TMPDIR': str(self.workspace)}):
            for _ in range(2):
                paths = json.loads(workflow.capture([sys.executable, '-c', code], cwd=self.workspace))
                results.append(paths)
                home = Path(paths['HOME'])
                self.assertNotEqual(home, Path(os.environ['HOME']))
                self.assertFalse(home.is_relative_to(self.workspace))
                self.assertFalse(home.is_relative_to(self.source))
                for value in paths.values():
                    self.assertTrue(Path(value).is_relative_to(home))
                self.assertFalse(home.exists())
        self.assertNotEqual(results[0]['HOME'], results[1]['HOME'])
        self.assertEqual(workflow.snapshot(self.workspace), self.load()['input'])

    def test_metadata_private_home_is_cleaned_on_failure_and_auth_keeps_operator_context(self):
        marker = self.root / 'metadata-home.txt'
        with self.assertRaisesRegex(ValueError, 'metadata_command_failed'):
            workflow.capture([sys.executable, '-c',
                'import os,sys;open(sys.argv[1],"w").write(os.environ["HOME"]);sys.exit(1)',
                str(marker)], cwd=self.workspace)
        self.assertFalse(Path(marker.read_text()).exists())
        with patch.dict(os.environ, {'HOME': str(self.root / 'operator-home'),
                                    'GH_CONFIG_DIR': str(self.root / 'operator-gh'),
                                    'GH_TOKEN': 'synthetic-auth-fixture'}):
            observed = json.loads(workflow.capture([sys.executable, '-c',
                'import os,json;print(json.dumps({k:os.environ.get(k) for k in ["HOME","GH_CONFIG_DIR","GH_TOKEN"]}))'],
                cwd=self.workspace, auth=True))
            self.assertEqual(observed, {key: os.environ[key] for key in ('HOME', 'GH_CONFIG_DIR', 'GH_TOKEN')})

    @unittest.skipUnless(shutil.which('gh') and shutil.which('gitleaks'), 'Installed gh and gitleaks required')
    def test_actual_gh_versions_and_prepare_leave_both_checkouts_clean(self):
        wrapper = SCRIPT.with_name('with-node22.sh')
        if subprocess.run(['bash', str(wrapper), 'node', '--version'],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            self.skipTest('Node 22 unavailable')
        scripts = self.source / 'scripts'
        scripts.mkdir()
        (scripts / 'with-node22.sh').write_bytes(wrapper.read_bytes())
        command('git', 'add', 'scripts/with-node22.sh', cwd=self.source)
        command('git', 'commit', '-qm', 'fixture version wrapper', cwd=self.source)
        before = workflow.snapshot(self.source, allow_ignored_runtime=True)
        with patch.object(workflow, 'versions', side_effect=self.original_versions):
            prepared = workflow.prepare(self.state, self.source, 'example/project', 'feature/metadata-home')
        copied = Path(prepared['workspace'])
        self.assertEqual(workflow.snapshot(copied), before)
        self.assertEqual(workflow.snapshot(self.source, allow_ignored_runtime=True), before)
        actual = self.original_versions(copied)
        self.assertTrue(actual['gh'].startswith('gh version '))
        self.assertEqual(workflow.snapshot(copied), before)
        self.assertFalse((copied / '.local').exists())
        self.assertFalse((self.source / '.local').exists())


if __name__ == '__main__':
    unittest.main()
