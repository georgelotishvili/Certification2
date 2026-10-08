"""Release only registry colors/edge accent and its stylesheet cache version."""
import json
import sys
import urllib.request

import deploy_independent_statements_20261008 as release

FILES = ['frontend/styles/registry.css', 'frontend/pages/registry.html']
release.FILES = FILES
release.STORE = release.ROOT / '.deploy/registry-accent-20261008-01'
previous = json.loads((release.ROOT / '.deploy/performance-release-20261008-01/manifest.json').read_text(encoding='utf-8'))
release.EXPECTED = {name: previous['files'][name]['after'] for name in FILES}
release.REMOTE += '\nFILES = ' + repr(FILES) + '\n'


def fetch(url):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=20) as response:
        assert response.status == 200, url
        return response.read()


def verify():
    manifest = json.loads((release.STORE / 'manifest.json').read_text(encoding='utf-8'))
    for host in ['https://gipc.org.ge', 'https://www.gipc.org.ge']:
        for name in FILES:
            path = name[len('frontend/'):]
            assert release.digest(fetch(host + '/' + path + '?check=registry-accent-20261008-01')) == manifest['files'][name]['after'], path
        html = fetch(host + '/pages/registry.html')
        assert b'registry.css?v=20261008-accent1' in html
        assert release.digest(fetch(host + '/styles/registry.css?v=20261008-accent1')) == manifest['files'][FILES[0]]['after']
        fetch(host + '/')
        page = json.loads(fetch(host + '/certified-persons/registry/page?limit=2'))
        assert isinstance(page['items'], list) and isinstance(page['total'], int)
        legacy = json.loads(fetch(host + '/certified-persons/registry'))
        assert isinstance(legacy, list) and len(legacy) == page['total']
    result = release.remote("print(json.dumps({'pid': service_pid()}))")
    assert result['pid'] == manifest['pid']
    result.update(https_files_verified_on_both_hosts=True, registry_api_ok=True, legacy_registry_ok=True, homepage_ok=True, backend_pid_unchanged=True)
    (release.STORE / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


def rollback():
    manifest = json.loads((release.STORE / 'manifest.json').read_text(encoding='utf-8'))
    payload = {}
    for name in FILES:
        content = (release.STORE / 'before' / name).read_bytes()
        assert release.digest(content) == manifest['files'][name]['before']
        payload[name] = {**manifest['files'][name], 'data': release.base64.b64encode(content).decode()}
    action = 'payload = ' + repr(payload) + '\n' + r'''
for name in FILES:
    assert digest(target(name).read_bytes()) == payload[name]['after'], 'Production drift: ' + name
for name in reversed(FILES):
    p = target(name)
    content = base64.b64decode(payload[name]['data'], validate=True)
    assert digest(content) == payload[name]['before']
    replace(p, content, p.stat())
print(json.dumps({'status': 'rolled_back', 'files': FILES}))
'''
    print(json.dumps(release.remote(action)))


def deploy():
    release.apply()
    try:
        verify()
    except BaseException:
        rollback()
        raise


if __name__ == '__main__':
    {'prepare': release.prepare, 'deploy': deploy, 'verify': verify, 'rollback': rollback}[sys.argv[1]]()
