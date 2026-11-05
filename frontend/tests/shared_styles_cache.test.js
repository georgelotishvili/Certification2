const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.resolve(__dirname, '..');
const pages = path.join(frontend, 'pages');

test('pages share one versioned URL for the common stylesheet', () => {
  const references = [];
  for (const name of fs.readdirSync(pages).filter(name => name.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(pages, name), 'utf8');
    for (const match of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      const url = new URL(match[1], `https://synthetic.invalid/pages/${name}`);
      if (url.pathname !== '/styles/styles.css') continue;
      assert.ok(url.searchParams.get('v'), `${name}: missing stylesheet cache version`);
      assert.ok(fs.statSync(path.join(frontend, url.pathname.slice(1))).isFile());
      references.push({ page: name, url: url.pathname + url.search });
    }
  }
  for (const page of ['index.html', 'documents.html', 'my.html', 'registry.html']) {
    assert.ok(references.some(reference => reference.page === page), `${page}: missing common stylesheet`);
  }
  assert.equal(new Set(references.map(reference => reference.url)).size, 1,
    `Common stylesheet URLs diverged: ${JSON.stringify(references)}`);
});
