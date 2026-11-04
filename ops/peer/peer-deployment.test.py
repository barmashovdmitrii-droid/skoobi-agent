#!/usr/bin/env python3
"""All fixtures are disposable. No launchd, SSH, installed app or model is used."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('peer_deployment', Path(__file__).with_name('peer-deployment.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


def private(path, value):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())
    path.chmod(0o600)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='peer-deployment-fixture-')
        self.base = Path(self.temp.name).resolve(); self.base.chmod(0o700)
        self.root = self.base / 'live'; self.root.mkdir(mode=0o700)
        self.release = self.base / 'release'; self.release.mkdir(mode=0o700)
        self.audit = self.base / 'audit'; self.audit.mkdir(mode=0o700)
        self.node = self.base / 'node'; private(self.node, b'#!/bin/sh\necho v22.23.4\n'); self.node.chmod(0o700)
        self.auth = self.base / 'own-auth.json'; private(self.auth, b'fixture-local-auth-never-executed')
        for name in ('node_modules', 'dist', 'agent', 'packages', 'ops', 'scripts', 'runtime', 'helper'):
            (self.release / name).mkdir(mode=0o700)
        private(self.release / 'package.json', {'name': 'synthetic-peer'})
        private(self.release / 'runtime/codex-toolchain.json', {'version': '0.166.0', 'destination': 'node_modules/.skoobi-codex-0.166.0', 'launcher': 'node_modules/.bin/codex'})
        private(self.release / 'scripts/code.js', b'new-code')
        private(self.root / 'scripts/code.js', b'original-code')
        private(self.root / '.env', b'KEEP_PRIVATE="untouched"\nSKOOBI_CODEX_COMMAND="old-command"\n')
        self.config_path = self.root / 'data/peer-network/worker.json'
        self.state = self.root / 'data/peer-network/state'; self.state.mkdir(mode=0o700, parents=True)
        config = {'role': 'worker', 'projectRoot': str(self.root), 'stateRoot': str(self.state),
                  'nodeCommand': str(self.node), 'codexCommand': 'old-command',
                  'authJsonPath': str(self.auth),
                  'model': 'fixture-model', 'reasoningEffort': 'xhigh',
                  'label': 'com.skoobi.peer.fixture.worker', 'helperLabel': 'com.skoobi.peer.fixture.helper'}
        private(self.config_path, config)
        self.job_id = '00000000-0000-4000-8000-000000000000'
        private(self.state / 'jobs' / self.job_id / 'state.json', {'id': self.job_id, 'schema': 1, 'state': 'succeeded'})
        private(self.state / 'heartbeat.json', {'pid': 100, 'currentJobId': None})
        (self.root / 'store').mkdir(mode=0o700)
        db = sqlite3.connect(self.root / 'store/messages.db'); db.execute('CREATE TABLE notes(value TEXT)'); db.execute("INSERT INTO notes VALUES ('original')"); db.commit(); db.close(); (self.root / 'store/messages.db').chmod(0o600)
        self.services = {}
        for number, label in enumerate((config['label'], config['helperLabel'])):
            path = self.base / (label + '.plist'); private(path, b'original-plist')
            self.services[label] = {'label': label, 'path': str(path), 'sha256': m.digest(path), 'loaded': True,
                                    'pid': 100 + number, 'definition': {'Label': label, 'EnvironmentVariables': {'KEEP': 'same'}}}
        self.receipt = self.audit / 'release-receipt.json'
        self.write_receipt()
        self.plan = self.audit / 'plan.json'
        self.coordinator = self.audit / 'coordinator.json'
        private(self.coordinator, {'status': 'quiesced', 'newSubmissionsAllowed': False, 'checkedAt': time.time()})
        self.actions = []
        self.service_patch = patch.object(m, 'service', self.service)
        self.command_patch = patch.object(m, 'command', self.command)
        self.home_patch = patch.object(m.Path, 'home', return_value=self.base)
        self.alive_patch = patch.object(m, 'process_alive', return_value=False)
        self.service_patch.start(); self.command_patch.start(); self.home_patch.start(); self.alive_patch.start()

    def tearDown(self):
        self.alive_patch.stop(); self.home_patch.stop(); self.command_patch.stop(); self.service_patch.stop(); self.temp.cleanup()

    def test_unloaded_service_with_live_old_process_blocks_code_activation(self):
        self.prepare(); before = m.tree_record(self.root / 'scripts')
        with patch.object(m, 'process_alive', return_value=True), patch.object(m.time, 'monotonic', side_effect=[0, 21]):
            with self.assertRaisesRegex(RuntimeError, 'service_did_not_stop'): m.activate(self.plan, self.coordinator)
        self.assertEqual(m.tree_record(self.root / 'scripts'), before)
        self.assertFalse((self.root / '.peer-code-current').exists())

    def write_receipt(self):
        checks = []
        for label in m.REQUIRED_BUILD_CHECKS:
            log = self.audit / 'checks' / (label + '.private.log'); private(log, b'synthetic check receipt\n')
            checks.append({'check': label, 'exitCode': 0, 'logBytes': log.stat().st_size, 'logSha256': m.digest(log)})
        private(self.receipt, {'status': 'verified', 'protocol': 2, 'sourceCommit': '0' * 40,
                              'cliVersion': '0.166.0', 'releaseRecord': m.release_record(self.release),
                              'nodeSha256': m.digest(self.node), 'checkReceipts': checks,
                              'checks': dict.fromkeys(('nativeRuntime', 'build', 'tests', 'workerAdapter', 'privateStateExcluded'), True)})

    def service(self, label):
        value = dict(self.services[label]); value['sha256'] = m.digest(value['path']); return value

    def command(self, args, **kwargs):
        args = [str(a) for a in args]; self.actions.append(args)
        if args[0] == str(self.node): return 'v22.23.4\n'
        if args[0] == '/bin/cp': shutil.copytree(args[-2], args[-1], symlinks=True); return ''
        self.assertEqual(args[0], '/bin/launchctl')
        if args[1] == 'bootout':
            label = args[2].split('/')[-1]; self.services[label].update(loaded=False, pid=None)
        elif args[1] == 'bootstrap':
            label = Path(args[3]).stem; self.services[label].update(loaded=True, pid=200 if label.endswith('worker') else 201)
            if label.endswith('worker'): private(self.state / 'heartbeat.json', {'pid': 200, 'currentJobId': None})
        else: self.fail('unexpected mutating command')
        return ''

    def prepare(self): return m.prepare(self.root, self.release, self.receipt, self.plan)
    def activate(self): self.prepare(); return m.activate(self.plan, self.coordinator)

    def test_prepare_is_read_only_and_binds_complete_release(self):
        before = m.tree_record(self.root)
        result = self.prepare()
        self.assertFalse(result['liveMutated']); self.assertEqual(before, m.tree_record(self.root))
        private(self.release / 'scripts/code.js', b'changed')
        with self.assertRaisesRegex(RuntimeError, 'release_changed_since_prepare'): m.activate(self.plan, self.coordinator)
        self.assertFalse(any(a[0] == '/bin/launchctl' for a in self.actions))

    def test_symlink_escape_and_private_state_release_rejected(self):
        (self.release / 'scripts/escape').symlink_to('../../node')
        with self.assertRaisesRegex(RuntimeError, 'release_symlink_escape'): m.release_record(self.release)
        (self.release / 'scripts/escape').unlink(); private(self.release / '.env', b'fixture')
        with self.assertRaisesRegex(RuntimeError, 'private_state_in_release'): m.release_record(self.release)

    def test_missing_or_changed_native_receipt_prevents_prepare(self):
        private(self.audit / 'checks/tests.private.log', b'changed after receipt')
        with self.assertRaisesRegex(RuntimeError, 'native_build_log_changed'): self.prepare()
        self.assertFalse(self.plan.exists())

    def test_gui_capability_requires_explicit_prepare_option_and_grants_no_slot(self):
        m.prepare(self.root, self.release, self.receipt, self.plan, enable_gui=True)
        self.assertTrue(m.read_json(self.plan)['configAfter']['allowGui'])
        self.assertNotIn('allowGui', m.read_json(self.config_path))
        self.assertFalse((self.state / 'gui-permit.json').exists())

    def test_internal_dependency_symlink_is_bound_by_hash(self):
        private(self.release / 'packages/example/package.json', {})
        (self.release / 'node_modules/example').symlink_to('../packages/example')
        record = m.release_record(self.release)
        private(self.release / 'packages/example/package.json', {'changed': True})
        self.assertNotEqual(record, m.release_record(self.release))

    def test_existing_unmanaged_symlink_is_not_overwritten(self):
        shutil.rmtree(self.root / 'scripts'); (self.root / 'scripts').symlink_to('../node')
        with self.assertRaisesRegex(RuntimeError, 'unmanaged_code_symlink_collision'): self.prepare()

    def test_late_configuration_change_blocks_before_service_stop(self):
        self.prepare(); private(self.root / '.env', b'late-edit')
        with self.assertRaisesRegex(RuntimeError, 'configuration_changed_since_prepare'): m.activate(self.plan, self.coordinator)
        self.assertFalse(any(a[0] == '/bin/launchctl' for a in self.actions))

    def test_busy_worker_and_expired_quiescence_rejected(self):
        self.prepare(); private(self.state / 'jobs' / self.job_id / 'state.json', {'id': self.job_id, 'state': 'running'})
        with self.assertRaisesRegex(RuntimeError, 'pending_or_running'): m.activate(self.plan, self.coordinator)
        private(self.coordinator, {'status': 'quiesced', 'newSubmissionsAllowed': False, 'checkedAt': time.time() - 121})
        with self.assertRaisesRegex(RuntimeError, 'fresh_coordinator'): m.activate(self.plan, self.coordinator)

    def test_activation_changes_only_code_and_selected_runtime_binding(self):
        before_job = (self.state / 'jobs' / self.job_id / 'state.json').read_bytes()
        result = self.activate()
        self.assertEqual(result['status'], 'started_maintenance')
        self.assertEqual((self.root / 'scripts/code.js').read_bytes(), b'new-code')
        self.assertEqual((self.state / 'jobs' / self.job_id / 'state.json').read_bytes(), before_job)
        self.assertTrue((self.state / 'maintenance.json').exists())
        self.assertIn(b'KEEP_PRIVATE="untouched"', (self.root / '.env').read_bytes())
        config = m.read_json(self.config_path)
        self.assertEqual(config['model'], 'fixture-model'); self.assertEqual(config['reasoningEffort'], 'xhigh')
        self.assertIn('.skoobi-codex-0.166.0', config['codexCommand'])
        self.assertEqual(config['protocol'], 2)
        self.assertEqual((self.audit / 'previous-code/scripts/code.js').read_bytes(), b'original-code')

    def test_rollback_preserves_live_database(self):
        self.activate()
        db = sqlite3.connect(self.root / 'store/messages.db'); db.execute("INSERT INTO notes VALUES ('new-user-data')"); db.commit(); db.close()
        result = m.rollback(self.plan)
        self.assertEqual(result['status'], 'rolled_back'); self.assertFalse(result['liveStateRestoredFromBackup'])
        self.assertEqual((self.root / 'scripts/code.js').read_bytes(), b'original-code')
        self.assertEqual(m.read_json(self.config_path)['codexCommand'], 'old-command')
        db = sqlite3.connect(self.root / 'store/messages.db'); self.assertEqual(db.execute('SELECT COUNT(*) FROM notes').fetchone()[0], 2); db.close()
        self.assertFalse((self.state / 'maintenance.json').exists())

    def test_legacy_rollback_never_replays_new_protocol_job(self):
        self.activate(); new_id = '00000000-0000-4000-8000-000000000001'
        private(self.state / 'jobs' / new_id / 'state.json', {'id': new_id, 'schema': 2, 'state': 'succeeded'})
        before_actions = len(self.actions)
        with self.assertRaisesRegex(RuntimeError, 'legacy_rollback_cannot_resume'): m.rollback(self.plan)
        self.assertFalse(any(a[0] == '/bin/launchctl' for a in self.actions[before_actions:]))
        self.assertEqual(m.read_json(self.state / 'jobs' / new_id / 'state.json')['state'], 'succeeded')

    def test_rollback_refuses_late_user_configuration_edit(self):
        self.activate(); private(self.root / '.env', b'user-edit')
        with self.assertRaisesRegex(RuntimeError, 'rollback_preserves_late'): m.rollback(self.plan)
        self.assertEqual((self.root / '.env').read_bytes(), b'user-edit')

    def test_partial_conversion_crash_is_reversible(self):
        self.prepare(); path, plan = m.load_plan(self.plan)
        plan['status'] = 'stopped'; m.save(path, plan)
        old = self.audit / 'previous-code'; old.mkdir(mode=0o700)
        (self.root / 'scripts').rename(old / 'scripts')
        plan['pendingConversion'] = 'scripts'; m.save(path, plan)
        # Crash between original rename and new symlink: restore uses durable backup.
        m.restore_initial_code(path, plan)
        self.assertEqual((self.root / 'scripts/code.js').read_bytes(), b'original-code')
        self.assertFalse((self.root / m.POINTER).exists())

    def test_partial_conversion_symlink_crash_is_reversible(self):
        self.prepare(); path, plan = m.load_plan(self.plan)
        old = self.audit / 'previous-code'; old.mkdir(mode=0o700)
        (self.root / 'scripts').rename(old / 'scripts'); (self.root / 'scripts').symlink_to(m.POINTER + '/scripts')
        m.restore_initial_code(path, plan)
        self.assertEqual((self.root / 'scripts/code.js').read_bytes(), b'original-code')

    def crash_conversion(self, operation):
        self.prepare(); before = m.tree_record(self.root)
        code = '''import importlib.util,os,sys,signal
from pathlib import Path
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('d',sys.argv[1]);d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
plan_path,plan=d.load_plan(sys.argv[2]);target=Path(plan['root'])/'scripts'
operation=sys.argv[3];original=getattr(Path,operation)
def interrupted(self,*args,**kwargs):
 result=original(self,*args,**kwargs)
 if self==target:os.kill(os.getpid(),signal.SIGKILL)
 return result
setattr(Path,operation,interrupted)
d.convert_code(plan_path,plan)
'''
        child = subprocess.run([sys.executable, '-c', code, str(Path(m.__file__)), str(self.plan), operation], timeout=10)
        self.assertEqual(child.returncode, -9)
        path, plan = m.load_plan(self.plan)
        self.assertEqual(plan['pendingConversion'], 'scripts')
        m.restore_initial_code(path, plan)
        self.assertEqual(m.tree_record(self.root), before)

    def test_actual_sigkill_after_original_rename_restores_exact_root(self):
        self.crash_conversion('rename')

    def test_actual_sigkill_after_replacement_symlink_restores_exact_root(self):
        self.crash_conversion('symlink_to')

    def test_configuration_compare_and_replace_refuses_race(self):
        target = self.root / '.env'; before = m.digest(target); private(target, b'late-change')
        with self.assertRaisesRegex(RuntimeError, 'private_configuration_changed'): m.replace_bytes(target, before, b'replacement')
        self.assertEqual(target.read_bytes(), b'late-change')

    def test_environment_patch_is_single_exact_key(self):
        before = b'A="first"\nSKOOBI_CODEX_COMMAND="old"\nB="last"\n'
        after = m.patch_environment(before, '/fixture/new-cli')
        self.assertEqual(after, b'A="first"\nSKOOBI_CODEX_COMMAND="/fixture/new-cli"\nB="last"\n')
        with self.assertRaisesRegex(RuntimeError, 'not_unique'): m.patch_environment(before + b'SKOOBI_CODEX_COMMAND=duplicate\n', 'new')

    def test_maintenance_requires_validation_and_does_not_resume_coordinator(self):
        self.activate(); validation = self.audit / 'validation.json'
        private(validation, {'releaseTreeSha256': m.read_json(self.plan)['releaseRecord']['tree']['sha256']})
        with self.assertRaisesRegex(RuntimeError, 'validation_incomplete'): m.release_maintenance(self.plan, validation)
        value = m.read_json(validation); value.update(dict.fromkeys(('actualRuntimeVerified', 'rpcHealthVerified', 'configurationPreserved', 'isolatedSmokePassed'), True)); private(validation, value)
        before = len(self.actions); result = m.release_maintenance(self.plan, validation)
        self.assertEqual(result['status'], 'smoke_ready'); self.assertTrue(result['coordinatorStillRequiresExplicitResume'])
        self.assertEqual(before, len(self.actions)); self.assertFalse((self.state / 'maintenance.json').exists())

    def test_exclusive_lock_releases_after_process_death(self):
        lock = self.audit / 'deployment.guard'
        code = 'import os,fcntl,time; f=os.open('+repr(str(lock))+',os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(f,fcntl.LOCK_EX);print("locked",flush=True);time.sleep(60)'
        child = subprocess.Popen([sys.executable, '-c', code], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'locked')
            with self.assertRaises(BlockingIOError):
                with m.locked(self.plan): pass
            child.kill(); child.wait(timeout=5)
            with m.locked(self.plan): pass
        finally:
            if child.poll() is None: child.kill(); child.wait(timeout=5)
            child.stdout.close()


if __name__ == '__main__': unittest.main()
