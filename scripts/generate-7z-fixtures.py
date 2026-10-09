"""Development only: generate real fixtures with pinned 7-Zip 26.04.
Usage: python3 scripts/generate-7z-fixtures.py /absolute/path/to/7zz
No CLI is needed by Vesperwind builds, tests or runtime.
"""
from pathlib import Path
import base64, binascii, hashlib, json, os, struct, subprocess, sys, tempfile

root = Path(__file__).resolve().parents[1] / 'test/fixtures/archives'
tool = Path(sys.argv[1]).resolve()
if '26.04' not in subprocess.check_output([str(tool), 'i'], text=True):
    raise SystemExit('Use pinned 7-Zip 26.04')
contents = {
    'folder/read me.txt': b'archive fixture\n',
    'folder/Книга/Глава 1.txt': 'Привет, 7z!\n'.encode(),
    'folder/empty.txt': b'',
    'folder/binary.bin': bytes(range(256)) * 8,
}
manifest = {name: {'sha256': hashlib.sha256(data).hexdigest(), 'base64': base64.b64encode(data).decode()} for name, data in contents.items()}
root.mkdir(exist_ok=True)

def run(*args, cwd):
    return subprocess.check_output([str(tool), *args], cwd=cwd, text=True)

def create(label, method, solid, cwd, sources=['folder'], extra=[]):
    target = root / label
    target.unlink(missing_ok=True)
    run('a', '-t7z', '-mx=5', '-mhc=off', '-mtc=off', '-mta=off', '-mtm=off', '-mmt=1', '-ms=' + ('on' if solid else 'off'), '-m0=' + method, *extra, str(target), *sources, cwd=cwd)
    return target

def mutate_copy(label, path):
    # Replace the UTF-16 name in a genuine stored 7z's plain header and rebuild
    # both CRCs. Compressed payloads and their CRCs remain unchanged.
    original = (root / 'single-copy.7z').read_bytes()
    offset, size, crc = struct.unpack('<QQI', original[12:32])
    header = original[32 + offset:32 + offset + size]
    marker = ('plain.txt\0').encode('utf-16le')
    assert header.count(marker) == 1
    # The Name property has a variable-length size. Keep its size unchanged by
    # using fixture names padded to the original UTF-16 length where possible;
    # for arbitrary lengths encode the new property length (these are <128).
    index = header.index(marker)
    old_property_size = 1 + len(marker)
    assert header[index-3:index] == bytes([0x11, old_property_size, 0])
    replacement = (path + '\0').encode('utf-16le')
    header = header[:index-2] + bytes([1 + len(replacement), 0]) + replacement + header[index+len(marker):]
    start = struct.pack('<QQI', offset, len(header), binascii.crc32(header))
    result = original[:8] + struct.pack('<I', binascii.crc32(start)) + start + original[32:32+offset] + header
    (root / label).write_bytes(result)

with tempfile.TemporaryDirectory(prefix='vesperwind-7z-fixtures-') as temp:
    cwd = Path(temp)
    for name, data in contents.items():
        p = cwd / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data); p.chmod(0o644)
    (cwd / 'folder/empty directory').mkdir()
    create('safe-copy.7z', 'Copy', False, cwd)
    create('safe-lzma.7z', 'LZMA', False, cwd)
    create('safe-lzma2.7z', 'LZMA2', False, cwd)
    create('safe-solid-lzma2.7z', 'LZMA2', True, cwd)
    solid_listing = run('l', '-slt', str(root / 'safe-solid-lzma2.7z'), cwd=cwd)
    assert 'Solid = +' in solid_listing and 'Blocks = 1' in solid_listing
    create('unicode-names.7z', 'LZMA2', True, cwd)
    create('unsupported-bzip2.7z', 'BZip2', False, cwd)
    create('encrypted.7z', 'LZMA2', True, cwd, extra=['-pfixture-password'])
    create('encrypted-header.7z', 'LZMA2', True, cwd, extra=['-pfixture-password', '-mhe=on'])
    (cwd / 'branch.exe').write_bytes((b'\x90\xe8\x10\x00\x00\x00\xe9\xf0\xff\xff\xff' + b'code fixture\n') * 4096)
    # Actual x86 BCJ + LZMA2 pipeline, with BCJ bound into LZMA2.
    create('safe-bcj-lzma2.7z', 'BCJ', True, cwd, sources=['branch.exe'], extra=['-m1=LZMA2'])
    manifest['branch.exe'] = {'sha256': hashlib.sha256((cwd/'branch.exe').read_bytes()).hexdigest()}
    (cwd / 'plain.txt').write_bytes(b'unsafe fixture')
    create('single-copy.7z', 'Copy', False, cwd, sources=['plain.txt'])
    (cwd / 'other.txt').write_bytes(b'duplicate fixture')
    duplicate = create('duplicate.7z', 'Copy', False, cwd, sources=['plain.txt', 'other.txt']).read_bytes()
    offset, size, crc = struct.unpack('<QQI', duplicate[12:32])
    header = duplicate[32+offset:32+offset+size].replace('other.txt\0'.encode('utf-16le'), 'plain.txt\0'.encode('utf-16le'))
    start = struct.pack('<QQI', offset, len(header), binascii.crc32(header))
    (root / 'duplicate.7z').write_bytes(duplicate[:8] + struct.pack('<I', binascii.crc32(start)) + start + duplicate[32:32+offset] + header)
    for label, unsafe in {
        'dotdot.7z': '../../outside.txt', 'absolute.7z': '/outside.txt',
        'drive.7z': 'C:/outside.txt', 'unc.7z': '\\\\server\\share\\file.txt',
        'ads.7z': 'file:alternate-stream', 'reserved.7z': 'CON',
        'reserved-nul.7z': 'NUL.txt', 'trailing.7z': 'folder./file.txt',
        'backslash.7z': 'folder\\file.txt', 'control.7z': 'file\x01.txt',
    }.items(): mutate_copy(label, unsafe)
    os.symlink('../outside.txt', cwd / 'unsafe-link')
    create('unsafe-link.7z', 'Copy', False, cwd, sources=['unsafe-link'], extra=['-snl'])
    damaged = bytearray((root / 'safe-solid-lzma2.7z').read_bytes()); damaged[32] ^= 0x80
    (root / 'corrupted.7z').write_bytes(damaged)
    (root / 'truncated.7z').write_bytes((root / 'safe-solid-lzma2.7z').read_bytes()[:80])
    # Change the raw LZMA2 dictionary property to 40 (UINT32_MAX), while keeping
    # a valid 7z container and its CRCs. This exercises allocation refusal.
    raw = (root / 'safe-lzma2.7z').read_bytes(); offset, size, crc = struct.unpack('<QQI', raw[12:32])
    header = raw[32+offset:32+offset+size]
    marker = b'\x21\x21\x01'  # one LZMA2 coder, id 0x21, one property byte
    assert marker in header
    header = header.replace(marker + bytes([header[header.index(marker)+3]]), marker + b'\x28')
    start = struct.pack('<QQI', offset, len(header), binascii.crc32(header))
    (root / 'huge-dictionary.7z').write_bytes(raw[:8] + struct.pack('<I',binascii.crc32(start)) + start + raw[32:32+offset] + header)
    # 384 MiB of logical output in three nested files, in one solid block. The
    # committed compressed fixture is small; tests hash streams, not whole files.
    large = {}
    chunk = bytes(range(256)) * 4096
    for name in ['large/first.bin', 'large/nested/second.bin', 'large/nested/Книга/third.bin']:
        target = cwd / name; target.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256()
        with target.open('wb') as out:
            for _ in range(128): out.write(chunk); digest.update(chunk)
        large[name] = {'size': 128 * len(chunk), 'sha256': digest.hexdigest()}
    create('large-solid-lzma2.7z', 'LZMA2', True, cwd, sources=['large'], extra=['-md=16m'])
    manifest['large'] = large
    manifest['archives'] = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.glob('*.7z'))}
    (root / '7z-manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
print('Generated real 7z fixtures; verified solid LZMA2 has multiple files in one block')
