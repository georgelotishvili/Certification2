// Isolated Chrome profile, real local frontend, synthetic read-only API.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../frontend'),wait=ms=>new Promise(r=>setTimeout(r,ms));
const people=Array.from({length:105},(_,i)=>({id:i+1,first_name:'სატესტო',last_name:'კანდიდატი '+String(i+1).padStart(3,'0'),personal_id:'00000000000',phone:'',email:'test'+i+'@example.invalid',code:String(1000000000+i),created_at:'2026-10-08T10:00:00',is_admin:false,is_founder:false,exam_permission:false,has_unseen_statements:i%3===0,has_pending_statements:i%3===1,unseen_statement_count:i%3===0?1:0,pending_statement_count:i%3===1?1:0,display_revision:'test'+i}));
let failLists=false;
async function main(){
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(req.method!=='GET')return json(405,{});
  if(url.pathname==='/admin/auth/verify')return json(200,{ok:true});
  if(url.pathname==='/admin/users'){
   if(failLists)return json(503,{});
   let items=people.filter(p=>(p.first_name+' '+p.last_name+' '+p.code).includes(url.searchParams.get('search')||''));
   const total=items.length,size=50,page=Math.min(Number(url.searchParams.get('page')||1),Math.max(1,Math.ceil(total/size)));
   items=items.slice((page-1)*size,page*size);
   return json(200,{items,total,page,size,paginated:true,live:url.searchParams.get('live')==='true',global_unseen_users:35});
  }
  if(!/\.(html|js|css|svg|ttf|woff2|png|jpg)$/.test(url.pathname))return json(200,{items:[],total:0});
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
  if(!file.startsWith(root+path.sep))return json(403,{});
  const mime={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.ttf':'font/ttf','.woff2':'font/woff2','.jpg':'image/jpeg','.png':'image/png'};
  fs.readFile(file,(err,data)=>{res.writeHead(err?404:200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(err?'Not found':data);});
 });
 await new Promise(r=>server.listen(3037,'127.0.0.1',r));
 const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--remote-debugging-port=9232','--user-data-dir='+path.join(__dirname,'chrome-test-profile'),'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws;
 try{
  let tabs;for(let i=0;i<60;i++){try{tabs=await(await fetch('http://127.0.0.1:9232/json')).json();break;}catch{await wait(100);}}
  assert(tabs);ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  let seq=0;const pending=new Map(),errors=[];
  ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const run=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
  const until=async expr=>{for(let i=0;i<80;i++){if(await run(expr))return;await wait(100);}throw Error('Timed out: '+expr);};
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Network.setBlockedURLs',{urls:['https://*','http://gipc.org.ge/*','http://www.gipc.org.ge/*','http://148.251.167.229/*']});
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"if(location.origin==='http://127.0.0.1:3037'){localStorage.setItem('authLoggedIn','true');localStorage.setItem('savedEmail','admin@example.invalid');localStorage.setItem('currentUser',JSON.stringify({id:999,email:'admin@example.invalid',isAdmin:true}));localStorage.setItem('auth_token','synthetic-qa-token');}"});
  await send('Page.navigate',{url:'http://127.0.0.1:3037/pages/admin.html'});
  await until("document.querySelectorAll('#usersGrid .block-card').length===50");
  assert(!(await run('!!window.jspdf||!!window.svg2pdf||!!window.mammoth')));
  await run("document.getElementById('usersPageNext').click()");
  await until("document.querySelector('#usersGrid .block-card')?.dataset.id==='51'");
  await run("document.getElementById('usersPageNext').click()");
  await until("document.querySelectorAll('#usersGrid .block-card').length===5");
  assert(await run("document.getElementById('usersPageNext').disabled"));
  await run("const s=document.getElementById('usersSearch');s.value='1000000104';s.dispatchEvent(new Event('input',{bubbles:true}));");
  await until("document.querySelectorAll('#usersGrid .block-card').length===1");
  assert.equal(await run("document.querySelector('#usersGrid .block-card').dataset.id"),'105');
  await run("document.querySelector('#usersGrid .head-toggle').click()");
  const reports=[];
  for(const width of [1920,1440,1024,768,730,600,390,320]){
   await send('Emulation.setDeviceMetricsOverride',{width,height:1100,deviceScaleFactor:1,mobile:width<600});
   await run('document.fonts.ready');await wait(80);
   const metrics=await run("({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,pagerVisible:!document.getElementById('usersPagination').hidden})");
   assert(metrics.scroll<=metrics.client,'Overflow '+width+': '+JSON.stringify(metrics));assert(metrics.pagerVisible);
   if([1440,390,320].includes(width)){
    const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(__dirname,'admin-'+width+'.png'),Buffer.from(shot.data,'base64'));
   }
   reports.push({width,noOverflow:true});
  }
  failLists=true;
  await run("document.getElementById('usersSearch').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("!document.getElementById('usersListRetry').hidden");
  assert(await run("document.querySelector('#usersGrid .chk-exam').disabled"));
  assert.equal(await run("document.querySelector('#usersGrid .block-card').dataset.id"),'105');
  failLists=false;
  await run("document.getElementById('usersListRetry').click()");
  await until("document.getElementById('usersListNotice').hidden");
  assert(!(await run("document.querySelector('#usersGrid .chk-exam').disabled")));
  const docx=spawnSync(path.resolve(root,'../backend/.venv/Scripts/python.exe'),['-c',`import io,zipfile,base64
b=io.BytesIO()
with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ქართული სატესტო დოკუმენტი</w:t></w:r></w:p></w:body></w:document>')
print(base64.b64encode(b.getvalue()).decode())`],{encoding:'utf8',windowsHide:true});
  assert.equal(docx.status,0,docx.stderr);
  await run(`(()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(docx.stdout.trim())}),c=>c.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],'synthetic.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}));const input=document.getElementById('documentFile');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until("document.getElementById('documentContent').textContent==='ქართული სატესტო დოკუმენტი'");
  assert(await run('!!window.mammoth'));
  assert.equal(await run("performance.getEntriesByType('resource').filter(r=>r.name.includes('/vendor/mammoth.browser.min.js')).length"),1);
  assert.deepEqual(errors,[]);
  const result={reports,pagination:true,searchBeyondFirstPage:true,emptyEagerLibraries:true,staleExamGuard:true,retry:true,realGeorgianWordImport:true,browserErrors:0};
  fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  await send('Browser.close');
 }finally{ws?.close();chrome.kill();server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
