// Isolated local visual QA: synthetic API responses, no production access.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../../frontend');
const source = path.resolve(root, '../ახალი ლოგო.svg');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (status, data) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };
    if (req.method !== 'GET') return json(405, {});
    if (url.pathname === '/certified-persons/registry') return json(200, []);
    if (url.pathname === '/documents') return json(200, {items: []});
    if (url.pathname === '/logo-check.html') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      return res.end('<!doctype html><html><head><title>Local logo QA</title></head><body style="margin:30px"><img id="original" src="/original.svg" style="width:600px"><hr><img id="clean" src="/assets/svg/logo.svg" style="width:600px"></body></html>');
    }
    const file = url.pathname === '/original.svg' ? source : path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== source && !file.startsWith(root + path.sep)) return json(403, {});
    const mime = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.woff2': 'font/woff2'};
    fs.readFile(file, (err, data) => { res.writeHead(err ? 404 : 200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream'}); res.end(err ? 'Not found' : data); });
  });
  await new Promise(resolve => server.listen(3036, '127.0.0.1', resolve));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9231', '--user-data-dir=' + path.join(__dirname, 'chrome-test-profile'), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', 'about:blank'], {windowsHide: true, stdio: 'ignore'});
  let ws;
  try {
    let tabs;
    for (let i = 0; i < 60; i++) { try { tabs = await (await fetch('http://127.0.0.1:9231/json')).json(); break; } catch { await wait(200); } }
    assert(tabs);
    ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0; const pending = new Map(); const errors = [];
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, {resolve, reject}); ws.send(JSON.stringify({id, method, params})); });
    const run = async expression => { const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    await send('Network.setBlockedURLs', {urls: ['https://*', 'http://gipc.org.ge/*', 'http://www.gipc.org.ge/*', 'http://148.251.167.229/*']});
    await send('Emulation.setDeviceMetricsOverride', {width: 900, height: 650, deviceScaleFactor: 1, mobile: false});
    await send('Page.navigate', {url: 'http://127.0.0.1:3036/logo-check.html'});
    for (let i = 0; i < 80; i++) { if (await run("document.images.length===2 && [...document.images].every(i=>i.complete&&i.naturalWidth>0)")) break; await wait(100); }
    const vector = await run(`(async()=>{
      const [a,b]=await Promise.all(['/original.svg','/assets/svg/logo.svg'].map(u=>fetch(u).then(r=>r.text())));
      const docs=[a,b].map(s=>new DOMParser().parseFromString(s,'image/svg+xml'));
      const valid=docs.every(d=>!d.querySelector('parsererror'));
      const paths=docs.map(d=>[...d.querySelectorAll('path')].map(p=>p.outerHTML));
      const styles=docs.map(d=>d.querySelector('style').textContent);
      const pixels=[...document.images].map(img=>{const c=document.createElement('canvas');c.width=900;c.height=295;const ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height);return ctx.getImageData(0,0,c.width,c.height).data;});
      return {valid,pathsIdentical:JSON.stringify(paths[0])===JSON.stringify(paths[1]),stylesIdentical:styles[0]===styles[1],pixelsIdentical:pixels[0].every((x,i)=>x===pixels[1][i])};
    })()`);
    assert(Object.values(vector).every(Boolean), JSON.stringify(vector));
    const comparison = await send('Page.captureScreenshot', {format: 'png'});
    fs.writeFileSync(path.join(__dirname, 'original-clean.png'), Buffer.from(comparison.data, 'base64'));
    const reports = [];
    for (const page of ['index.html', 'my.html?code=invalid', 'registry.html']) {
      for (const width of [1920, 1440, 1180, 768, 390, 320]) {
        await send('Emulation.setDeviceMetricsOverride', {width, height: 950, deviceScaleFactor: 1, mobile: width < 600});
        await send('Page.navigate', {url: 'http://127.0.0.1:3036/pages/' + page});
        for (let i = 0; i < 80; i++) { if (await run("!!document.querySelector('.logo img')?.naturalWidth")) break; await wait(100); }
        await run('document.fonts.ready'); await wait(100);
        const state = await run(`(()=>{const img=document.querySelector('.logo img');const r=img.getBoundingClientRect(),bar=document.querySelector('.nav-bar').getBoundingClientRect();return {src:img.getAttribute('src'),alt:img.alt,width:r.width,height:r.height,left:r.left,top:r.top,right:r.right,bottom:r.bottom,barTop:bar.top,barBottom:bar.bottom,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth};})()`);
        assert.equal(state.src, '../assets/svg/logo.svg?v=20261008-1');
        assert.equal(state.alt, 'GIPC'); assert(Math.abs(state.width - 141) < 0.1);
        assert(Math.abs(state.width / state.height - 73.74 / 24.16) < 0.003);
        assert(state.left >= 0 && state.right <= width && state.top >= state.barTop && state.bottom <= state.barBottom);
        assert(state.scroll <= state.client, 'Horizontal overflow: ' + page + ' ' + width);
        reports.push({page, viewport: width, logoWidth: state.width, logoHeight: state.height, noOverflow: true});
        if (page === 'index.html' && [1440, 390].includes(width)) {
          const shot = await send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width, height: 230, scale: 1}});
          fs.writeFileSync(path.join(__dirname, 'header-' + width + '.png'), Buffer.from(shot.data, 'base64'));
        }
      }
    }
    assert.deepEqual(errors, []);
    const result = {vector, reports, browserErrors: errors};
    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    await send('Browser.close');
  } finally { ws?.close(); chrome.kill(); server.close(); }
}
main().catch(err => {console.error(err); process.exitCode = 1;});
