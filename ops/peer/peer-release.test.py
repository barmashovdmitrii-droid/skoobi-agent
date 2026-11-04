#!/usr/bin/env python3
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import shutil
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('peer_release', Path(__file__).with_name('peer-release.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


class ReleaseTests(unittest.TestCase):
    def test_internal_package_hardlinks_become_independent_equal_executables(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); a = root / 'esbuild'; b = root / 'package-esbuild'
            a.write_bytes(b'fixture executable'); a.chmod(0o700); os.link(a, b)
            self.assertEqual(m.detach_internal_hardlinks(root), 1)
            self.assertEqual(a.read_bytes(), b.read_bytes())
            self.assertEqual(a.stat().st_nlink, 1); self.assertEqual(b.stat().st_nlink, 1)
            self.assertEqual(a.stat().st_mode & 0o777, 0o700)

    def test_external_hardlink_is_refused_without_touching_source(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); code = root / 'release'; code.mkdir()
            outside = root / 'outside'; outside.write_bytes(b'outside bytes'); os.link(outside, code / 'alias')
            before = outside.stat().st_ino
            with self.assertRaisesRegex(RuntimeError, 'external_build_hardlink'): m.detach_internal_hardlinks(code)
            self.assertEqual(outside.stat().st_ino, before); self.assertEqual(outside.read_bytes(), b'outside bytes')

    def test_native_npm_loads_distinct_empty_isolated_configs(self):
        node = shutil.which('node'); npm = shutil.which('npm')
        if not node or not npm: self.skipTest('native npm and Node required')
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp).resolve(); code = stage / 'code'; code.mkdir(mode=0o700)
            native = {'destination':'node_modules/pinned-codex','binary':'vendor/darwin/bin/codex'}
            tmp = stage / 'tmp'; tmp.mkdir(mode=0o700)
            env = m.build_environment(stage, code, Path(node), tmp, native)
            self.assertEqual(env['PATH'].split(':')[1], str(code / 'node_modules/pinned-codex/vendor/darwin/codex-path'))
            self.assertNotEqual(env['npm_config_userconfig'], env['npm_config_globalconfig'])
            for key in ('npm_config_userconfig', 'npm_config_globalconfig'):
                self.assertEqual(Path(env[key]).read_bytes(), b'')
            result = subprocess.run([npm, 'config', 'get', 'registry'], cwd=code, env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'https://registry.npmjs.org/')

    def test_native_temp_is_private_os_temp_and_cleaned_on_failure(self):
        from unittest.mock import patch
        seen = []
        def fail_build(bundle, stage, node, tmp):
            seen.append(tmp)
            self.assertEqual(tmp.parent, Path('/tmp').resolve())
            self.assertEqual(tmp.stat().st_mode & 0o777, 0o700)
            (tmp / 'fixture').write_text('temporary data')
            raise RuntimeError('synthetic_native_failure')
        with patch.object(m, 'build_native', side_effect=fail_build):
            with self.assertRaisesRegex(RuntimeError, 'synthetic_native_failure'): m.build('unused', 'unused', 'unused')
        self.assertFalse(seen[0].exists())

    def test_real_pack_overrides_writable_git_archive_default_without_config_mutation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); root.chmod(0o700)
            source = root / 'source'; source.mkdir(mode=0o700)
            output = root / 'bundle'; output.mkdir(mode=0o700)
            def git(*args): return subprocess.check_output(['git', '-C', str(source), *args], stderr=subprocess.DEVNULL).decode().strip()
            git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'tar.umask', '0002')
            (source / 'ops/peer').mkdir(parents=True)
            for name in ('peer-release.py', 'peer-deployment.py'):
                (source / 'ops/peer' / name).write_bytes(Path(__file__).with_name(name).read_bytes())
            (source / 'package.json').write_text('{}')
            toolchain = root / 'toolchain.json'; toolchain.write_text(json.dumps({'version':'0.166.0','platform':'darwin','arch':'arm64'})); toolchain.chmod(0o600)
            git('add', '.'); git('commit', '-m', 'fixture')
            result = m.pack(source, git('rev-parse', 'HEAD'), output, toolchain)
            self.assertEqual(result['status'], 'packed')
            self.assertEqual(git('config', 'tar.umask'), '0002')
            with tarfile.open(output / 'source.tar') as archive:
                self.assertTrue(all(not x.mode & 0o022 for x in archive.getmembers()))

    def archive(self, entries):
        body = io.BytesIO()
        with tarfile.open(fileobj=body, mode='w') as archive:
            for name, kind in entries:
                info = tarfile.TarInfo(name); info.mode = 0o644
                if kind == 'file': info.size = 3; archive.addfile(info, io.BytesIO(b'abc'))
                else: info.type = tarfile.SYMTYPE; info.linkname = '../../outside'; archive.addfile(info)
        body.seek(0); return tarfile.open(fileobj=body)

    def test_source_allowlist_prevents_private_state(self):
        for name in ('.env', 'store/messages.db', 'groups/owner/CLAUDE.md', 'data/peer-network/key', '.codex/auth.json'):
            with self.archive([(name, 'file')]) as archive:
                with self.assertRaisesRegex(RuntimeError, 'not_allowlisted'): m.safe_members(archive)

    def test_traversal_absolute_duplicates_and_links_rejected(self):
        for entries in ([('../package.json', 'file')], [('/package.json', 'file')], [('scripts/x', 'link')], [('scripts/x', 'file'), ('scripts/x', 'file')]):
            with self.archive(entries) as archive:
                with self.assertRaises(RuntimeError): m.safe_members(archive)

    def test_regular_source_extracts_only_into_new_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); source = root / 'source.tar'
            with self.archive([('package.json', 'file'), ('scripts/x.js', 'file')]) as archive:
                source.write_bytes(archive.fileobj.getvalue())
            target = root / 'stage'; self.assertEqual(m.extract_source(source, target), 2)
            self.assertEqual((target / 'scripts/x.js').read_bytes(), b'abc')
            with self.assertRaisesRegex(RuntimeError, 'must_be_new'): m.extract_source(source, target)

    def test_existing_internal_skill_link_is_supported_but_never_followed_by_archive(self):
        body = io.BytesIO()
        with tarfile.open(fileobj=body, mode='w') as archive:
            info = tarfile.TarInfo('.claude/skills'); info.type = tarfile.SYMTYPE; info.linkname = '../skills'; info.mode = 0o777; archive.addfile(info)
            info = tarfile.TarInfo('skills/README.md'); info.size = 3; info.mode = 0o644; archive.addfile(info, io.BytesIO(b'abc'))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); source = root / 'source.tar'; source.write_bytes(body.getvalue())
            m.extract_source(source, root / 'stage')
            self.assertEqual((root / 'stage/.claude/skills/README.md').read_bytes(), b'abc')
        with tarfile.open(fileobj=io.BytesIO(body.getvalue())) as archive: self.assertEqual(len(m.safe_members(archive)), 2)

    def test_real_failing_command_never_gets_success_receipt(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); root.chmod(0o700)
            with self.assertRaisesRegex(RuntimeError, 'build_check_failed_fixture'):
                m.run_logged('fixture', [sys.executable, '-c', 'print("synthetic failure");raise SystemExit(7)'], root, {'PATH': '/usr/bin:/bin'}, root, 5)
            self.assertIn('synthetic failure', (root / 'fixture.private.log').read_text())

    def test_timeout_terminates_own_process_group(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); root.chmod(0o700)
            with self.assertRaisesRegex(RuntimeError, 'build_command_timeout'):
                m.run_logged('timeout', [sys.executable, '-c', 'import time;time.sleep(10)'], root, {'PATH': '/usr/bin:/bin'}, root, .2)


if __name__ == '__main__': unittest.main()
