const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const frontend = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(frontend, relative), 'utf8');
const source = read('scripts/admin/certificate.js');

// Isolated DOM/PDF adapters. These tests exercise real module event handlers but
// never contact a server, use credentials, save a PDF, or change a real account.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase(); this.children = []; this.attributes = {};
    this.dataset = {}; this.events = {}; this.style = {}; this._text = ''; this.value = '';
    this.disabled = false; this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      contains: (name) => this._classes.has(name),
      toggle: (name, force = !this._classes.has(name)) => {
        if (force) this._classes.add(name); else this._classes.delete(name);
        return force;
      },
      [Symbol.iterator]: () => this._classes.values(),
    };
  }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    this._text = ''; this.children = [];
    const stack = [this];
    for (const token of String(value).match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g) || []) {
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<([\w-]+)/)[1];
        const node = new Element(tag);
        for (const [, name, double, single, bare] of token.matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          node.setAttribute(name, double ?? single ?? bare ?? '');
        }
        stack.at(-1).appendChild(node);
        if (!['input', 'img', 'br', 'meta', 'link'].includes(tag) && !token.endsWith('/>')) stack.push(node);
      } else {
        const node = new Element('#text'); node.textContent = token; stack.at(-1).appendChild(node);
      }
    }
  }
  get parentNode() { return this.parentElement || null; }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) {
    child.remove(); child.parentElement = this; this.children.push(child); return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); child.parentElement = null; return child; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  contains(other) { return this === other || this.children.some((child) => child.contains(other)); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    else this[name] = String(value);
    if (this.tagName === 'LINK' && name === 'href') {
      this.sheet = {};
      queueMicrotask(() => { this.onload?.(); this.dispatch('load'); });
    }
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    const tag = selector.match(/^[\w-]+/);
    if (tag && tag[0].toUpperCase() !== this.tagName) return false;
    const id = selector.match(/#([\w-]+)/);
    if (id && this.id !== id[1]) return false;
    if ([...selector.matchAll(/\.([\w-]+)/g)].some(([, name]) => !this._classes.has(name))) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (this.getAttribute(name) == null) return false;
      if (value !== undefined && this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  cloneNode(deep) {
    const node = new Element(this.tagName);
    Object.entries(this.attributes).forEach(([key, value]) => node.setAttribute(key, value));
    node.className = this.className; node.style = { ...this.style }; node.dataset = { ...this.dataset };
    node._text = this._text; node.value = this.value;
    if (deep) this.children.forEach((child) => node.appendChild(child.cloneNode(true)));
    return node;
  }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  removeEventListener(name, handler) { this.events[name] = (this.events[name] || []).filter((item) => item !== handler); }
  async dispatch(name, detail = {}) {
    await Promise.all((this.events[name] || []).map((handler) => handler({ target: this, preventDefault() {}, ...detail })));
  }
  reset() { this.querySelectorAll('input').forEach((input) => { input.value = ''; }); }
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 1123, height: 793 }; }
}

function person(id = 41, level = 'architect', status = 'active') {
  return { id, first_name: `Person${id}`, last_name: 'Example', personal_id: '12345678901', code: String(1000000000 + id),
    certificate: { unique_code: String(1000000000 + id), level, status, issue_date: '2026-01-01', validity_term: 5, valid_until: '2031-01-01' } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const DOM = {};
  const document = new Element('document');
  document.body = new Element('body'); document.head = new Element('head');
  document.append(document.head, document.body);
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_namespace, tag) => new Element(tag);
  document.importNode = (node, deep) => node.cloneNode(deep);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.fonts = { ready: Promise.resolve() };
  for (const key of ['userCertificateOverlay', 'userCertificateClose', 'userCertificateDownload', 'userCertificateDelete',
    'certificateEditBtn', 'certificateEmptyState', 'certificateEmptyCreate', 'certificateCard', 'certificateStatusBadge']) {
    DOM[key] = new Element(key.includes('Btn') || /Download|Close|Delete/.test(key) ? 'button' : 'div');
    DOM[key].id = key;
    if (key === 'userCertificateOverlay') document.body.appendChild(DOM[key]);
    else DOM.userCertificateOverlay.appendChild(DOM[key]);
  }
  DOM.userCertificateDownload.textContent = 'PDF';
  if (options.withForm) {
    DOM.certificateForm = new Element('form');
    DOM.userCertificateOverlay.appendChild(DOM.certificateForm);
    for (const suffix of ['Submit', 'Code', 'Level', 'Status', 'IssueDate', 'ValidityTerm', 'ValidUntil']) {
      const element = new Element(suffix === 'Submit' ? 'button' : 'input');
      DOM[`certificateForm${suffix}`] = element;
      DOM.certificateForm.appendChild(element);
    }
  }
  const container = new Element(); container.id = 'certificateTemplateContainer'; DOM.certificateCard.appendChild(container);
  const state = { requests: [], pdfs: [], renders: [], uploads: [], deliveries: [], toasts: [], prepares: [], updates: [] };
  const window = { document, location: { origin: 'http://local.test', pathname: '/pages/admin.html' },
    innerWidth: 1400, innerHeight: 1000, addEventListener() {}, confirm: () => true,
    getComputedStyle: () => ({ textAlign: 'left', fontSize: '16px', color: '#123456' }),
  };
  class FakePDF {
    constructor(...args) {
      this.args = args; state.pdfs.push(this);
      this.internal = { pageSize: { getWidth: () => 841.8897637795277, getHeight: () => 595.2755905511812 } };
    }
    getFontList() { return { DejaVuSans: ['normal'], BPGNino: ['bold'] }; }
    async output(kind) { assert.equal(kind, 'blob'); return { type: 'application/pdf', qr: true }; }
  }
  window.jspdf = { jsPDF: FakePDF };
  window.svg2pdf = async (svg, pdf, dimensions) => {
    state.renders.push({ svg: svg.cloneNode(true), pdf, dimensions });
    if (options.renderGate) await options.renderGate.promise;
  };
  const fetch = async (address, request = {}) => {
    state.requests.push({ address, request });
    if (address.endsWith('/certificate/file')) {
      assert.equal(request.method, 'POST'); state.uploads.push({ address, request }); return { ok: true };
    }
    if (/\/users\/\d+\/certificate$/.test(address)) {
      if (request.method === 'PUT') {
        return { ok: true, json: async () => {
          if (options.mutationGate) await options.mutationGate.promise;
          return JSON.parse(request.body);
        } };
      }
      if (request.method === 'DELETE') {
        if (options.mutationGate) await options.mutationGate.promise;
        return { ok: true };
      }
      if (options.certificateGate && address.endsWith('/41/certificate')) await options.certificateGate.promise;
      return { ok: false, status: 404 };
    }
    const match = address.match(/^\.\.\/certificate\/(architect|expert|municipal)\.html$/);
    if (match) return { ok: !options.templateFailure, text: async () => read(`certificate/${match[1]}.html`) };
    if (address.includes(' bac.svg?')) return { ok: !options.backgroundFailure, text: async () => '<svg><g id="test-background" /></svg>' };
    throw new Error(`Unexpected test fetch: ${address}`);
  };
  class Parser {
    parseFromString(markup) { const root = new Element(); root.innerHTML = markup; return { documentElement: root.children[0] }; }
  }
  class FakeFormData {
    constructor() { this.entries = []; }
    append(...entry) { this.entries.push(entry); }
  }
  const sandbox = { window, document, fetch, console, Date, URL, DOMParser: Parser, FormData: FakeFormData,
    requestAnimationFrame: (callback) => { queueMicrotask(callback); return 1; },
    setTimeout, clearTimeout, btoa: (value) => Buffer.from(value, 'binary').toString('base64') };
  vm.createContext(sandbox);
  if (!options.noEncoder) {
    vm.runInContext(read('scripts/vendor/qrcode-generator.js'), sandbox);
    window.qrcode = sandbox.qrcode;
  }
  if (!options.noHelper) vm.runInContext(read('scripts/certificate-qr.js'), sandbox);
  vm.runInContext(source, sandbox);
  const module = window.AdminModules.createCertificateModule({ DOM, API_BASE: 'https://api.test',
    openOverlay: (node) => node.classList.add('open'), closeOverlay: (node) => node.classList.remove('open'),
    showToast: (...args) => state.toasts.push(args),
    onUserCertificateUpdated: (...args) => state.updates.push(args),
    getAdminHeaders: () => ({ 'X-Test-Admin': 'isolated' }),
    getActorHeaders: () => ({ 'X-Test-Actor': 'isolated' }),
    preparePdfSaveHandle: async (...args) => {
      state.prepares.push(args);
      if (options.saveGate) return options.saveGate.promise;
      return { handle: null, aborted: !!options.abort };
    },
    deliverPdf: async (...args) => { state.deliveries.push(args); return true; },
  });
  module.init();
  return { DOM, document, container, state, window, module,
    download: () => DOM.userCertificateDownload.dispatch('click') };
}

async function settle() { for (let index = 0; index < 30; index += 1) await Promise.resolve(); }

for (const level of ['architect', 'expert', 'municipal']) {
  test(`${level}: preview and PDF QR are centered in the actual colored sidebar without changing size or height`, async () => {
    const background = read(`certificate/${level === 'municipal' ? 'municip' : level} bac.svg`);
    // Read the straight sides of the shared sidebar from each real SVG, rather
    // than testing only a percentage that can drift from the artwork.
    const leftSide = background.match(/(\d+(?:\.\d+)?) 744\.761V155\.611C/);
    const rightSide = background.match(/(\d+(?:\.\d+)?) 155\.611V744\.761C/);
    assert.ok(leftSide && rightSide, 'both actual sidebar boundaries must be present');
    const left = Number(leftSide[1]); const right = Number(rightSide[1]);
    assert.equal(left, 783.628); assert.equal(right, 1019.13);
    const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.000001,
      `${label}: expected ${expected}, received ${actual}`);
    const h = harness(); await h.module.open(person(41, level)); await h.download();
    assert.equal(h.state.renders.length, 1, JSON.stringify(h.state.toasts));
    const preview = h.container.querySelector('.certificate-qr');
    const exported = h.state.renders[0].svg.querySelector('.certificate-qr');
    for (const [label, x, y, width, height] of [
      ['preview', parseFloat(preview.style.left), parseFloat(preview.style.top),
        parseFloat(preview.style.width), parseFloat(preview.style.height)],
      ['PDF', Number(exported.getAttribute('x')), Number(exported.getAttribute('y')),
        Number(exported.getAttribute('width')), Number(exported.getAttribute('height'))],
    ]) {
      near(x + width / 2, 901.379, `${label} horizontal center`);
      near(x - left, right - (x + width), `${label} equal sidebar margins`);
      near(width, 1123 * 30 / 297, `${label} unchanged 30 mm width`);
      near(height, width, `${label} square shape`);
      near(y + height / 2, 793 * 0.345, `${label} unchanged vertical center`);
    }
  });

  test(`${level}: preview and exported PDF contain the same person's QR and unchanged certificate fields`, async () => {
    const h = harness(); const user = person(41, level); const original = structuredClone(user);
    await h.module.open(user);
    const preview = h.container.querySelector('.certificate-qr');
    assert.ok(preview, 'a real QR SVG must be mounted in the preview');
    assert.equal(preview.tagName, 'SVG');
    assert.equal(preview.getAttribute('data-field'), null, 'QR is not a text-field replacement');
    assert.ok(preview.querySelector('path').getAttribute('d').length > 100);
    const expectedQr = h.window.CertificateQR.createSvg(user.code);
    assert.equal(preview.querySelector('path').getAttribute('d'), expectedQr.querySelector('path').getAttribute('d'),
      'preview QR must encode this person, not a fixed example or logged-in administrator');
    assert.equal(h.container.querySelector('[data-field="fullName"]').textContent, 'Person41 Example');
    assert.equal(h.container.querySelector('[data-field="personalId"]').textContent, user.personal_id);
    assert.equal(h.container.querySelector('[data-field="uniqueCode"]').textContent, user.code);
    assert.equal(h.DOM.certificateCard.dataset.certTier, level);
    assert.equal(h.DOM.userCertificateDownload.disabled, false);
    await h.download();
    assert.equal(h.state.renders.length, 1, JSON.stringify(h.state.toasts));
    const exportedQr = h.state.renders[0].svg.querySelector('.certificate-qr');
    assert.ok(exportedQr, 'the PDF SVG must include QR independently of [data-field] text conversion');
    assert.equal(exportedQr.querySelector('path').getAttribute('d'), preview.querySelector('path').getAttribute('d'));
    assert.equal(h.state.uploads.length, 1);
    assert.equal(h.state.uploads[0].address, 'https://api.test/users/41/certificate/file');
    assert.equal(h.state.deliveries.length, 1);
    assert.deepEqual(user, original, 'QR generation must not mutate certificate or permission data');
  });
}

test('export uses actual A4 landscape points while preserving the certificate SVG viewBox', async () => {
  const h = harness(); await h.module.open(person()); await h.download();
  assert.equal(h.state.pdfs.length, 1, JSON.stringify(h.state.toasts));
  assert.deepEqual(h.state.pdfs[0].args, ['l', 'pt', 'a4']);
  const { svg, dimensions } = h.state.renders[0];
  assert.equal(svg.getAttribute('viewBox'), '0 0 1123 793');
  assert.ok(Math.abs(Number(svg.getAttribute('width')) - 297 * 72 / 25.4) < 0.001);
  assert.ok(Math.abs(Number(svg.getAttribute('height')) - 210 * 72 / 25.4) < 0.001);
  assert.ok(Math.abs(dimensions.width - 297 * 72 / 25.4) < 0.001);
  assert.ok(Math.abs(dimensions.height - 210 * 72 / 25.4) < 0.001);
  const qr = svg.querySelector('.certificate-qr');
  const qrWidth = Number(qr.getAttribute('width')); const qrHeight = Number(qr.getAttribute('height'));
  // The outer SVG keeps the default xMidYMid meet, so the tiny legacy
  // 1123x793/A4 ratio difference does not stretch the square QR modules.
  const scaleToMm = Math.min(297 / 1123, 210 / 793);
  assert.ok(Math.abs(qrWidth * scaleToMm - 30) < 0.01, 'QR physical width is 30 mm');
  assert.ok(Math.abs(qrHeight * scaleToMm - 30) < 0.01, 'QR physical height is 30 mm');
  assert.ok(Math.abs(Number(qr.getAttribute('x')) + qrWidth / 2 - 901.379) < 0.000001);
  assert.ok(Math.abs((Number(qr.getAttribute('y')) + qrHeight / 2) / 793 - 0.345) < 0.001);
});

for (const missing of ['noHelper', 'noEncoder']) {
  test(`missing ${missing} fails closed without uploading a QR-less certificate`, async () => {
    const h = harness({ [missing]: true }); await h.module.open(person());
    await h.download();
    assert.equal(h.state.uploads.length, 0);
    assert.equal(h.state.deliveries.length, 0);
    assert.equal(h.state.renders.length, 0);
    assert.equal(h.DOM.userCertificateDownload.disabled, true);
  });
}

test('cancelled save dialog produces neither an upload nor a local PDF', async () => {
  const h = harness({ abort: true }); await h.module.open(person()); await h.download();
  assert.equal(h.state.prepares.length, 1);
  assert.equal(h.state.uploads.length, 0); assert.equal(h.state.deliveries.length, 0);
  assert.equal(h.DOM.userCertificateDownload.disabled, false);
});

for (const status of ['suspended', 'expired']) {
  test(`${status} certificate retains its existing no-export policy`, async () => {
    const h = harness(); await h.module.open(person(41, 'architect', status));
    assert.equal(h.DOM.userCertificateDownload.disabled, true);
    await h.download(); assert.equal(h.state.prepares.length, 0); assert.equal(h.state.uploads.length, 0);
  });
}

test('save dialog cannot switch the QR or upload target to another person', async () => {
  const saveGate = deferred(); const h = harness({ saveGate });
  await h.module.open(person(41));
  const originalPath = h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  const pending = h.download(); await settle();
  assert.equal(h.state.prepares.length, 1);
  await h.module.open(person(52, 'municipal'));
  h.module.close();
  await h.download();
  assert.equal(h.state.prepares.length, 1, 'double-clicks must not start another save');
  saveGate.resolve({ aborted: false, handle: null }); await pending;
  assert.equal(h.state.renders.length, 1, JSON.stringify(h.state.toasts));
  assert.equal(h.state.renders[0].svg.querySelector('.certificate-qr').querySelector('path').getAttribute('d'), originalPath);
  assert.equal(h.state.uploads.length, 1);
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/41/certificate/file');
  assert.match(h.state.deliveries[0][1], /Person41/);
  assert.equal(h.DOM.userCertificateDownload.disabled, false);
});

test('async PDF rendering keeps user identity and frees temporary SVG nodes afterward', async () => {
  const renderGate = deferred(); const h = harness({ renderGate });
  await h.module.open(person(41)); const pending = h.download(); await settle();
  assert.equal(h.state.renders.length, 1, JSON.stringify(h.state.toasts));
  await h.module.open(person(52));
  renderGate.resolve(); await pending;
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/41/certificate/file');
  assert.equal(h.document.querySelectorAll('.certificate-svg-export').length, 0);
  assert.equal(h.document.querySelectorAll('.certificate-vector-sandbox').length, 0);
});

test('opening another person regenerates the QR and never reuses the previous identity', async () => {
  const h = harness(); await h.module.open(person(41));
  const firstQr = h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  await h.module.open(person(52, 'expert')); await h.download();
  const secondQr = h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  assert.notEqual(secondQr, firstQr);
  assert.equal(secondQr, h.window.CertificateQR.createSvg(person(52).code).querySelector('path').getAttribute('d'));
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/52/certificate/file');
  assert.match(h.state.deliveries[0][1], /Person52/);
});

test('QR uses the permanent user code, never certificate metadata or personal data', async () => {
  const h = harness(); const user = person(41);
  user.code = '0000000042';
  user.certificate.unique_code = '9999999999';
  user.email = 'private@example.test';
  user.phone = '555123456';
  await h.module.open(user); await h.download();
  const expected = h.window.CertificateQR.createSvg(user.code).querySelector('path').getAttribute('d');
  const exported = h.state.renders[0].svg.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  assert.equal(exported, expected);
  assert.notEqual(exported, h.window.CertificateQR.createSvg(user.certificate.unique_code).querySelector('path').getAttribute('d'));
  const url = h.window.CertificateQR.buildProfileUrl(user.code);
  assert.equal(url, 'https://gipc.org.ge/pages/my.html?code=0000000042');
  for (const privateValue of [user.personal_id, user.email, user.phone, user.certificate.unique_code]) {
    assert.equal(url.includes(privateValue), false);
  }
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/41/certificate/file',
    'the internal account ID remains the upload target, never the public code');
});

test('re-registration with a different internal user ID preserves the same permanent QR', async () => {
  const h = harness(); const firstAccount = person(41); const replacementAccount = person(905, 'expert');
  firstAccount.code = '0000000042'; replacementAccount.code = firstAccount.code;
  await h.module.open(firstAccount); await h.download();
  const firstQr = h.state.renders[0].svg.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  await h.module.open(replacementAccount); await h.download();
  const replacementQr = h.state.renders[1].svg.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  assert.equal(replacementQr, firstQr, 'the printed QR must not depend on a replaceable user ID');
  assert.deepEqual(h.state.uploads.map((item) => item.address), [
    'https://api.test/users/41/certificate/file', 'https://api.test/users/905/certificate/file',
  ]);
});

test('a reused internal user ID with another permanent code cannot reuse the earlier QR', async () => {
  const h = harness(); const previousPerson = person(41); const differentPerson = person(41);
  differentPerson.code = '0000000042';
  await h.module.open(previousPerson);
  const previousQr = h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  await h.module.open(differentPerson);
  const differentQr = h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  assert.notEqual(differentQr, previousQr);
});

test('the captured person code cannot change during an asynchronous PDF save', async () => {
  const saveGate = deferred(); const h = harness({ saveGate }); const user = person(41);
  user.code = '0000000042';
  await h.module.open(user);
  const pending = h.download(); await settle();
  user.code = '9999999999';
  await h.module.open(person(52));
  saveGate.resolve({ aborted: false, handle: null }); await pending;
  const expected = h.window.CertificateQR.createSvg('0000000042').querySelector('path').getAttribute('d');
  assert.equal(h.state.renders[0].svg.querySelector('.certificate-qr').querySelector('path').getAttribute('d'), expected);
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/41/certificate/file');
});

test('missing or malformed user code disables PDF without falling back to certificate code or user ID', async () => {
  for (const code of [undefined, null, '', 1000000041, '41', '12345678901', '1000000041 ', '1000000041\n']) {
    const h = harness(); const user = person(41);
    user.code = code;
    await h.module.open(user); await h.download();
    assert.equal(h.DOM.userCertificateDownload.disabled, true);
    assert.equal(h.container.querySelector('.certificate-qr'), null);
    assert.equal(h.state.prepares.length, 0);
    assert.equal(h.state.renders.length, 0);
    assert.equal(h.state.uploads.length, 0);
    assert.equal(h.state.deliveries.length, 0);
  }
});

test('an older delayed person request cannot overwrite the newer QR preview', async () => {
  const certificateGate = deferred(); const h = harness({ certificateGate });
  const older = h.module.open(person(41)); await settle();
  await h.module.open(person(52, 'municipal'));
  certificateGate.resolve(); await older;
  assert.equal(h.container.querySelector('[data-field="fullName"]').textContent, 'Person52 Example');
  assert.equal(h.DOM.certificateCard.dataset.certTier, 'municipal');
  await h.download();
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/52/certificate/file');
});

test('a failed template leaves PDF export disabled instead of exporting stale content', async () => {
  const h = harness({ templateFailure: true }); await h.module.open(person()); await h.download();
  assert.equal(h.DOM.userCertificateDownload.disabled, true);
  assert.equal(h.container.querySelector('.certificate-qr'), null);
  assert.equal(h.state.renders.length, 0); assert.equal(h.state.uploads.length, 0);
});

test('a failed background does not upload a partial certificate and releases the export lock', async () => {
  const h = harness({ backgroundFailure: true }); await h.module.open(person()); await h.download();
  assert.equal(h.state.renders.length, 0); assert.equal(h.state.uploads.length, 0);
  assert.equal(h.DOM.userCertificateDownload.disabled, false);
  assert.equal(h.document.querySelectorAll('.certificate-vector-sandbox').length, 0);
  assert.ok(h.state.toasts.some(([, severity]) => severity === 'error'));
});

test('a delayed save response for A cannot replace B certificate fields or QR after switching', async () => {
  const mutationGate = deferred(); const h = harness({ withForm: true, mutationGate });
  const userA = person(41); const userB = person(52, 'municipal');
  const unchangedB = structuredClone(userB);
  await h.module.open(userA);
  await h.DOM.certificateEditBtn.dispatch('click');
  h.DOM.certificateFormValidityTerm.value = '7';
  const pendingSave = h.DOM.certificateFormSubmit.dispatch('click'); await settle();
  const request = h.state.requests.find((item) => item.request.method === 'PUT');
  assert.equal(request?.address, 'https://api.test/users/41/certificate');
  await h.module.open(userB);
  const qrB = h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  mutationGate.resolve(); await pendingSave;
  assert.deepEqual(userB, unchangedB, 'late A save must not write into B reference');
  assert.equal(h.container.querySelector('[data-field="fullName"]').textContent, 'Person52 Example');
  assert.equal(h.container.querySelector('[data-field="uniqueCode"]').textContent, userB.code);
  assert.equal(h.container.querySelector('[data-field="validityTerm"]').textContent, '5');
  assert.equal(h.DOM.certificateCard.dataset.certTier, 'municipal');
  assert.equal(h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d'), qrB);
  assert.equal(h.state.updates.length, 0, 'no stale callback may reclassify the visible B card');
  await h.download();
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/52/certificate/file');
});

test('a delayed deletion response for A cannot erase B certificate fields or QR after switching', async () => {
  const mutationGate = deferred(); const h = harness({ mutationGate });
  const userB = person(52, 'expert'); const unchangedB = structuredClone(userB);
  await h.module.open(person(41));
  const pendingDelete = h.DOM.userCertificateDelete.dispatch('click'); await settle();
  const request = h.state.requests.find((item) => item.request.method === 'DELETE');
  assert.equal(request?.address, 'https://api.test/users/41/certificate');
  await h.module.open(userB);
  const qrB = h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d');
  mutationGate.resolve(); await pendingDelete;
  assert.deepEqual(userB, unchangedB, 'late A deletion must not clear B reference');
  assert.equal(h.container.querySelector('[data-field="fullName"]').textContent, 'Person52 Example');
  assert.equal(h.container.querySelector('[data-field="uniqueCode"]').textContent, userB.code);
  assert.equal(h.DOM.certificateCard.dataset.certTier, 'expert');
  assert.equal(h.DOM.certificateCard.classList.contains('hidden'), false);
  assert.equal(h.DOM.userCertificateDownload.disabled, false);
  assert.equal(h.container.querySelector('.certificate-qr').querySelector('path').getAttribute('d'), qrB);
  assert.equal(h.state.updates.length, 0, 'no stale delete callback may erase the visible B card');
  await h.download();
  assert.equal(h.state.uploads[0].address, 'https://api.test/users/52/certificate/file');
});
