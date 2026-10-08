'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const runRoot = fs.mkdtempSync(path.join(__dirname, 'dashboard-smoke-'));
const env = { ...process.env, NODE_ENV: 'development', GIPC_DASHBOARD_QA_ROOT: runRoot };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.resolve(__dirname, '../../desktop_app/node_modules/electron/dist/electron.exe'),
  [path.join(__dirname, 'electron-dashboard-check.cjs')], { env, windowsHide: true, stdio: 'pipe' });
let log = '';
child.stdout.on('data', chunk => { log += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { log += chunk; process.stderr.write(chunk); });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
child.on('close', () => { clearTimeout(timer); fs.writeFileSync(path.join(runRoot, 'dashboard.log'), log); });
