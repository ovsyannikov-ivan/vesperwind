"""Small reproducible test archives. Only fixture generation uses Python."""
from pathlib import Path
import gzip, io, tarfile, zipfile

root = Path(__file__).resolve().parents[1] / 'test/fixtures/archives'
root.mkdir(parents=True, exist_ok=True)

def tar(name, entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for path, kind, link in entries:
            item = tarfile.TarInfo(path)
            item.type = kind
            item.linkname = link
            item.mode = 0o644
            content = b'archive fixture\n' if kind == tarfile.REGTYPE else b''
            item.size = len(content)
            archive.addfile(item, io.BytesIO(content))
    (root / name).write_bytes(output.getvalue())
    return output.getvalue()

content = tar('safe.tar', [('folder/read me.txt', tarfile.REGTYPE, '')])
(root / 'safe.tgz').write_bytes(gzip.compress(content, mtime=0))
for label, path in [('dotdot', '../escaped.txt'), ('absolute', '/tmp/escaped.txt'),
                    ('drive', 'C:/escaped.txt'), ('unc', '\\\\server\\share\\escaped.txt'),
                    ('ads', 'file:stream'), ('reserved', 'CON.txt'), ('trailing', 'folder./file')]:
    tar(f'{label}.tar', [(path, tarfile.REGTYPE, '')])
    with zipfile.ZipFile(root / f'{label}.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        item = zipfile.ZipInfo(path, (2020, 1, 1, 0, 0, 0))
        archive.writestr(item, b'unsafe fixture')
tar('symlink.tar', [('pivot', tarfile.SYMTYPE, '../outside'), ('pivot/escaped.txt', tarfile.REGTYPE, '')])
tar('hardlink.tar', [('escape', tarfile.LNKTYPE, '/tmp/escaped.txt')])
tar('special.tar', [('pipe', tarfile.FIFOTYPE, '')])
tar('duplicate.tar', [('same.txt', tarfile.REGTYPE, ''), ('same.txt', tarfile.REGTYPE, '')])
tar('root.tar', [('.', tarfile.DIRTYPE, ''), ('file.txt', tarfile.REGTYPE, '')])
with zipfile.ZipFile(root / 'device.zip', 'w') as archive:
    archive.writestr(zipfile.ZipInfo('COM¹', (2020, 1, 1, 0, 0, 0)), b'unsafe device')
with zipfile.ZipFile(root / 'safe.zip', 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    item = zipfile.ZipInfo('Книга/read me.txt', (2020, 1, 1, 0, 0, 0))
    archive.writestr(item, b'archive fixture\n')
