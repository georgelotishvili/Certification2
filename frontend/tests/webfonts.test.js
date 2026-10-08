const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fonts = path.join(__dirname, '..', 'assets', 'fonts');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const cases = [
  ['dejavu-sans', '7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954',
    '7c01007ae98f979700ece335071046091c467fdbacd884786232056839538881'],
  ['bpg_nino_mtavruli_bold', 'daaf598286ceebe8ed7719e66b8f4ae4582f1cb8a4b7dd85dbeca38267f99284',
    '0a6fe7a613c69b6990ef1d1ac10778659faf145970a4e1631e40939580dfd7bc'],
];

for (const [name, originalHash, webHash] of cases) {
  test(`${name}: original PDF font unchanged; verified full-glyph WOFF2 is smaller`, () => {
    const ttf = fs.readFileSync(path.join(fonts, `${name}.ttf`));
    const woff2 = fs.readFileSync(path.join(fonts, `${name}.woff2`));
    assert.equal(hash(ttf), originalHash);
    // These hashes identify artifacts whose outlines/metrics/cmap/hinting are
    // compared glyph-by-glyph by tools/build_webfonts.py --check.
    assert.equal(hash(woff2), webHash);
    assert.equal(woff2.toString('ascii', 0, 4), 'wOF2');
    assert.equal(woff2.readUInt32BE(8), woff2.length);
    assert.equal(woff2.readUInt16BE(12), ttf.readUInt16BE(4));
    assert.ok(woff2.length < ttf.length * 0.6);
  });
}

test('PDF exporters continue using the original TTF files, not webfonts', () => {
  for (const file of ['certificate.js', 'statements.js', 'results.js', 'project-results.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'admin', file), 'utf8');
    assert.match(source, /assets\/fonts\/dejavu-sans\.ttf/);
    assert.doesNotMatch(source, /dejavu-sans\.woff2/);
  }
});
