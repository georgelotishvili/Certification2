const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const helperSource = fs.readFileSync(path.join(__dirname, '../scripts/certificate-qr.js'), 'utf8');
const vendorSource = fs.readFileSync(path.join(__dirname, '../scripts/vendor/qrcode-generator.js'), 'utf8');
const SVG_NS = 'http://www.w3.org/2000/svg';

class Element {
  constructor(namespace, name) { this.namespaceURI = namespace; this.tagName = name; this.attributes = {}; this.children = []; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(node) { this.children.push(node); return node; }
}

const documentStub = { createElementNS: (namespace, name) => new Element(namespace, name) };

function harness({ vendor = true, document = documentStub, encoder } = {}) {
  const state = { requests: 0 };
  const context = { document, location: { origin: 'http://127.0.0.1:3000' },
    fetch() { state.requests += 1; throw new Error('QR generation must be local'); } };
  context.window = context;
  vm.createContext(context);
  if (vendor) vm.runInContext(vendorSource, context);
  if (encoder) context.qrcode = encoder;
  vm.runInContext(helperSource, context);
  return { api: context.CertificateQR, state, context };
}

test('QR profile URL always targets the production public person page', () => {
  const { api } = harness();
  assert.equal(api.buildProfileUrl('1000000042'), 'https://gipc.org.ge/pages/my.html?code=1000000042');
  assert.equal(api.buildProfileUrl('0000000042'), 'https://gipc.org.ge/pages/my.html?code=0000000042');
  assert.equal(api.buildProfileUrl('9999999999'), 'https://gipc.org.ge/pages/my.html?code=9999999999');
});

test('IDs, coerced numbers, personal IDs and malformed permanent codes fail closed', () => {
  const { api } = harness();
  const invalid = [0, 42, 1000000042, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    '', '0', '01', ' 1', '1 ', '+1', '-1', '1.0', '1e2', '1/2', '1&admin=true',
    '100000042', '01000000042', '1000000042 ', ' 1000000042', '1000000042\n',
    '100000004A', '１０００００００４２', '<script>', 'https://example.test',
    '9007199254740992', null, undefined, true, false, {}, [], [1], 1n, Symbol('1')];
  for (const code of invalid) {
    assert.throws(() => api.buildProfileUrl(code), /10-digit permanent certification code string/);
    assert.throws(() => api.createSvg(code), /10-digit permanent certification code string/);
  }
});

test('profile data objects cannot be accidentally encoded or coerced to a code', () => {
  const { api } = harness();
  const person = { id: 42, code: '1000000042', personal_id: 'private', email: 'private@example.test',
    toString() { throw new Error('No object coercion'); } };
  assert.throws(() => api.buildProfileUrl(person), /10-digit permanent certification code string/);
});

test('encoder uses auto version, Q correction and only the canonical public URL', () => {
  const calls = [];
  const { api } = harness({ vendor: false, encoder(version, correction) {
    calls.push([version, correction]);
    return { addData(...args) { calls.push(args); }, make() { calls.push(['make']); },
      getModuleCount() { return 1; }, isDark() { return true; } };
  } });
  const matrix = api.buildMatrix('0000000042');
  assert.deepEqual(calls, [[0, 'Q'], ['https://gipc.org.ge/pages/my.html?code=0000000042', 'Byte'], ['make']]);
  assert.equal(matrix.quietZone, 4);
  assert.equal(matrix.errorCorrectionLevel, 'Q');
});

test('actual local encoder produces a square boolean matrix with three finder patterns', () => {
  const { api } = harness();
  for (const code of ['0000000001', '1000000042', '9999999999']) {
    const matrix = api.buildMatrix(code);
    const size = matrix.moduleCount;
    assert.ok(size >= 21 && size <= 177);
    assert.equal((size - 17) % 4, 0);
    assert.equal(matrix.modules.length, size);
    for (const row of matrix.modules) {
      assert.equal(row.length, size);
      for (const value of row) assert.equal(typeof value, 'boolean');
    }
    for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) {
          const expected = x === 0 || x === 6 || y === 0 || y === 6 ||
            (x >= 2 && x <= 4 && y >= 2 && y <= 4);
          assert.equal(matrix.modules[top + y][left + x], expected);
        }
      }
    }
  }
});

test('identical permanent codes generate deterministic QR while different codes have different matrices', () => {
  const { api } = harness();
  const first = JSON.stringify(api.buildMatrix('1000000042').modules);
  assert.equal(first, JSON.stringify(api.buildMatrix('1000000042').modules));
  assert.notEqual(first, JSON.stringify(api.buildMatrix('1000000043').modules));
});

test('SVG is a self-contained black vector QR with white four-module quiet zone', () => {
  const { api } = harness();
  const matrix = api.buildMatrix('1000000042');
  const svg = api.createSvg('1000000042');
  const side = matrix.moduleCount + 8;
  assert.equal(svg.namespaceURI, SVG_NS);
  assert.equal(svg.tagName, 'svg');
  assert.equal(svg.attributes.viewBox, `0 0 ${side} ${side}`);
  assert.equal(svg.attributes['shape-rendering'], 'crispEdges');
  assert.equal(svg.attributes.preserveAspectRatio, 'xMidYMid meet');
  assert.equal(svg.attributes.width, '100%');
  assert.equal(svg.attributes.height, '100%');
  assert.equal(svg.attributes.xmlns, SVG_NS);
  assert.deepEqual(svg.children.map((node) => node.tagName), ['title', 'rect', 'path']);
  const background = svg.children[1];
  assert.deepEqual(background.attributes, { width: String(side), height: String(side), fill: '#fff' });
  assert.equal(svg.children[2].attributes.fill, '#000');

  // Reconstruct the actual drawn cells; every module must match the encoder and
  // no black pixel may intrude into any of the four white quiet-zone edges.
  const drawn = Array.from({ length: side }, () => Array(side).fill(false));
  const commands = svg.children[2].attributes.d;
  const runs = [...commands.matchAll(/M(\d+),(\d+)h(\d+)v1h-(\d+)z/g)];
  assert.equal(runs.map((match) => match[0]).join(''), commands);
  assert.ok(runs.length > 0);
  for (const [, xText, yText, lengthText, reverseText] of runs) {
    assert.equal(lengthText, reverseText);
    const x = Number(xText); const y = Number(yText); const length = Number(lengthText);
    assert.ok(x >= 4 && y >= 4 && x + length <= side - 4 && y < side - 4);
    for (let offset = 0; offset < length; offset += 1) drawn[y][x + offset] = true;
  }
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const within = x >= 4 && y >= 4 && x < side - 4 && y < side - 4;
      assert.equal(drawn[y][x], within ? matrix.modules[y - 4][x - 4] : false);
    }
  }
});

test('SVG has an accessible label but no scripts, external images, links or profile data', () => {
  const { api } = harness();
  const svg = api.createSvg('1000000042');
  assert.equal(svg.attributes.role, 'img');
  assert.equal(svg.attributes.focusable, 'false');
  assert.equal(svg.attributes['aria-label'], 'სერტიფიკატის მფლობელის საჯარო გვერდი');
  assert.equal(svg.children[0].textContent, svg.attributes['aria-label']);
  const serialized = JSON.stringify(svg);
  assert.doesNotMatch(serialized, /href|<script|personal_id|email|token/);
});

test('generation works completely offline and does not use the current browser host', () => {
  const { api, state } = harness();
  assert.ok(api.createSvg('1000000042'));
  assert.equal(state.requests, 0);
  assert.doesNotMatch(api.buildProfileUrl('1000000042'), /localhost|127\.0\.0\.1/);
  assert.doesNotMatch(helperSource, /\bfetch\s*\(|XMLHttpRequest|\.innerHTML\s*=/);
});

test('explicit owner document can be used for a detached export document', () => {
  const { api } = harness({ document: undefined });
  const markerDoc = { createElementNS(namespace, name) {
    const element = new Element(namespace, name); element.createdByExportDocument = true; return element;
  } };
  const svg = api.createSvg('1000000042', { document: markerDoc });
  assert.equal(svg.createdByExportDocument, true);
  for (const child of svg.children) assert.equal(child.createdByExportDocument, true);
});

test('missing encoder or DOM produces an explicit error rather than a blank code', () => {
  assert.throws(() => harness({ vendor: false }).api.createSvg('1000000042'), /encoder is unavailable/);
  const { api, context } = harness();
  delete context.document;
  assert.throws(() => api.createSvg('1000000042'), /SVG-capable document/);
});

test('vendored QR encoder retains its MIT license and exact upstream provenance', () => {
  const license = fs.readFileSync(path.join(__dirname, '../scripts/vendor/qrcode-generator.LICENSE.txt'), 'utf8');
  const provenance = fs.readFileSync(path.join(__dirname, '../scripts/vendor/qrcode-generator.SOURCE.txt'), 'utf8');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2009 Kazuhiko Arase/);
  assert.match(license, /Permission is hereby granted/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(provenance, /83b7e8fe3fddd3b0368dbafd6ce56995bd25e3c8/);
  assert.match(provenance, /https:\/\/github\.com\/kazuhikoarase\/qrcode-generator/);
  assert.match(vendorSource, /Copyright \(c\) 2009 Kazuhiko Arase/);
});
