const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin/users.js'), 'utf8');
const start = source.indexOf('    function populateContractHtmlForUser(');
const end = source.indexOf('    async function fetchContractTemplates', start);
assert.ok(start >= 0 && end > start, 'production personalization function must exist');
const fields = {
  full_name: 'Synthetic Candidate', personal_id: '99900000123', phone: '555000111',
  email: 'audit@example.invalid', code: '9988776655', date: '30.10.2026',
  requested_category: 'A', requested_category_label: 'კატეგორია A',
  admission_regime: 'standard', admission_regime_label: 'სტანდარტული რეჟიმი',
  director_name: 'Synthetic Director', director_personal_id: '99900000124',
};
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const populate = vm.runInNewContext(`(${source.slice(start, end).trim()})`, {
  extractUserContractFields: () => fields, escapeHtml, CONTRACT_CATEGORY_OPTIONS: [],
});

for (const tag of ['strong', 'b']) {
  test(`${tag}: only category/regime labels become normal; chosen values stay bold`, () => {
    const html = `<p><${tag}>მოთხოვნილი კატეგორია:</${tag}> _________________________</p>`
      + `<p><${tag}>დაშვების რეჟიმი:</${tag}> _________________________</p>`;
    const result = populate(html, { id: 1 });
    assert.equal(result,
      '<p>მოთხოვნილი კატეგორია: <strong class="contract-filled-value">კატეგორია A</strong></p>'
      + '<p>დაშვების რეჟიმი: <strong class="contract-filled-value">სტანდარტული რეჟიმი</strong></p>');
  });
}

test('label attributes/whitespace are accepted without changing existing filled values', () => {
  const html = '<p><STRONG class="old-label"> მოთხოვნილი  კატეგორია : </STRONG>'
    + '<strong class="contract-filled-value">კატეგორია A</strong></p>'
    + '<p><b data-label="regime">დაშვების\nრეჟიმი:</b> '
    + '<strong class="contract-filled-value">სტანდარტული რეჟიმი</strong></p>';
  const result = populate(html, { id: 1 });
  assert.ok(result.includes('<p> მოთხოვნილი  კატეგორია : <strong class="contract-filled-value">კატეგორია A</strong></p>'));
  assert.ok(result.includes('<p>დაშვების\nრეჟიმი: <strong class="contract-filled-value">სტანდარტული რეჟიმი</strong></p>'));
});

test('unrelated headings, bold prose and a longer label-like heading are untouched', () => {
  const html = '<h2><strong>განაცხადის მონაცემები:</strong></h2>'
    + '<p><b>დირექტორი:</b> <strong>Synthetic Director</strong></p>'
    + '<p><strong>მოთხოვნილი კატეგორია: დამატებითი ინფორმაცია</strong></p>'
    + '<p><strong>დაშვების რეჟიმი</strong></p>';
  assert.equal(populate(html, { id: 1 }), html);
});

test('the raw public template is not reformatted or personalized without a user', () => {
  const html = '<p><strong>მოთხოვნილი კატეგორია:</strong> _________________________</p>';
  assert.equal(populate(html, null), html);
});

test('wrapping measures the same bold or normal spaces that the PDF draws', () => {
  const first = source.indexOf('        const isSameBoldSegment =');
  const last = source.indexOf('        const drawSegmentedLine =', first);
  assert.ok(first >= 0 && last > first);
  let style = 'normal';
  const pdf = {
    setFont(_name, value) { style = value; },
    getTextWidth(text) { return text.length * (style === 'bold' ? 5 : 3); },
  };
  const helpers = vm.runInNewContext(`${source.slice(first, last)}
    ;({measureWordGapWidth, coalesceLineRuns});`, {pdf, fontName: 'test-font'});
  const word = (text, bold, segId) => ({plainText: text, parts: [{text, bold, segId}]});
  for (const [left, right, expectedGap] of [
    [word('A', true, 1), word('B', true, 1), 5],
    [word('A', true, 1), word('B', true, 2), 3],
    [word('A', false, 0), word('B', true, 1), 3],
    [word('A', true, 1), word('B', false, 0), 3],
  ]) {
    assert.equal(helpers.measureWordGapWidth(left, right), expectedGap);
    const renderedWidth = helpers.coalesceLineRuns([{word: left}, {word: right}])
      .reduce((width, run) => width + run.text.length * (run.bold ? 5 : 3), 0);
    const measuredWidth = (left.parts[0].bold ? 5 : 3) + expectedGap
      + (right.parts[0].bold ? 5 : 3);
    assert.equal(renderedWidth, measuredWidth);
  }
});
