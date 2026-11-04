"""Synthetic archives for the real host checker; no production state is used."""
import pathlib
import stat
import sys
import zipfile

variant, target = sys.argv[1:]
source = pathlib.Path(__file__).with_name('fixtures')
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(source.iterdir()):
        content = file.read_bytes()
        if variant == 'broken' and file.name == 'index.html':
            content = content.replace(b'src="app.js"', b'src="missing.js"')
        archive.writestr(file.name, content)
    if variant == 'traversal':
        archive.writestr('../escaped.txt', 'unsafe')
    elif variant == 'symlink':
        info = zipfile.ZipInfo('link')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, '../outside')
    elif variant == 'large':
        archive.writestr('oversize.txt', b'x' * (8 * 1024 * 1024 + 1))
    elif variant == 'duplicate':
        archive.writestr('INDEX.HTML', 'conflict')
    elif variant not in ('good', 'broken'):
        raise ValueError('Unknown synthetic fixture')
