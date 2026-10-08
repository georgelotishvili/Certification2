"""Publish the approved header logo and sizing; no application/server changes."""
import base64
import json
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
import deploy_independent_statements_20261008 as release

FILES = [
    'frontend/assets/svg/logo.svg',
    'frontend/styles/header.css',
    'frontend/partials/header.html',
    'frontend/pages/index.html',
    'frontend/pages/my.html',
    'frontend/pages/registry.html',
]
BASELINES = {
    FILES[2]: 'registry-links-20261008-01',
    FILES[3]: 'registry-links-20261008-01',
    FILES[4]: 'public-qr-20261008-01',
    FILES[5]: 'registry-rows-20261008-01',
}
release.FILES = FILES
release.STORE = release.ROOT / '.deploy/header-logo-20261008-01'
release.REMOTE += '\nFILES = ' + repr(FILES) + '\n'


def normalized(content):
    return content.decode('utf-8').replace('\r\n', '\n')


def prepare():
    # Validate known prior versions before saving exact remote byte hashes.
    data = release.remote("print(json.dumps({name: base64.b64encode(target(name).read_bytes()).decode() for name in FILES}))")
    expected = {}
    for name in FILES:
        old = base64.b64decode(data[name], validate=True)
        if name in BASELINES:
            folder = release.ROOT / '.deploy' / BASELINES[name]
            previous = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
            assert release.digest(old) == previous['files'][name]['after'], 'Production drift: ' + name
            baseline = (folder / 'after' / name).read_bytes()
            assert release.digest(baseline) == release.digest(old)
        else:
            baseline = subprocess.check_output(['git', 'show', 'HEAD:' + name], cwd=release.ROOT)
            assert normalized(old) == normalized(baseline), 'Production drift against original asset: ' + name
        expected[name] = release.digest(old)
        new = normalized((release.ROOT / name).read_bytes())
        if name == FILES[1]:
            assert new == normalized(old).replace('  height: 30px;\n  width: auto;', '  height: auto;\n  width: 169.2px;', 1)
        elif name == FILES[2]:
            assert new == normalized(old).replace('<img src="../assets/svg/logo.svg" alt="logo" />', '<img src="../assets/svg/logo.svg?v=20261008-1" alt="GIPC" />', 1)
        elif name.startswith('frontend/pages/'):
            assert new == normalized(old).replace('../styles/header.css?v=3', '../styles/header.css?v=20261008-logo2', 1)
        else:
            svg = ET.fromstring(new)
            assert svg.attrib['viewBox'] == '0 0 73.74 24.16'
            assert len(svg.findall('.//{http://www.w3.org/2000/svg}path')) == 3
            assert '<!DOCTYPE' not in new and 'Corel' not in new
    release.EXPECTED = expected
    release.prepare()
    print('APPROVED_SCOPE: six static files; application, exam app, database, and service untouched')


def verify():
    manifest = json.loads((release.STORE / 'manifest.json').read_text(encoding='utf-8'))
    count = 0
    for host in ['https://gipc.org.ge', 'https://www.gipc.org.ge']:
        for name in FILES:
            url = host + '/' + name.removeprefix('frontend/')
            query = '?v=20261008-1' if name == FILES[0] else '?v=20261008-logo2' if name == FILES[1] else '?check=header-logo-20261008-01'
            request = urllib.request.Request(url + query, headers={'Cache-Control': 'no-cache'})
            with urllib.request.urlopen(request, timeout=20) as response:
                assert response.status == 200
                assert release.digest(response.read()) == manifest['files'][name]['after'], url
                if name == FILES[0]:
                    assert response.headers.get_content_type() == 'image/svg+xml'
            count += 1
        with urllib.request.urlopen(host + '/', timeout=20) as response:
            assert response.status == 200
            assert release.digest(response.read()) == manifest['files']['frontend/pages/index.html']['after']
    result = release.remote("print(json.dumps({'service_active': True, 'pid': service_pid()}))")
    assert result['pid'] == manifest['pid']
    result.update({'https_files_verified': count, 'both_homepages_verified': True,
                   'backend_pid_unchanged': True, 'server_backup_created': False})
    (release.STORE / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
