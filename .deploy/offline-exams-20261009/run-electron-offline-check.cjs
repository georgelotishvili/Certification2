'use strict';

// Reproducible local-only smoke. Outputs and test identities are isolated per run.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const runRoot = fs.mkdtempSync(path.join(__dirname, 'electron-smoke-'));
const binary = path.resolve(__dirname, '../../desktop_app/node_modules/electron/dist/electron.exe');
const env = { ...process.env, NODE_ENV: 'development', GIPC_OFFLINE_QA_ROOT: runRoot };
delete env.ELECTRON_RUN_AS_NODE;

function run(phase) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [path.join(__dirname, 'electron-offline-check.cjs'), phase],
      { env, windowsHide: true, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Electron phase ${phase} exited ${code}`)));
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron phase ${phase} timed out`)); }, 45000);
    child.on('close', () => { clearTimeout(timer); fs.writeFileSync(path.join(runRoot, phase + '.log'), output); });
  });
}

(async () => {
  await run('write');
  await run('restart');
  const phases = ['write', 'restart'].map(phase => JSON.parse(fs.readFileSync(path.join(runRoot, phase + '-report.json'), 'utf8')));
  const report = { passed: phases.every(phase => phase.passed), cases: phases.flatMap(phase => phase.cases),
    electron: phases[0].electron, windowsSafeStorage: phases[0].safeStorage, processRestart: true,
    externalNetwork: false, realAccounts: false, realMediaCapture: false, visibleWindows: false,
    generatedAt: new Date().toISOString(), runRoot, phases };
  fs.writeFileSync(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, caseCount: report.cases.length, report: path.join(runRoot, 'report.json') }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
