const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..', '..');
const headerSource = fs.readFileSync(path.join(workspace, 'frontend', 'scripts', 'header.js'), 'utf8');
const usersSource = fs.readFileSync(path.join(workspace, 'frontend', 'scripts', 'admin', 'users.js'), 'utf8');

test('public document HTML passes through a DOM allowlist', () => {
  assert.match(headerSource, /function renderSafeDocumentHtml\(container, html\)/);
  assert.match(headerSource, /new DOMParser\(\)\.parseFromString/);
  assert.match(headerSource, /DOCUMENT_ALLOWED_TAGS\.has\(tagName\)/);
  assert.match(headerSource, /DOCUMENT_DROP_CONTENT_TAGS\.has\(tagName\)/);
  assert.match(headerSource, /renderSafeDocumentHtml\(els\.body, doc\.content\)/);
  assert.doesNotMatch(headerSource, /els\.body\.innerHTML\s*=\s*doc\.content/);
});

test('document allowlist drops executable elements and restricts links', () => {
  const blocked = headerSource.slice(
    headerSource.indexOf('const DOCUMENT_DROP_CONTENT_TAGS'),
    headerSource.indexOf('const DOCUMENT_ALLOWED_STYLE_PROPERTIES'),
  );
  for (const tag of ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM']) {
    assert.match(blocked, new RegExp(`'${tag}'`));
  }
  assert.match(headerSource, /\['http:', 'https:', 'mailto:', 'tel:'\]\.includes\(parsed\.protocol\)/);
  assert.match(headerSource, /target\.setAttribute\('rel', 'noopener noreferrer'\)/);
});

test('admin result values are built as text nodes, not interpolated HTML', () => {
  assert.match(usersSource, /showModal\(`მრავალბინიანი: \$\{userName\}`, buildResultsTable\(items\)\)/);
  assert.match(usersSource, /cell\.textContent = String\(text \?\? ''\)/);
  assert.doesNotMatch(usersSource, /\$\{item\.projectName \|\| item\.projectCode\}/);

  const modalSource = usersSource.slice(
    usersSource.indexOf('function showModal'),
    usersSource.indexOf('\n    return {', usersSource.indexOf('function showModal')),
  );
  assert.doesNotMatch(modalSource, /\$\{title\}|\$\{content\}/);
  assert.match(modalSource, /textContent = String\(title \|\| ''\)/);
  assert.match(modalSource, /appendChild\(content\)/);
});
