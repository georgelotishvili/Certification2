"""Deploy only the registry's row CSS and its HTML cache version/note."""
import json
import sys
import urllib.request
import deploy_independent_statements_20261008 as release

FILES = ['frontend/styles/registry.css', 'frontend/pages/registry.html']
release.FILES = FILES
release.STORE = release.ROOT / '.deploy/registry-rows-20261008-01'
previous = json.loads((release.ROOT / '.deploy/public-qr-20261008-01/manifest.json').read_text(encoding='utf-8'))
release.EXPECTED = {name: previous['files'][name]['after'] for name in FILES}
release.REMOTE += '\nFILES = ' + repr(FILES) + '\n'


def verify():
    manifest = json.loads((release.STORE / 'manifest.json').read_text(encoding='utf-8'))
    for host in ['https://gipc.org.ge', 'https://www.gipc.org.ge']:
        for name in FILES:
            url = host + '/' + name[len('frontend/'):] + '?check=registry-rows-20261008-01'
            request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
            with urllib.request.urlopen(request, timeout=20) as response:
                assert response.status == 200
                assert release.digest(response.read()) == manifest['files'][name]['after']
        with urllib.request.urlopen(host + '/', timeout=20) as response:
            assert response.status == 200
    result = release.remote("print(json.dumps({'service_active': True, 'pid': service_pid()}))")
    assert result['pid'] == manifest['pid']
    result.update({'https_files_verified_on_both_hosts': True, 'backend_pid_unchanged': True})
    (release.STORE / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    {'prepare': release.prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
