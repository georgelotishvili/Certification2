const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontend = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(frontend, relative), 'utf8');
const svg = read('assets/svg/logo.svg');

// Asset-only checks: no browser session, server request, or account mutation.
test('header logo retains the supplied vector canvas and three paths', () => {
  assert.match(svg, /<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /\bviewBox="0 0 73\.74 24\.16"/);
  const paths = [...svg.matchAll(/<path\b([^>]*)\/>/g)];
  assert.equal(paths.length, 3);
  assert.deepEqual(paths.map(([, attributes]) => attributes.match(/\bclass="([^"]+)"/)[1]),
    ['fil0', 'fil1', 'fil2']);
  for (const [, attributes] of paths) assert.match(attributes, /\bd="M[^"]+"/);
  assert.match(svg, /<\/svg>\s*$/);
});

test('header logo preserves red, blue, white, and distinct fill rules', () => {
  assert.match(svg, /\.fil0\s*\{\s*fill:\s*#EA1F27\s*\}/);
  assert.match(svg, /\.fil1\s*\{\s*fill:\s*#1C468C\s*\}/);
  assert.match(svg, /\.fil2\s*\{\s*fill:\s*white;\s*fill-rule:\s*nonzero\s*\}/);
  assert.match(svg.match(/<svg\b[^>]*>/)[0], /fill-rule:evenodd;\s*clip-rule:evenodd/);
});

test('header logo is self-contained passive vector artwork', () => {
  const allowedTags = new Set(['svg', 'defs', 'style', 'g', 'path']);
  for (const [, tag] of svg.matchAll(/<(?![!?/])([\w:-]+)\b/g)) {
    assert.ok(allowedTags.has(tag), `Unexpected SVG element: ${tag}`);
  }
  assert.doesNotMatch(svg, /\s(?:on[\w:-]+|(?:xlink:)?href|src)\s*=/i);
  assert.doesNotMatch(svg, /@import|\burl\s*\(|javascript:|data:|<!ENTITY/i);
  const withoutNamespace = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
  assert.doesNotMatch(withoutNamespace, /https?:\/\//i);
});

test('header logo has no Corel export metadata or external doctype', () => {
  assert.doesNotMatch(svg, /corel|xodm|xmlns:xlink|xml:space|<!DOCTYPE|<metadata\b|<!--/i);
});

test('shared header uses the versioned logo asset and meaningful alternative text', () => {
  const header = read('partials/header.html');
  const logoContainer = header.match(/<div\s+class="logo">([\s\S]*?)<\/div>/);
  assert.ok(logoContainer);
  assert.match(logoContainer[1], /<img\s+src="\.\.\/assets\/svg\/logo\.svg\?v=20261008-1"\s+alt="GIPC"\s*\/>/);
  assert.equal((header.match(/assets\/svg\/logo\.svg/g) || []).length, 1);
});

test('header logo is twenty percent wider without distorting its aspect ratio', () => {
  const css = read('styles/header.css');
  const imageRule = css.match(/\.logo\s+img\s*\{([^}]+)\}/);
  assert.ok(imageRule);
  assert.match(imageRule[1], /\bwidth:\s*169\.2px\s*;/);
  assert.match(imageRule[1], /\bheight:\s*auto\s*;/);
  assert.match(imageRule[1], /\bobject-fit:\s*contain\s*;/);
});

for (const page of ['index', 'my', 'registry']) {
  test(`${page} page refreshes the shared header stylesheet for the new logo`, () => {
    const html = read(`pages/${page}.html`);
    assert.match(html, /href="\.\.\/styles\/header\.css\?v=20261013-statements1"/);
    assert.equal((html.match(/styles\/header\.css/g) || []).length, 1);
  });
}
