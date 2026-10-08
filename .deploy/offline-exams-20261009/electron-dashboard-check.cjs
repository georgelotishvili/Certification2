'use strict';
const electron = require('electron');
const { app, session, safeStorage } = electron;
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const runRoot = path.resolve(process.env.GIPC_DASHBOARD_QA_ROOT || '');
assert.equal(path.dirname(runRoot), __dirname);
const sourceRoot = process.env.GIPC_DASHBOARD_QA_SOURCE
  ? path.resolve(process.env.GIPC_DASHBOARD_QA_SOURCE) : path.resolve(__dirname, '../../desktop_app');
const { OfflineStore } = require(path.join(sourceRoot, 'src/main/offline-store'));
const profile = path.join(runRoot, 'userData'), desktop = path.join(runRoot, 'Desktop');
fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(desktop, { recursive: true });
app.setPath('userData', profile); app.setPath('desktop', desktop);
app.setPath('sessionData', path.join(runRoot, 'sessionData'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-sync');
process.env.NODE_ENV = 'development';
const cases = [], requests = [], windows = [], rendererErrors = [];
let visible = false, media = false, responseMode = 'offline', mainWindow;
class HiddenWindow extends electron.BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    windows.push(this); this.on('show', () => { visible = true; this.hide(); });
    this.webContents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message); });
  }
  maximize() {}
  setFullScreen() {}
}
const autoUpdater = Object.assign(new EventEmitter(), { checkForUpdates() {}, quitAndInstall() { throw new Error('QA update installation blocked'); } });
const bound = { attemptId: '22222222-3333-4444-8555-666666666666', userId: '990001' };
const user = { id: 990001, first_name: 'სატესტო', last_name: 'კანდიდატი', code: 'QA-ONLY' };
const seedSubmission = { endpoint: '/exam/990081/offline-final', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer QA_SYNTHETIC_CAPABILITY' },
  body: { submission_id: bound.attemptId, stage_grant_id: 990041, answers: [{ question_id: 31, option_id: 1 }], finished_at: '2026-10-08T20:00:00Z' } };
const js = expression => mainWindow.webContents.executeJavaScript(expression, true);
async function until(expression) {
  for (let index = 0; index < 160; index++) {
    if (await js(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for UI condition: ' + expression);
}
async function screenshot(name) {
  await js('document.fonts.ready');
  mainWindow.webContents.invalidate();
  await new Promise(resolve => setTimeout(resolve, 180));
  fs.writeFileSync(path.join(runRoot, name), (await mainWindow.webContents.capturePage()).toPNG());
}
async function clickByText(text) {
  const point = await js(`(() => {
    const button=Array.from(document.querySelectorAll('#offline-recovery button')).find(item=>item.textContent.includes(${JSON.stringify(text)}));
    button.scrollIntoView({block:'center'});
    const rect=button.getBoundingClientRect(), x=rect.x+rect.width/2, y=rect.y+rect.height/2;
    const hit=document.elementFromPoint(x,y);
    return {x,y,visible:rect.width>0&&rect.height>0&&y>=0&&y<innerHeight,unobscured:hit===button||button.contains(hit)};
  })()`);
  assert.equal(point.visible, true, 'Recovery action must be visible');
  assert.equal(point.unobscured, true, 'Recovery action must not be covered by exam cards');
  if (!mainWindow.webContents.debugger.isAttached()) mainWindow.webContents.debugger.attach('1.3');
  for (const type of ['mousePressed', 'mouseReleased']) {
    await mainWindow.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }
}

app.whenReady().then(async () => {
  const sourceRequire = Module.createRequire(path.join(sourceRoot, 'package.json'));
  const updaterDependency = sourceRequire.resolve('electron-updater');
  assert.ok(updaterDependency.startsWith(sourceRoot + path.sep), 'Updater dependency must resolve inside the tested source/archive');
  const updaterExports = sourceRequire('electron-updater');
  assert.ok(Object.getOwnPropertyDescriptor(updaterExports, 'autoUpdater'));
  const sourceAppVersion = sourceRequire('./package.json').version;
  // These custom protocol handlers satisfy requests locally. No endpoint can be contacted.
  for (const scheme of ['http', 'https']) {
    await session.defaultSession.protocol.handle(scheme, async request => {
      const url = new URL(request.url);
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (url.pathname === '/exam/990081/offline-final') {
        const body = JSON.parse(await request.text());
        requests.push({ path: url.pathname, body });
        assert.deepEqual(body, seedSubmission.body);
        if (responseMode === 'offline') return new Response('{}', { status: 503, headers });
        return new Response(JSON.stringify({ submission_id: bound.attemptId, session_id: 990081, stage_grant_id: 990041,
          total_questions: 1, answered: 1, correct: 1, score_percent: 100, block_stats: [], chapter_stats: [], subchapter_stats: [] }), { headers });
      }
      return new Response('{}', { status: 503, headers });
    });
  }
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const store = new OfflineStore({ root: path.join(profile, 'offline-attempts-v1'), recordingsRoot: path.join(desktop, 'GIPC_Recordings'), protector: safeStorage });
  store.create({ ...bound, stage: 'theory', sessionId: 990081, stageGrantId: 990041,
    bundle: { user, baseURL: 'https://gipc.org.ge', sessionId: 990081, stageGrantId: 990041, questions: { 3: [{ id: 31 }] } },
    checkpoint: { phase: 'prepared', answerState: { answers: {}, lockedBlocks: [] } } });
  store.saveCheckpoint({ ...bound, checkpoint: { phase: 'active', deadlineAt: Date.now() - 1000, serverOffsetMs: 0,
    serverEndsAt: '2026-10-08T20:00:00Z', startedAt: '2026-10-08T19:15:00Z', offlineCapability: 'QA_SYNTHETIC_CAPABILITY',
    answerState: { answers: { 31: 1 }, lockedBlocks: [3] } } });
  const unfinishedRecording = store.startRecording(bound);
  await store.appendRecording({ ...bound, recordingId: unfinishedRecording.recordingId, sequence: 0,
    buffer: Buffer.from('QA_SYNTHETIC_SAVED_VIDEO_SEGMENT') });
  store.freeze({ ...bound, submission: seedSubmission });
  store.create({ attemptId: '33333333-4444-4555-8666-777777777777', userId: '990001', stage: 'project_stage_1', stageGrantId: 990042,
    bundle: { user, baseURL: 'https://gipc.org.ge', project: { code: 'QA-PROJECT' } },
    checkpoint: { phase: 'prepared', answerState: { selectedAnswerIds: [] } } });
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron' && parent?.filename === path.join(sourceRoot, 'src/main/main.js')) return { ...electron,
      BrowserWindow: HiddenWindow, desktopCapturer: { getSources: async () => { media = true; throw new Error('QA capture blocked'); } } };
    if (request === 'electron-updater' && parent?.filename === path.join(sourceRoot, 'src/main/main.js')) return { autoUpdater };
    return originalLoad.call(this, request, parent, isMain);
  };
  require(path.join(sourceRoot, 'src/main/main.js'));
  await Promise.resolve(); mainWindow = windows[0]; assert.ok(mainWindow);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await new Promise((resolve, reject) => {
    mainWindow.webContents.once('did-finish-load', resolve);
    mainWindow.webContents.once('did-fail-load', (_event, code, description) => reject(new Error(`Load failed ${code}: ${description}`)));
  });
  await until("document.querySelectorAll('#offline-recovery .offline-recovery-row').length === 2 && !document.querySelector('#offline-recovery button').disabled");
  await until("document.querySelector('#offline-recovery').textContent.includes('პასუხები შენახულია')");
  await until(`(async()=> (await window.electronAPI.offline.load(${JSON.stringify(bound)})).retryCount >= 1)()`);
  assert.ok(requests.length >= 1);
  assert.equal(store.load(bound).status, 'pending');
  assert.equal(await js('window.currentUser == null'), true);
  cases.push('Actual index.html, shared coordinator and offline-home dashboard render pending/prepared durable attempts while signed out');
  cases.push('Automatic retry receives a local synthetic 503 and keeps the encrypted outbox pending');
  assert.equal(await js("Boolean(document.querySelector('.offline-recording-warning'))"), true);
  await screenshot('pending-dashboard.png');
  assert.equal(await js(`(() => {
    const recovery=document.querySelector('#offline-recovery').getBoundingClientRect();
    const section=document.querySelector('.exam-section');
    if(getComputedStyle(section).display==='none')return true;
    const cards=section.getBoundingClientRect();
    return recovery.bottom<=cards.top||cards.bottom<=recovery.top||recovery.right<=cards.left||cards.right<=recovery.left;
  })()`), true, 'Recovery dashboard must not geometrically overlap the examination cards');
  cases.push('Recovery dashboard and exam cards do not overlap; buttons are visible and receive real Chromium pointer input');
  mainWindow.setSize(800, 600);
  await js('window.scrollTo(0,0)');
  await screenshot('pending-dashboard-800x600.png');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true, 'Narrow dashboard must not horizontally overflow');
  assert.equal(await js("(()=>{const rect=document.querySelector('#offline-recovery').getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth})()"), true);
  cases.push('At 800×600, recovery content fits the width, scrolls vertically and remains pointer-accessible');
  const originalURL = mainWindow.webContents.getURL();
  await clickByText('მომზადებული');
  assert.equal(mainWindow.webContents.getURL(), originalURL);
  assert.equal(await js("document.querySelector('#offline-recovery').textContent.includes('იმავე კანდიდატით')"), true);
  cases.push('Prepared resume refuses navigation while signed out and requests the same candidate identity');
  responseMode = 'success';
  await clickByText('გაგზავნის');
  await until("document.querySelector('#offline-recovery').textContent.includes('სერვერზე შენახულია')");
  assert.equal(store.load(bound).status, 'acknowledged');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body, requests[1].body);
  assert.equal(await js("Array.from(document.querySelectorAll('#offline-recovery button')).some(button=>button.textContent.includes('გაგზავნის'))"), false);
  cases.push('Visible retry action resends identical frozen data; bound synthetic server receipt updates both real durable state and dashboard success text');
  assert.equal(await js("Boolean(document.querySelector('.offline-recording-warning'))"), true);
  cases.push('Unfinished recording warning remains visible after answer ACK; original saved chunk is retained');
  mainWindow.setSize(1200, 800); await js('window.scrollTo(0,0)');
  await screenshot('acknowledged-dashboard.png');
  const reloaded = new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
  mainWindow.reload(); await reloaded;
  await until("Boolean(document.querySelector('.offline-recording-warning')) && document.querySelectorAll('#offline-recovery .offline-recovery-row').length === 1");
  assert.equal(store.list().find(row => row.attemptId === bound.attemptId).recordingNeedsReview, true);
  assert.equal(requests.length, 2);
  await screenshot('recording-review-after-reload.png');
  cases.push('Reloaded dashboard preserves recording-review warning from encrypted metadata without resubmitting acknowledged answers');
  assert.equal(visible, false); assert.equal(media, false);
  const files = ['src/main/main.js', 'src/main/offline-store.js', 'src/preload/preload.js', 'src/renderer/offline-exam.js', 'src/renderer/offline-home.js', 'src/renderer/renderer.js', 'src/renderer/styles/offline.css'];
  const report = { passed: true, cases, electron: process.versions.electron, actualChromiumRenderer: true, actualMainAndPreload: true,
    externalNetwork: false, httpHandledLocally: true, visibleWindows: false, realAccounts: false, realMediaCapture: false,
    rendererErrorCount: rendererErrors.length, finalRequests: requests.length,
    screenshots: ['pending-dashboard.png', 'pending-dashboard-800x600.png', 'acknowledged-dashboard.png', 'recording-review-after-reload.png'],
    sourceSha256: Object.fromEntries(files.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot, file))).digest('hex')])),
    generatedAt: new Date().toISOString(), runRoot, sourceRoot, sourceAppVersion, updaterDependency };
  fs.writeFileSync(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, cases: cases.length, report: path.join(runRoot, 'report.json') }));
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error.stack || error);
  fs.writeFileSync(path.join(runRoot, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2));
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(1);
});
setTimeout(() => { console.error('Dashboard QA safety timeout'); app.exit(2); }, 40000).unref();
