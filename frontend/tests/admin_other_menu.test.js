const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../pages/admin.html'), 'utf8');
const expected = [
  ['section', 'guide', 'გზამკვლევი'],
  ['section', 'regulations', 'რეგულაციები'],
  ['section', 'applicationForm', 'განაცხადის ფორმა'],
  ['action', 'audit-log', 'ლოგირება'],
  ['action', 'admin-mfa', 'უსაფრთხოება'],
];

for (const menuClass of ['other-dropdown', 'drawer-other-submenu']) {
  test(`${menuClass}: requested wording and order keep the existing section targets`, () => {
    const menu = html.match(new RegExp(`<div\\b[^>]*class="[^"]*\\b${menuClass}\\b[^"]*"[^>]*>([\\s\\S]*?)</div>`));
    assert.ok(menu, 'menu exists');
    const entries = [...menu[1].matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(([, attrs, label]) => {
      assert.match(attrs, /href="#"/);
      const target = attrs.match(/\bdata-target="([^"]+)"/);
      const auditAction = /\bdata-open-audit-log="true"/.test(attrs);
      const mfaAction = /\bdata-admin-mfa-settings\b/.test(attrs);
      assert.equal(Number(!!target) + Number(auditAction) + Number(mfaAction), 1,
        'each entry needs exactly one explicit section, audit-modal or MFA action');
      return target ? ['section', target[1], label.trim()] : ['action', mfaAction ? 'admin-mfa' : 'audit-log', label.trim()];
    });
    assert.deepEqual(entries, expected);
  });
}
