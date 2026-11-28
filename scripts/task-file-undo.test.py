import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import uuid

SCRIPT = Path(__file__).with_name('task-file-undo.py')
spec = importlib.util.spec_from_file_location('file_undo', SCRIPT)
undo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(undo)


class SelectiveUndo(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='file-undo-fixture-')
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'
        self.source.mkdir()
        self.baseline = b'first\nsecond\nthird\nfourth\nfifth\nsixth\n'
        (self.source / 'example.txt').write_bytes(self.baseline)
        self.state = self.root / 'private-state'
        created = undo.initialize(self.state, self.source, ['example.txt'])
        self.task = created['taskId']
        self.workspace = Path(created['workspace'])
        self.file = self.workspace / 'example.txt'

    def tearDown(self):
        self.temp.cleanup()

    def test_nonoverlapping_manual_edit_and_mode_survive(self):
        agent = self.baseline.replace(b'first', b'agent')
        change = undo.edit(self.state, self.task, 'example.txt', agent)
        self.file.write_bytes(agent.replace(b'sixth', b'human'))
        self.file.chmod(0o640)
        result = undo.undo(self.state, self.task, change['operationId'])
        self.assertEqual(result['status'], 'undone')
        self.assertEqual(self.file.read_bytes(), self.baseline.replace(b'sixth', b'human'))
        self.assertEqual(self.file.stat().st_mode & 0o777, 0o640)
        self.assertEqual((self.source / 'example.txt').read_bytes(), self.baseline)
        self.assertEqual(undo.undo(self.state, self.task, change['operationId'])['status'], 'undone')

    def test_overlapping_manual_edit_is_preserved_as_conflict(self):
        change = undo.edit(self.state, self.task, 'example.txt', b'agent\n')
        self.file.write_bytes(b'human\n')
        result = undo.undo(self.state, self.task, change['operationId'])
        self.assertEqual(result, {'operationId': change['operationId'], 'status': 'conflict', 'currentPreserved': True})
        self.assertEqual(self.file.read_bytes(), b'human\n')

    def test_new_deleted_binary_files_require_proven_current_state(self):
        new = undo.edit(self.state, self.task, 'new.bin', b'\0agent')
        self.assertEqual(undo.undo(self.state, self.task, new['operationId'])['status'], 'undone')
        self.assertFalse((self.workspace / 'new.bin').exists())
        deleted = undo.edit(self.state, self.task, 'example.txt', None)
        self.assertFalse(self.file.exists())
        undo.undo(self.state, self.task, deleted['operationId'])
        self.assertEqual(self.file.read_bytes(), self.baseline)
        binary = undo.edit(self.state, self.task, 'example.txt', b'\0agent')
        self.file.write_bytes(b'\0human')
        self.assertEqual(undo.undo(self.state, self.task, binary['operationId'])['status'], 'conflict')
        self.assertEqual(self.file.read_bytes(), b'\0human')

    def test_later_supported_edit_blocks_out_of_order_undo(self):
        first = undo.edit(self.state, self.task, 'example.txt', b'one\n')
        second = undo.edit(self.state, self.task, 'example.txt', b'two\n')
        with self.assertRaisesRegex(ValueError, 'later_operation_conflict'):
            undo.undo(self.state, self.task, first['operationId'])
        undo.undo(self.state, self.task, second['operationId'])
        undo.undo(self.state, self.task, first['operationId'])
        self.assertEqual(self.file.read_bytes(), self.baseline)

    def test_traversal_symlinks_and_hardlinks_do_not_touch_outside(self):
        outside = self.root / 'outside'
        outside.write_bytes(b'unchanged')
        for name in ['../outside', '/outside', 'a/../../outside', '.git/config']:
            with self.assertRaises(ValueError):
                undo.edit(self.state, self.task, name, b'wrong')
        (self.workspace / 'link').symlink_to(outside)
        (self.workspace / 'parent').symlink_to(self.root, target_is_directory=True)
        os.link(outside, self.workspace / 'hardlink')
        for name in ['link', 'parent/outside', 'hardlink']:
            with self.assertRaises((OSError, ValueError)):
                undo.edit(self.state, self.task, name, b'wrong')
        self.assertEqual(outside.read_bytes(), b'unchanged')

    def test_replaced_workspace_and_manual_new_file_are_protected(self):
        new = undo.edit(self.state, self.task, 'new.txt', b'created')
        (self.workspace / 'new.txt').write_bytes(b'manually changed')
        self.assertEqual(undo.undo(self.state, self.task, new['operationId'])['status'], 'conflict')
        moved = self.workspace.with_name('moved')
        self.workspace.rename(moved)
        self.workspace.mkdir()
        with self.assertRaisesRegex(ValueError, 'workspace_replaced'):
            undo.edit(self.state, self.task, 'new.txt', b'wrong')

    def test_capacity_expiration_and_duplicate_operation(self):
        identity = str(uuid.uuid4())
        first = undo.edit(self.state, self.task, 'example.txt', b'agent', identity)
        self.assertEqual(undo.edit(self.state, self.task, 'example.txt', b'agent', identity)['status'], 'applied')
        with self.assertRaisesRegex(ValueError, 'operation_id_conflict'):
            undo.edit(self.state, self.task, 'example.txt', b'other', identity)
        with self.assertRaisesRegex(ValueError, 'file_too_large'):
            undo.edit(self.state, self.task, 'large.bin', b'x' * (undo.MAX_FILE + 1))
        journal = self.workspace.parent / 'journal.json'
        value = json.loads(journal.read_text())
        value['operations'][0]['createdAt'] = time.time() - undo.TTL - 1
        journal.write_text(json.dumps(value))
        self.assertEqual(undo.status(self.state, self.task, prune=True)['operations'][0]['status'], 'expired')
        self.assertEqual(self.file.read_bytes(), b'agent')
        self.assertNotIn('bytes', json.loads(journal.read_text())['operations'][0]['before'])
        with self.assertRaisesRegex(ValueError, 'snapshot_expired'):
            undo.undo(self.state, self.task, first['operationId'])

    def test_actual_process_exit_after_file_write_recovers_journal(self):
        code = '''import importlib.util,os,sys
spec=importlib.util.spec_from_file_location("undo",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=m.write_json
def interrupt(directory,value):
 if value['operations'] and value['operations'][-1]['status']=='applied': os._exit(91)
 original(directory,value)
m.write_json=interrupt
m.edit(sys.argv[2],sys.argv[3],'example.txt',b'agent interrupted\\n',sys.argv[4])
'''
        operation = str(uuid.uuid4())
        result = subprocess.run([sys.executable, '-c', code, str(SCRIPT), str(self.state), self.task, operation], timeout=10)
        self.assertEqual(result.returncode, 91)
        self.assertEqual(self.file.read_bytes(), b'agent interrupted\n')
        self.assertEqual(undo.status(self.state, self.task)['operations'][0]['status'], 'applied')
        undo.undo(self.state, self.task, operation)
        self.assertEqual(self.file.read_bytes(), self.baseline)

    def test_cli_reports_metadata_without_file_contents(self):
        result = subprocess.run([sys.executable, str(SCRIPT), '--state', str(self.state), 'edit',
                                 '--task', self.task, '--file', 'example.txt'], input=b'private fixture body',
                                capture_output=True, check=True, timeout=10)
        response = json.loads(result.stdout)
        self.assertEqual(response['status'], 'applied')
        self.assertNotIn(b'private fixture body', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
