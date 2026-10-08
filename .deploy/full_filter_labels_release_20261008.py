"""Release only the seven expanded filter labels, using static-file rollback."""
import json
from pathlib import Path
import sys
import tarfile

import filter_labels_release_20261008 as release

NAME = 'full-filter-labels-20261008-01'
FILE = 'frontend/pages/admin.html'


def pack():
    root = Path(__file__).resolve().parents[1]
    previous = root / '.deploy/filter-labels-20261008-01'
    old_manifest = json.loads((previous / 'manifest.json').read_text())
    with tarfile.open(previous / 'payload.tar.gz') as archive:
        expected = archive.extractfile(FILE).read().decode('utf-8').replace('\r\n', '\n')
    labels = [
        ('ადმინი', 'მხოლოდ ადმინისტრატორები'),
        ('არქიტ', 'არქიტექტორები'),
        ('არქიტ. ექსპ', 'არქიტექტორი ექსპერტები'),
        ('მუნიც', 'მუნიციპალიტეტის სპეციალისტები'),
        ('სერტ. პირები', 'სერტიფიცირებული პირები'),
        ('ახალი განცხ.', 'ახალი განცხადებები'),
        ('უპასუხო განცხ.', 'უპასუხო განცხადებები'),
    ]
    for short, full in labels:
        old = '<span>' + short + '</span>'
        assert expected.count(old) == 1
        expected = expected.replace(old, '<span>' + full + '</span>', 1)
    assert expected == (root / FILE).read_text(encoding='utf-8'), 'Unexpected HTML change'
    for script in ('frontend/scripts/admin.js', 'frontend/scripts/admin/users.js'):
        assert release.digest(root / script) == old_manifest[script]['after'], 'Unexpected JS change'
    stage = root / '.deploy' / NAME
    stage.mkdir(mode=0o700)
    manifest = {FILE: {'before': old_manifest[FILE]['after'], 'after': release.digest(root / FILE)}}
    (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    with tarfile.open(stage / 'payload.tar.gz', 'w:gz') as archive:
        archive.add(root / FILE, arcname=FILE, recursive=False)
        archive.add(stage / 'manifest.json', arcname='manifest.json', recursive=False)
    print('PAYLOAD_SHA256=' + release.digest(stage / 'payload.tar.gz'))


if __name__ == '__main__':
    if sys.argv[1] == 'pack':
        pack()
    elif sys.argv[1] == 'apply':
        release.NAME = NAME
        release.FILES = [FILE]
        release.STAGE = Path('/home/gipcadmin') / NAME
        release.BACKUP = Path('/root/gipc-backups') / NAME
        release.apply(sys.argv[2])
    else:
        raise ValueError('Unknown mode')
