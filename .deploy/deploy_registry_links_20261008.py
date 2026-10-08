"""Correct three registry links in two HTML files; no service/database changes."""
import json
import sys
import urllib.request
import deploy_independent_statements_20261008 as release

FILES = ['frontend/partials/header.html', 'frontend/pages/index.html']
release.FILES = FILES
release.STORE = release.ROOT / '.deploy/registry-links-20261008-01'
previous = json.loads((release.ROOT / '.deploy/public-qr-20261008-01/manifest.json').read_text(encoding='utf-8'))
release.EXPECTED = {name: previous['files'][name]['after'] for name in FILES}
release.REMOTE += '\nFILES = ' + repr(FILES) + '\n'


def verify():
    manifest = json.loads((release.STORE / 'manifest.json').read_text(encoding='utf-8'))
    for name in FILES:
        url = 'https://gipc.org.ge/' + name[len('frontend/'):] + '?check=registry-links-20261008-01'
        request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            assert response.status == 200
            assert release.digest(response.read()) == manifest['files'][name]['after']
    for host in ['https://gipc.org.ge/', 'https://www.gipc.org.ge/']:
        with urllib.request.urlopen(host, timeout=20) as response:
            assert response.status == 200
            assert release.digest(response.read()) == manifest['files']['frontend/pages/index.html']['after']
    result = release.remote("print(json.dumps({'service_active': True, 'pid': service_pid()}))")
    assert result['pid'] == manifest['pid']
    print(json.dumps({'https_files_verified': 2, 'both_homepages_verified': True, 'backend_pid_unchanged': True}))


if __name__ == '__main__':
    {'prepare': release.prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
