"""Deterministic wholly synthetic elevator ZIP; no production assets or state."""
import pathlib
import sys
import zipfile

variant, target = sys.argv[1:]
if variant not in ('good', 'missing-call', 'stuck-cabin'):
    raise ValueError('unknown_synthetic_fixture')
source = pathlib.Path(__file__).with_name('fixtures')
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(source.iterdir()):
        content = file.read_text()
        if file.name == 'scene.js':
            assert content.count("const variant = 'good';") == 1
            content = content.replace("const variant = 'good';", f"const variant = '{variant}';")
        if variant == 'missing-call' and file.name == 'index.html':
            button = '    <button id="call-lift" type="button" disabled>\n      Call cabin to lower landing\n    </button>\n'
            assert content.count(button) == 1
            content = content.replace(button, '')
        info = zipfile.ZipInfo(file.name, date_time=(2020, 1, 1, 0, 0, 0))
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, content.encode('utf-8'))
