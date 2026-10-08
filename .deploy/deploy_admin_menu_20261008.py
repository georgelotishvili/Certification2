"""Publish only the approved desktop/mobile admin menu text and ordering."""
import json
import re
import sys
import urllib.request
import deploy_independent_statements_20261008 as release

FILES = ['frontend/pages/admin.html']
release.FILES = FILES
release.STORE = release.ROOT / '.deploy/admin-menu-20261008-01'
previous = json.loads((release.ROOT / '.deploy/qr-center-20261008-01/manifest.json').read_text(encoding='utf-8'))
release.EXPECTED = {name: previous['files'][name]['after'] for name in FILES}
release.REMOTE += '\nFILES = ' + repr(FILES) + '\n'
EXPECTED_MENU = [
    ('guide', 'გზამკვლევი'),
    ('regulations', 'რეგულაციები'),
    ('applicationForm', 'განაცხადის ფორმა'),
    ('app', 'საგამოცდო აპი'),
    ('documents', 'დოკუმენტის დამატება'),
]


def check_menus(content):
    html = content.decode('utf-8')
    for menu_class in ['other-dropdown', 'drawer-other-submenu']:
        menu = re.search(r'<div\b[^>]*class="[^"]*\b' + menu_class + r'\b[^"]*"[^>]*>(.*?)</div>', html, re.S)
        assert menu, 'Missing menu: ' + menu_class
        entries = re.findall(r'<a\b[^>]*data-target="([^"]+)"[^>]*>([^<]*)</a>', menu.group(1))
        assert entries == EXPECTED_MENU, 'Wrong menu order or label'


def prepare():
    check_menus((release.ROOT / FILES[0]).read_bytes())
    release.prepare()
    print('RELEASE_SCOPE: one HTML file; no scripts or server data')


def verify():
    manifest = json.loads((release.STORE / 'manifest.json').read_text(encoding='utf-8'))
    for host in ['https://gipc.org.ge', 'https://www.gipc.org.ge']:
        request = urllib.request.Request(host + '/pages/admin.html?check=admin-menu-20261008-01',
                                         headers={'Cache-Control': 'no-cache'})
        with urllib.request.urlopen(request, timeout=20) as response:
            content = response.read()
            assert response.status == 200
            assert release.digest(content) == manifest['files'][FILES[0]]['after']
            check_menus(content)
        with urllib.request.urlopen(host + '/', timeout=20) as response:
            assert response.status == 200
    result = release.remote("print(json.dumps({'service_active': True, 'pid': service_pid()}))")
    assert result['pid'] == manifest['pid']
    result.update({'https_file_verified_on_both_hosts': True, 'both_menu_labels_and_order_verified': True,
                   'backend_pid_unchanged': True, 'file_count': 1})
    (release.STORE / 'verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result))


if __name__ == '__main__':
    {'prepare': prepare, 'apply': release.apply, 'verify': verify}[sys.argv[1]]()
