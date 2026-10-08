const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r\n/g, '\n');

function loaderHarness() {
  const scripts = [], timers = new Map();
  let timerId = 0;
  const context = { console, Intl, Date, Uint8Array, Map,
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    document: { createElement() {
      const listeners = {};
      return { dataset: {}, addEventListener(name, fn) { listeners[name] = fn; },
        remove() { this.removed = true; }, dispatch(name) { listeners[name]?.(); } };
    }, head: { appendChild(script) { scripts.push(script); } } },
  };
  context.window = context;
  vm.runInNewContext(read('scripts/admin/shared.js'), context);
  return { load: context.AdminShared.loadExternalScript, scripts, timers, context };
}

test('document tools do not download until requested; concurrent callers share one load', async () => {
  const {load, scripts, timers} = loaderHarness();
  assert.equal(scripts.length, 0);
  const first = load('../vendor/jspdf.umd.min.js');
  const second = load('../vendor/jspdf.umd.min.js');
  assert.strictEqual(first, second);
  assert.equal(scripts.length, 1);
  scripts[0].dispatch('load');
  await Promise.all([first, second]);
  await load('../vendor/jspdf.umd.min.js');
  assert.equal(scripts.length, 1);
  assert.equal(timers.size, 0);
});

test('a failed tool download is removed and can be retried', async () => {
  const {load, scripts} = loaderHarness();
  const first = load('../vendor/svg2pdf.min.js');
  scripts[0].dispatch('error');
  await assert.rejects(first, /could not be loaded/);
  assert.equal(scripts[0].removed, true);
  const second = load('../vendor/svg2pdf.min.js');
  assert.equal(scripts.length, 2);
  scripts[1].dispatch('load');
  await second;
});

test('a timed-out tool load does not hang actions or poison retry', async () => {
  const {load, scripts, timers} = loaderHarness();
  const first = load('../vendor/mammoth.browser.min.js');
  [...timers.values()][0]();
  await assert.rejects(first, /timed out/);
  const retry = load('../vendor/mammoth.browser.min.js');
  scripts[0].dispatch('load'); // Ignore a late event from the removed attempt.
  assert.equal(scripts.length, 2);
  scripts[1].dispatch('load');
  await retry;
  assert.equal(timers.size, 0);
});

test('Word import loads the local tool only after selecting a document', async () => {
  const elements = new Map(), requests = [], messages = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value: '', innerHTML: '', listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; }});
    return elements.get(id);
  };
  const context = {console, document: {getElementById: element},
    FileReader: class { readAsArrayBuffer() { this.onload({target: {result: new ArrayBuffer(4)}}); } }};
  context.window = context;
  vm.runInNewContext(read('scripts/admin/documents.js'), context);
  const module = context.AdminModules.createDocumentsModule({
    API_BASE: '/api', showToast: text => messages.push(text), escapeHtml: x => x,
    getAdminHeaders: () => ({}), getActorHeaders: () => ({}),
    async loadExternalScript(src) { requests.push(src); context.mammoth = {async convertToHtml() { return {value: '<p>ქართული დოკუმენტი</p>'}; }}; },
  });
  module.init();
  assert.equal(requests.length, 0);
  await element('documentFile').listeners.change({target: {files: [{name: 'test.docx'}]}});
  assert.deepEqual(requests, ['../vendor/mammoth.browser.min.js']);
  assert.equal(element('documentContent').innerHTML, '<p>ქართული დოკუმენტი</p>');
  await element('documentFile').listeners.change({target: {files: [{name: 'second.docx'}]}});
  assert.equal(requests.length, 1);
  assert.equal(messages.length, 2);
});

test('certificate PDF loader respects jsPDF then svg2pdf dependency order', async () => {
  const source = read('scripts/admin/certificate.js');
  const body = source.match(/async function ensureVectorPdfLibrariesLoaded\(\) \{([\s\S]*?)\n    \}\n/)[1];
  const calls = [], context = {global: {}, findSvg2PdfFunction: () => context.global.svg2pdf,
    async loadExternalScript(src) { calls.push(src); if (src.includes('jspdf')) context.global.jspdf = {jsPDF() {}}; else {assert(context.global.jspdf); context.global.svg2pdf = () => {}; } }};
  const fn = vm.runInNewContext('(async function(){' + body + '})', context);
  assert.equal(await fn(), true);
  assert.deepEqual(calls, ['../vendor/jspdf.umd.min.js', '../vendor/svg2pdf.min.js']);
  await fn(); assert.equal(calls.length, 2);
});

test('a slow Word import cannot overwrite a newer file or save the loading placeholder', async () => {
  const elements = new Map(), conversions = [], messages = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {value: '', innerHTML: '', style: {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; }});
    return elements.get(id);
  };
  const context = {console, document: {getElementById: element},
    mammoth: {convertToHtml() { return new Promise(resolve => conversions.push(resolve)); }},
    FileReader: class {readAsArrayBuffer() {this.onload({target: {result: new ArrayBuffer(4)}});}}};
  context.window = context;
  vm.runInNewContext(read('scripts/admin/documents.js'), context);
  context.AdminModules.createDocumentsModule({showToast: text => messages.push(text)}).init();
  const select = name => element('documentFile').listeners.change({target: {files: [{name}]}});
  const first = select('first.docx');
  await element('documentAddBtn').listeners.click();
  assert.equal(messages.length, 1);
  assert.match(messages[0], /დაელოდოთ/);
  const second = select('second.docx');
  conversions[1]({value: '<p>მეორე</p>'}); await second;
  conversions[0]({value: '<p>პირველი</p>'}); await first;
  assert.equal(element('documentContent').innerHTML, '<p>მეორე</p>');
  const third = select('third.docx');
  element('documentCancelEdit').listeners.click();
  conversions[2]({value: '<p>ძველი</p>'}); await third;
  assert.equal(element('documentContent').innerHTML, '');
});

test('public profile does not download unused PDF tooling', () => {
  assert.doesNotMatch(read('pages/my.html'), /<script[^>]*vendor\/(?:jspdf|svg2pdf|mammoth)/);
  assert.match(read('scripts/my.js'), /users\/\$\{encodeURIComponent\(targetId\)\}\/certificate\/file/);
});

test('admin entry point defers Word and PDF libraries until an action needs them', () => {
  assert.doesNotMatch(read('pages/admin.html'), /<script[^>]*vendor\/(?:jspdf|svg2pdf|mammoth)/);
  for (const name of ['shared', 'certificate', 'results', 'project-results', 'statements', 'documents']) {
    assert.ok(read('pages/admin.html').includes(`scripts/admin/${name}.js?v=20261008-perf1`));
  }
});

test('results and statements use the existing local PDF library, not a CDN', () => {
  for (const name of ['results', 'project-results', 'statements']) {
    const source = read(`scripts/admin/${name}.js`);
    assert.match(source, /loadExternalScript\('\.\.\/vendor\/jspdf\.umd\.min\.js'\)/);
    assert.doesNotMatch(source, /cdnjs|unpkg|jsdelivr/);
  }
});
