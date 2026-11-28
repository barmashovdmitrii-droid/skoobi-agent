"""Bounded, non-executing OOXML metadata reader for the calculation pilot."""
import io
import json
import posixpath
import re
import stat
import sys
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
REL = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'


def require(ok):
    if not ok:
        raise ValueError('unsupported_or_unsafe_workbook')


def read():
    blob = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
    require(len(blob) <= 16 * 1024 * 1024)
    archive = zipfile.ZipFile(io.BytesIO(blob))
    entries = archive.infolist()
    require(0 < len(entries) <= 512)
    names = set()
    total = 0
    for entry in entries:
        name = entry.filename
        require(not any(ord(c) < 32 for c in entry.orig_filename))
        require(not name.startswith('/') and '\\' not in name and ':' not in name)
        require(all(p not in ('', '.', '..') for p in name.rstrip('/').split('/')))
        key = unicodedata.normalize('NFKC', name).casefold()
        require(key not in names)
        names.add(key)
        require(not entry.flag_bits & 1)
        mode = entry.external_attr >> 16
        require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR))
        require(entry.file_size <= 8 * 1024 * 1024)
        require(entry.file_size <= max(4096, entry.compress_size * 200))
        total += entry.file_size
        require(total <= 32 * 1024 * 1024)
        require(not re.search(r'vba|macrosheet|externallink|embeddings|activex', name, re.I))
        require(bool(re.fullmatch(r'(?:\[Content_Types\]\.xml|_rels/\.rels|docProps/(?:core|app|custom)\.xml|xl/(?:workbook|styles|sharedStrings|calcChain)\.xml|xl/_rels/workbook\.xml\.rels|xl/theme/theme[1-9][0-9]*\.xml|xl/worksheets/sheet[1-9][0-9]*\.xml)', name)))

    def xml(name):
        data = archive.read(name)
        require(b'\x00' not in data)
        data.decode('utf-8-sig')
        require(not re.search(br'<!\s*(DOCTYPE|ENTITY)', data, re.I))
        document = ET.fromstring(data)
        forbidden = {'connections', 'connection', 'queryTable', 'queryTableRefresh', 'pivotCacheDefinition', 'pivotTableDefinition', 'externalData', 'dbPr', 'webPr', 'textPr', 'oleObject', 'webExtension'}
        require(not any(element.tag.rsplit('}', 1)[-1] in forbidden for element in document.iter()))
        return document

    # Reject external relationships anywhere; neither links nor macros execute.
    for entry in entries:
        if entry.filename.endswith('.xml'):
            xml(entry.filename)
        if entry.filename.endswith('.rels'):
            relation_ids = set()
            for relation in xml(entry.filename):
                require(relation.get('Id') and relation.get('Id') not in relation_ids)
                relation_ids.add(relation.get('Id'))
                require(relation.get('TargetMode', 'Internal') == 'Internal')
                target = relation.get('Target', '')
                require(target and ':' not in target and '\\' not in target)
                base = posixpath.dirname(posixpath.dirname(entry.filename))
                resolved = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join(base, target))
                require(resolved in archive.namelist())
    types = archive.read('[Content_Types].xml')
    require(b'macroEnabled' not in types and b'vbaProject' not in types)
    require(not re.search(br'connection|querytable|pivotcache|pivottable|externaldata|oleobject|webextension', types, re.I))
    workbook = xml('xl/workbook.xml')
    require(workbook.find(NS + 'definedNames') is None)
    relations = {r.get('Id'): r.get('Target') for r in xml('xl/_rels/workbook.xml.rels')}
    strings = []
    if 'xl/sharedStrings.xml' in archive.namelist():
        for item in xml('xl/sharedStrings.xml'):
            strings.append(''.join(t.text or '' for t in item.iter(NS + 't')))
        require(len(strings) <= 100000)
    sheets = workbook.find(NS + 'sheets')
    require(sheets is not None and 0 < len(sheets) <= 12)
    result = []
    count = 0
    sheet_names = set()
    for sheet in sheets:
        title = sheet.get('name')
        require(title and len(title) <= 31 and title not in sheet_names)
        sheet_names.add(title)
        require(sheet.get('state', 'visible') == 'visible')
        target = relations.get(sheet.get(REL + 'id'))
        require(target and '\\' not in target)
        target = posixpath.normpath(target.lstrip('/') if target.startswith('/') else 'xl/' + target)
        require(target.startswith('xl/worksheets/') and target.endswith('.xml'))
        document = xml(target)
        # Prevent deceptive dimensions from making the existing reader allocate a huge matrix.
        dimension = document.find(NS + 'dimension')
        addresses = []
        if dimension is not None:
            addresses.extend(dimension.get('ref', '').split(':'))
        cells = []
        seen = set()
        for row in document.findall('.//' + NS + 'row'):
            require(row.get('hidden', '0') in ('0', 'false'))
        for column in document.findall('.//' + NS + 'col'):
            require(column.get('hidden', '0') in ('0', 'false'))
        for cell in document.findall('.//' + NS + 'c'):
            address = cell.get('r')
            require(address and address not in seen)
            seen.add(address)
            addresses.append(address)
            kind = cell.get('t', 'n')
            value = cell.find(NS + 'v')
            raw = value.text if value is not None and value.text is not None else ''
            formula = cell.find(NS + 'f')
            require(formula is None or not formula.attrib)
            if kind == 's':
                require(raw.isdigit() and int(raw) < len(strings))
                raw = strings[int(raw)]
            elif kind == 'inlineStr':
                raw = ''.join(t.text or '' for t in cell.iter(NS + 't'))
            require(len(raw) <= 4096 and (formula is None or len(formula.text or '') <= 512))
            cells.append({'address': address, 'type': kind, 'value': raw,
                          **({'formula': formula.text or ''} if formula is not None else {})})
        for address in addresses:
            match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', address)
            require(match is not None)
            column = 0
            for char in match[1]:
                column = column * 26 + ord(char) - 64
            require(column <= 64 and int(match[2]) <= 2000)
        count += len(cells)
        require(count <= 20000)
        require(not document.findall('.//' + NS + 'mergeCell'))
        result.append({'name': title, 'cells': cells})
    return {'sheets': result}


try:
    print(json.dumps(read(), ensure_ascii=True, separators=(',', ':')))
except Exception:
    print('unsupported_or_unsafe_workbook', file=sys.stderr)
    sys.exit(2)
