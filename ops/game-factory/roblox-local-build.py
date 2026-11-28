#!/usr/bin/env python3
"""Host-only local Rojo proof. No publication, Studio launch or project scripts.

Reads an explicit local copy, pins only Rojo-referenced Luau sources, requires a
local-only configuration, and builds an isolated XML place with installed Rojo.
This maintenance command is not a game_factory capability or a sandbox for code.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile

MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 24 * 1024 * 1024
MAX_FILES = 2000
SOURCE_EXTENSIONS = ('.luau', '.lua', '.csv', '.json')


def relative(value):
    p = Path(value)
    if not value or p.is_absolute() or any(x in ('', '.', '..') or x.startswith('.') for x in p.parts):
        raise ValueError('Only visible relative source paths are supported')
    return p.as_posix()


def read_at(root_fd, name):
    parts = relative(name).split('/')
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > MAX_FILE:
                raise ValueError('Source must be a bounded single-link regular file')
            data = b''
            while len(data) <= MAX_FILE:
                chunk = os.read(file_fd, min(65536, MAX_FILE + 1 - len(data)))
                if not chunk:
                    break
                data += chunk
            after = os.fstat(file_fd)
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            if len(data) > MAX_FILE or len(data) != before.st_size or identity(before) != identity(after):
                raise ValueError('Source changed while reading')
            return data
        finally:
            os.close(file_fd)
    finally:
        os.close(fd)


def directory_sources(root_fd, name):
    fd = os.dup(root_fd)
    try:
        for part in relative(name).split('/'):
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        result = []
        for item in sorted(os.listdir(fd)):
            if item.startswith('.'):
                continue
            info = os.stat(item, dir_fd=fd, follow_symlinks=False)
            child_name = name + '/' + item
            if stat.S_ISDIR(info.st_mode):
                result += directory_sources(root_fd, child_name)
            elif stat.S_ISREG(info.st_mode) and Path(item).suffix in SOURCE_EXTENSIONS:
                result.append(child_name)
            else:
                raise ValueError('Referenced directories support Luau and JSON/CSV data only; symlinks/other assets need explicit review')
            if len(result) > MAX_FILES:
                raise ValueError('Too many source files')
        return result
    finally:
        os.close(fd)


def local_config(data):
    source = data.decode('utf8')
    # Remove comments before matching so a commented safety setting cannot pass.
    source = re.sub(r'--\[\[.*?\]\]', '', source, flags=re.S)
    source = re.sub(r'--[^\n]*', '', source)
    for name in ('RELEASE', 'PERSISTENCE_ENABLED', 'ALLOW_STUDIO_PERSISTENCE', 'ANALYTICS_ENABLED'):
        values = re.findall(r'\b' + name + r'\s*=\s*([^,\n}]+)', source)
        if values != ['false']:
            raise ValueError('Required local-only flag is absent, duplicated or enabled: ' + name)
    for name in ('PERSISTENCE_UNIVERSE_ID', 'ANALYTICS_UNIVERSE_ID', 'VIP_PASS_ID', 'TURBO_PASS_ID'):
        values = re.findall(r'\b' + name + r'\s*=\s*([^,\n}]+)', source)
        if values != ['0']:
            raise ValueError('Required local-only identifier must be zero: ' + name)
    products = re.findall(r'\bproductId\s*=\s*([^,\n}]+)', source)
    if any(v.strip() != '0' for v in products):
        raise ValueError('Real product IDs are forbidden in the local fixture')


def collect(root, project_name, config_name):
    root = Path(root)
    if not root.is_absolute() or root.resolve() != root:
        raise ValueError('Source root must be an absolute canonical directory')
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        project_name, config_name = relative(project_name), relative(config_name)
        if Path(project_name).parent != Path('.'):
            raise ValueError('This adapter requires a project JSON at source root')
        project_data = read_at(fd, project_name)
        project = json.loads(project_data)
        files = {project_name: project_data}
        config_referenced = False
        nodes = 0

        def visit(node):
            nonlocal config_referenced, nodes
            nodes += 1
            if nodes > 100000:
                raise ValueError('Project graph too large')
            if isinstance(node, dict):
                if '$path' in node:
                    name = relative(node['$path'])
                    if Path(name).suffix in SOURCE_EXTENSIONS:
                        paths = [name]
                    else:
                        paths = directory_sources(fd, name)
                    for path in paths:
                        files[path] = read_at(fd, path)
                        config_referenced |= path == config_name
                    if len(files) > MAX_FILES or sum(map(len, files.values())) > MAX_TOTAL:
                        raise ValueError('Source budget exceeded')
                for value in node.values():
                    visit(value)
            elif isinstance(node, list):
                for value in node:
                    visit(value)
        visit(project)
        if not config_referenced:
            raise ValueError('The checked local configuration is not referenced by the project')
        local_config(files[config_name])
        for name, data in files.items():
            if read_at(fd, name) != data:
                raise ValueError('Source changed during snapshot')
        return files
    finally:
        os.close(fd)


def build(source_root, project, config, output_parent, rojo=None):
    files = collect(source_root, project, config)
    parent = Path(output_parent)
    if not parent.is_absolute() or parent.resolve() != parent:
        raise ValueError('Output parent must be canonical')
    info = parent.stat()
    if not parent.is_dir() or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError('Output parent must be a private owned directory')
    binary = rojo or shutil.which('rojo')
    if not binary:
        raise ValueError('Installed Rojo is unavailable')
    binary = str(Path(binary).resolve(strict=True))
    if Path(binary).name != 'rojo':
        raise ValueError('Expected the installed Rojo executable')
    version = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=5, check=True).stdout.strip()
    out = Path(tempfile.mkdtemp(prefix='roblox-local-', dir=parent))
    pinned = out / 'source'; pinned.mkdir(mode=0o700)
    for name, data in files.items():
        dest = pinned / name; dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        dest.write_bytes(data); dest.chmod(0o600)
    artifact = out / 'local-fixture.rbxlx'
    result = subprocess.run([binary, 'build', project, '-o', str(artifact)], cwd=pinned,
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise ValueError('Rojo build failed; inspect the isolated local source')
    if collect(source_root, project, config) != files:
        raise ValueError('Source changed during build; output is not verified')
    artifact.chmod(0o600)
    if artifact.stat().st_size > 100 * 1024 * 1024:
        raise ValueError('Built place exceeds the local proof size limit')
    data = artifact.read_bytes()
    if not data.startswith(b'<roblox'):
        raise ValueError('Expected a bounded Roblox XML place')
    manifest = [{'path':name,'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)} for name,raw in sorted(files.items())]
    digest = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    report = {'kind':'roblox_local_build','status':'built_only','rojoVersion':version,'manifestSha256':digest,
              'sourceFiles':manifest,'placeSha256':hashlib.sha256(data).hexdigest(),'placeBytes':len(data),
              'localConfigChecked':True,'published':False,'studioTwoClientsVerified':False,
              'limitations':['Static configuration checks are not a sandbox or proof of all code behavior.',
                             'Studio launch, two clients, cloud saves, real purchases and human gameplay are separate checks.']}
    (out / 'receipt.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    (out / 'receipt.json').chmod(0o600)
    return out, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', required=True)
    parser.add_argument('--project', required=True)
    parser.add_argument('--local-config', required=True)
    parser.add_argument('--output-parent', required=True)
    args = parser.parse_args()
    out, report = build(args.source_root, args.project, args.local_config, args.output_parent)
    print(json.dumps({'outputDirectory':str(out),'status':report['status'],'manifestSha256':report['manifestSha256'],
                      'placeSha256':report['placeSha256'],'studioTwoClientsVerified':False}))


if __name__ == '__main__':
    main()
