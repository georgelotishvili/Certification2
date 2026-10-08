'use strict';

const electron = require('electron');
const { app, session, safeStorage } = electron;
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const runRoot = path.resolve(process.env.GIPC_OFFLINE_QA_ROOT || '');
assert.equal(path.dirname(runRoot), __dirname, 'QA output must remain in the explicit smoke directory');
const phase = process.argv[2];
assert.ok(['write', 'restart'].includes(phase));
const sourceRoot = process.env.GIPC_OFFLINE_QA_SOURCE
  ? path.resolve(process.env.GIPC_OFFLINE_QA_SOURCE) : path.resolve(__dirname, '../../desktop_app');
const indexPath = path.join(sourceRoot, 'src/renderer/index.html');
const preloadPath = path.join(sourceRoot, 'src/preload/preload.js');
const profile = path.join(runRoot, 'userData');
const desktop = path.join(runRoot, 'Desktop');
fs.mkdirSync(profile, { recursive: true });
fs.mkdirSync(desktop, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(runRoot, 'sessionData'));
app.setPath('desktop', desktop);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
process.env.NODE_ENV = 'development';

const cases = [], network = [], windows = [];
let visibleWindow = false, mediaRequest = false, updaterRequest = false;
class HiddenWindow extends electron.BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    windows.push(this);
    this.on('show', () => { visibleWindow = true; this.hide(); });
  }
  // Native maximize/fullscreen can implicitly show a previously hidden window.
  maximize() {}
  setFullScreen() {}
}
const autoUpdater = Object.assign(new EventEmitter(), {
  checkForUpdates() { updaterRequest = true; throw new Error('QA updater access blocked'); },
  quitAndInstall() { throw new Error('QA installation blocked'); }
});

const bound = { attemptId: '11111111-2222-4333-8444-555555555555', userId: '990001' };
const fakeCapability = 'QA_SYNTHETIC_CAPABILITY_NOT_A_REAL_CREDENTIAL';
const fakeSecret = 'QA_SYNTHETIC_SESSION_SECRET_NOT_A_REAL_CREDENTIAL';
const submission = { endpoint: '/exam/990081/offline-final', headers: { Authorization: `Bearer ${fakeCapability}` },
  body: { submission_id: bound.attemptId, stage_grant_id: 990041, answers: [{ question_id: 31, option_id: 1 }] } };
let mainWindow;
const js = expression => mainWindow.webContents.executeJavaScript(expression, true);
const call = (method, input) => js(`window.electronAPI.offline[${JSON.stringify(method)}](${input === undefined ? '' : JSON.stringify(input)})`);
const readAll = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const location = path.join(directory, entry.name);
  return entry.isDirectory() ? readAll(location) : [location];
});

async function waitForPage(window) {
  for (let index = 0; index < 100; index++) {
    if (!window.webContents.isLoading() && await window.webContents.executeJavaScript('Boolean(window.electronAPI?.offline)')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for actual preload');
}

app.whenReady().then(async () => {
  const sourceRequire = Module.createRequire(path.join(sourceRoot, 'package.json'));
  const updaterDependency = sourceRequire.resolve('electron-updater');
  assert.ok(updaterDependency.startsWith(sourceRoot + path.sep), 'Updater dependency must resolve inside the tested source/archive');
  // Load the shipped dependency graph without accessing its lazy autoUpdater getter
  // or calling update methods. Main receives the no-network stub below.
  const updaterExports = sourceRequire('electron-updater');
  assert.ok(Object.getOwnPropertyDescriptor(updaterExports, 'autoUpdater'));
  const sourceAppVersion = sourceRequire('./package.json').version;
  // Every HTTP(S)/WebSocket request is cancelled before connection. Page scripts are
  // disabled to isolate actual main/preload IPC from renderer start/recovery effects.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    network.push({ method: details.method, protocol: new URL(details.url).protocol });
    callback({ cancel: true });
  });
  await session.defaultSession.protocol.handle('file', request => {
    const url = new URL(request.url);
    const requested = require('node:url').fileURLToPath(url);
    if (path.resolve(requested).toLowerCase() !== indexPath.toLowerCase()) return new Response('', { status: 403 });
    return new Response(fs.readFileSync(indexPath), { headers: { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'none'; frame-src 'none'" } });
  });
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' && parent?.filename === path.join(sourceRoot, 'src/main/main.js')) {
      return { ...electron, BrowserWindow: HiddenWindow,
        desktopCapturer: { getSources: async () => { mediaRequest = true; throw new Error('QA real capture blocked'); } } };
    }
    if (request === 'electron-updater' && parent?.filename === path.join(sourceRoot, 'src/main/main.js')) return { autoUpdater };
    return originalLoad.call(this, request, parent, isMain);
  };
  require(path.join(sourceRoot, 'src/main/main.js'));
  await Promise.resolve();
  mainWindow = windows[0];
  assert.ok(mainWindow, 'Actual main.js must create the window');
  await waitForPage(mainWindow);
  assert.equal(mainWindow.isVisible(), false);
  assert.equal(require('node:url').fileURLToPath(mainWindow.webContents.getURL()), indexPath);
  assert.equal(await js('typeof window.electronAPI.offline.freeze'), 'function');
  assert.equal(process.platform, 'win32');
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  cases.push('Actual main.js and preload.js execute in a hidden window at the exact trusted local index.html URL');
  cases.push('Real Windows safeStorage encryption is available (DPAPI; no injected protector)');

  if (phase === 'write') {
    assert.equal((await call('preflight')).available, true);
    const durationCheck = await call('preflight', { durationMinutes: 45 });
    assert.equal(durationCheck.available, true);
    assert.ok(durationCheck.requiredFreeBytes > 2 * 1024 * 1024 * 1024);
    cases.push('IPC preflight verifies DPAPI encryption, writable storage and disk space');
    cases.push('Real preload forwards duration-aware 45-minute recording and asset disk readiness');
    const created = await call('create', { ...bound, stage: 'theory', sessionId: 990081, stageGrantId: 990041,
      bundle: { sessionToken: fakeSecret, questions: { 3: [{ id: 31 }] } },
      checkpoint: { phase: 'prepared', answerState: { answers: {}, lockedBlocks: [] } } });
    assert.equal(created.status, 'prepared');
    await js(`window.electronAPI.offline.cacheAsset({ ...${JSON.stringify(bound)}, assetId: 'qa-pdf', buffer: new TextEncoder().encode('%PDF-1.7\\nQA offline document\\n%%EOF').buffer })`);
    assert.equal(await js(`(async () => new TextDecoder().decode(await window.electronAPI.offline.readAsset({...${JSON.stringify(bound)},assetId:'qa-pdf'})))()`), '%PDF-1.7\nQA offline document\n%%EOF');
    cases.push('PDF binary caches and reads through real IPC without a network request');
    const now = Date.now();
    await call('saveCheckpoint', { ...bound, checkpoint: { phase: 'active', deadlineAt: now + 60000, serverOffsetMs: 0,
      serverEndsAt: new Date(now + 60000).toISOString(), startedAt: new Date(now).toISOString(), offlineCapability: fakeCapability,
      answerState: { answers: { 31: 1 }, lockedBlocks: [3] } } });
    await call('activate', bound);
    const recording = await call('startRecording', bound);
    await js(`window.electronAPI.offline.appendRecording({...${JSON.stringify(bound)},recordingId:${JSON.stringify(recording.recordingId)},sequence:0,buffer:new TextEncoder().encode('QA_RECORDING_HEADER').buffer})`);
    await js(`window.electronAPI.offline.appendRecording({...${JSON.stringify(bound)},recordingId:${JSON.stringify(recording.recordingId)},sequence:1,buffer:new TextEncoder().encode('_QA_RECORDING_SEGMENT').buffer})`);
    const finished = await call('finishRecording', { ...bound, recordingId: recording.recordingId });
    assert.ok(finished.path.startsWith(path.join(desktop, 'GIPC_Recordings') + path.sep));
    assert.equal(fs.readFileSync(finished.path, 'utf8'), 'QA_RECORDING_HEADER_QA_RECORDING_SEGMENT');
    cases.push('Synthetic recording chunks fsync and assemble under the isolated GIPC_Recordings directory');
    const frozen = await call('freeze', { ...bound, submission });
    assert.equal(frozen.status, 'pending');
    for (const file of readAll(path.join(profile, 'offline-attempts-v1'))) {
      const data = fs.readFileSync(file);
      for (const plain of [fakeCapability, fakeSecret, '%PDF-1.7', 'QA offline document']) assert.equal(data.includes(plain), false);
    }
    cases.push('Checkpoint, immutable final submission and PDF are encrypted on disk; synthetic secrets absent in all snapshot/asset files');
  } else {
    const listed = await call('list', {});
    assert.equal(listed.length, 1); assert.equal(listed[0].status, 'pending');
    const recovered = await call('load', bound);
    assert.equal(recovered.bundle.sessionToken, fakeSecret);
    assert.deepEqual(recovered.frozenSubmission, submission);
    assert.equal(recovered.checkpoint.answerState.answers[31], 1);
    cases.push('A second Electron process decrypts the original DPAPI snapshots and restores exact pending attempt/session/grant/answers');
    assert.equal(await js(`(async()=>new TextDecoder().decode(await window.electronAPI.offline.readAsset({...${JSON.stringify(bound)},assetId:'qa-pdf'})))()`), '%PDF-1.7\nQA offline document\n%%EOF');
    cases.push('Encrypted PDF remains readable over IPC after a full Electron process restart');
    const mutation = await js(`window.electronAPI.offline.saveCheckpoint({...${JSON.stringify(bound)},checkpoint:{phase:'active'}}).then(()=>false,error=>error.message.includes('ATTEMPT_FROZEN'))`);
    assert.equal(mutation, true);
    const identityError = await js(`window.electronAPI.offline.load({attemptId:${JSON.stringify(bound.attemptId)},userId:'another-user'}).then(()=>false,error=>error.message.includes('ATTEMPT_OWNER_MISMATCH'))`);
    assert.equal(identityError, true);
    cases.push('Actual IPC rejects frozen-answer mutation and cross-user attempt access');
    const otherWindow = new HiddenWindow({ webPreferences: { nodeIntegration: false, contextIsolation: true, preload: preloadPath } });
    await otherWindow.loadFile(indexPath); await waitForPage(otherWindow);
    assert.equal(await otherWindow.webContents.executeJavaScript("window.electronAPI.offline.list({}).then(()=>false,error=>error.message.includes('UNTRUSTED_IPC_SENDER'))"), true);
    otherWindow.destroy();
    cases.push('A second local window with the real preload is denied privileged IPC by sender identity');
    const invalidAck = await js(`window.electronAPI.offline.ack({...${JSON.stringify(bound)},receipt:{result:{submission_id:'unrelated'}}}).then(()=>false,error=>error.message.includes('INVALID_RECEIPT'))`);
    assert.equal(invalidAck, true);
    assert.equal((await call('load', bound)).status, 'pending');
    cases.push('Actual IPC rejects an unrelated or incomplete ACK and retains the durable outbox');
    const acknowledged = await call('ack', { ...bound, receipt: { result: { submission_id: bound.attemptId,
      session_id: 990081, stage_grant_id: 990041, total_questions: 1, answered: 1, correct: 1, score_percent: 100,
      block_stats: [], chapter_stats: [], subchapter_stats: [] } } });
    assert.equal(acknowledged.status, 'acknowledged');
    assert.equal((await call('load', bound)).status, 'acknowledged');
    cases.push('Bound server-result fixture acknowledges the same frozen submission durably over IPC');
  }
  assert.equal(visibleWindow, false); assert.equal(mediaRequest, false); assert.equal(updaterRequest, false);
  assert.equal(network.length, 0);
  const report = { passed: true, phase, cases, electron: process.versions.electron, safeStorage: 'Windows DPAPI available',
    visibleWindows: false, networkAttempts: network.length, realMediaCapture: false, realAccounts: false,
    actualMain: path.join(sourceRoot, 'src/main/main.js'), actualPreload: preloadPath, trustedPage: indexPath,
    sourceSha256: Object.fromEntries(['src/main/main.js', 'src/main/offline-store.js', 'src/preload/preload.js'].map(file =>
      [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, file))).digest('hex')])),
    userData: profile, desktop, generatedAt: new Date().toISOString() };
  report.sourceRoot = sourceRoot; report.sourceAppVersion = sourceAppVersion; report.updaterDependency = updaterDependency;
  fs.writeFileSync(path.join(runRoot, phase + '-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase, passed: true, cases: cases.length }));
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  fs.writeFileSync(path.join(runRoot, phase + '-failure.json'), JSON.stringify({ phase, error: error.message, stack: error.stack }, null, 2));
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(1);
});
setTimeout(() => { console.error('QA safety timeout'); app.exit(2); }, 40000).unref();
