'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../desktop_app');
const asar = require(path.join(root, 'node_modules/@electron/asar'));
const archive = path.join(root, 'dist/win-unpacked/resources/app.asar');
const executable = path.join(root, 'dist/GIPC_exam_1.1.12.exe');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
const matched = {};
for (const file of files(path.join(root, 'src'))) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const original = hash(fs.readFileSync(file));
  assert.equal(hash(asar.extractFile(archive, path.relative(root, file))), original, `Packaged source mismatch: ${relative}`);
  matched[relative] = original;
}
const manifest = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(manifest.version, '1.1.12');
assert.equal(manifest.main, 'src/main/main.js');
const report = { passed: true, version: manifest.version, createdAt: new Date().toISOString(),
  exe: { path: executable, size: fs.statSync(executable).size, sha256: hash(fs.readFileSync(executable)) },
  archive: { path: archive, sha256: hash(fs.readFileSync(archive)) },
  sourceFileCount: Object.keys(matched).length, matchedSources: matched,
  deployed: false, productionChanged: false };
fs.writeFileSync(path.join(__dirname, 'package-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, version: report.version, sourceFileCount: report.sourceFileCount, exe: report.exe }));
