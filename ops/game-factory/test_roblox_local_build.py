import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).with_name('roblox-local-build.py'))
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
CONFIG = '''return { RELEASE = false, PERSISTENCE_ENABLED = false, ALLOW_STUDIO_PERSISTENCE = false,
ANALYTICS_ENABLED = false, PERSISTENCE_UNIVERSE_ID = 0, ANALYTICS_UNIVERSE_ID = 0,
VIP_PASS_ID = 0, TURBO_PASS_ID = 0, COIN_PACKS = {{productId = 0}} }'''

class LocalBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='roblox-adapter-test-')).resolve()
        self.root = self.temp / 'copy'; self.root.mkdir(mode=0o700)
        (self.root / 'src').mkdir(mode=0o700)
        (self.root / 'src/Config.luau').write_text(CONFIG)
        (self.root / 'src/Main.server.luau').write_text('print("factory local fixture")')
        self.project = {'name':'FactoryLocalFixture','tree':{'$className':'DataModel',
            'ReplicatedStorage':{'Config':{'$path':'src/Config.luau'}},
            'ServerScriptService':{'Main':{'$path':'src/Main.server.luau'}}}}
        self.save()
    def tearDown(self): shutil.rmtree(self.temp)
    def save(self): (self.root / 'default.project.json').write_text(json.dumps(self.project))
    def collect(self): return builder.collect(self.root, 'default.project.json', 'src/Config.luau')

    def test_collect_pins_only_referenced_sources(self):
        (self.root / 'personal.txt').write_text('not part of the project')
        self.assertEqual(len(self.collect()), 3)
        self.assertNotIn('personal.txt', self.collect())

    def test_referenced_localization_csv_is_pinned(self):
        (self.root / 'src/Labels.csv').write_text('Key,en\nhello,Hello\n')
        self.project['tree']['LocalizationService'] = {'Labels': {'$path': 'src/Labels.csv'}}
        self.save()
        self.assertEqual(self.collect()['src/Labels.csv'], b'Key,en\nhello,Hello\n')

    def test_reject_escape_and_symlink_parent(self):
        self.project['tree']['ReplicatedStorage']['Config']['$path'] = '../outside.luau';self.save()
        with self.assertRaises(ValueError): self.collect()
        self.project['tree']['ReplicatedStorage']['Config']['$path'] = 'linked/Config.luau';self.save()
        (self.root / 'linked').symlink_to(self.root / 'src', target_is_directory=True)
        with self.assertRaises(OSError): self.collect()

    def test_reject_live_flags_ids_and_commented_safety(self):
        for bad in [CONFIG.replace('PERSISTENCE_ENABLED = false','PERSISTENCE_ENABLED = true'),
                    CONFIG.replace('productId = 0','productId = 123'),
                    CONFIG.replace('VIP_PASS_ID = 0','VIP_PASS_ID = 0, VIP_PASS_ID = 123'),
                    CONFIG.replace('RELEASE = false,','-- RELEASE = false,\n')]:
            (self.root / 'src/Config.luau').write_text(bad)
            with self.assertRaises(ValueError): self.collect()

    def test_requires_the_checked_config_to_be_part_of_build(self):
        del self.project['tree']['ReplicatedStorage'];self.save()
        with self.assertRaises(ValueError): self.collect()

    def test_reject_hardlinks_and_large_files(self):
        file = self.root / 'src/Main.server.luau';os.link(file,self.temp/'second-link')
        with self.assertRaises(ValueError): self.collect()
        (self.temp/'second-link').unlink()
        with file.open('wb') as f:f.truncate(builder.MAX_FILE+1)
        with self.assertRaises(ValueError): self.collect()

    @unittest.skipUnless(shutil.which('rojo'), 'Actual installed Rojo unavailable')
    def test_actual_rojo_build_is_local_only_and_hashes_place(self):
        out, report = builder.build(self.root,'default.project.json','src/Config.luau',self.temp)
        self.assertEqual(report['status'],'built_only')
        self.assertFalse(report['published'])
        self.assertFalse(report['studioTwoClientsVerified'])
        self.assertIn(b'factory local fixture',(out/'local-fixture.rbxlx').read_bytes())
        self.assertEqual(report['placeSha256'],builder.hashlib.sha256((out/'local-fixture.rbxlx').read_bytes()).hexdigest())
        self.assertEqual((out.stat().st_mode & 0o777),0o700)

if __name__ == '__main__': unittest.main()
