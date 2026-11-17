const fs = require('fs'), vm = require('vm'), assert = require('node:assert/strict');
const html=fs.readFileSync(require('node:path').join(__dirname,'..','index.html'),'utf8');
const moduleCode=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1].replace(/^\s*import .*?;\s*$/gm,'');

const storage=new Map(); let remote={orders:[],shiftsHistory:[],custodyItems:[],expenses:[],auditLog:[],nextInvoiceNumber:1}, fail=false, hold=null, callbacks=[];
const context={console,crypto:require('node:crypto').webcrypto,navigator:{onLine:true},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},document:{getElementById:()=>null,querySelectorAll:()=>[],addEventListener:()=>{}},window:{addEventListener:()=>{}},setTimeout:()=>1,setInterval:()=>1,queueMicrotask:fn=>callbacks.push(fn),Date,Map,JSON,Math,Number,String,Blob,URL,
 doc:()=>({}),runTransaction:async(db,fn)=>{if(fail)throw Error('simulated offline'); if(hold)await hold; return fn({get:async()=>({exists:()=>true,data:()=>({payload:JSON.stringify(remote)})}),set:(ref,data)=>{remote=JSON.parse(data.payload)}})},onSnapshot:()=>()=>{}};
context.window.window=context.window; vm.createContext(context); vm.runInContext(moduleCode,context);
const run=code=>vm.runInContext(code,context);
run('refreshAllViews = () => saveLocal(); showToast=()=>{}; loadLocal(); db={}; firebaseUser={}; cloudReady=true;');
async function test(name,fn){await fn(); console.log('PASS '+name)}
(async()=>{
 await test('Legacy state migration and pending queue survive reload',async()=>{
  run("appState.orders=[{id:'ord_one',invoiceNumber:'0001',dateStr:'17/11/2026',total:100}]; queueLocalChange();");
  run('syncPending=false; appState.orders=[]; loadLocal();'); assert.equal(run('syncPending'),true); assert.equal(run('appState.orders.length'),1);
 });
 await test('Offline sale remains durable and unacknowledged',async()=>{
  context.navigator.onLine=false; assert.equal(await run('pushStateToCloud(true)'),false); assert.equal(run('syncPending'),true); assert.ok(storage.get('delicias09_state_v2').includes('ord_one'));
 });
 await test('Retry merges another device sale and acknowledges only after commit',async()=>{
  context.navigator.onLine=true;remote.orders.push({id:'ord_remote',invoiceNumber:'0002',dateStr:'17/11/2026',total:250});
  assert.equal(await run('pushStateToCloud(true)'),true);assert.equal(remote.orders.length,2);assert.equal(run('syncPending'),false);assert.equal(run('appState.nextInvoiceNumber'),3);
 });
 await test('Rejected transaction keeps pending state',async()=>{
  fail=true;run("appState.orders.push({id:'ord_fail',invoiceNumber:'0003'});"); assert.equal(await run('pushStateToCloud()'),false);assert.equal(run('syncPending'),true);fail=false;
 });
 await test('Edits during an in-flight write are not acknowledged prematurely',async()=>{
  let release;hold=new Promise(r=>release=r);const promise=run('pushStateToCloud(true)');
  run("appState.orders.push({id:'ord_later',invoiceNumber:'0004'}); queueLocalChange();");release();await promise;hold=null;
  assert.equal(run('syncPending'),true);assert.equal(run("appState.orders.some(o=>o.id==='ord_later')"),true);
  await callbacks.shift()(); await run('pushStateToCloud(true)'); assert.equal(remote.orders.length,4);assert.equal(run('syncPending'),false);
 });
 await test('Storage failure is reported and does not silently enqueue a sale',async()=>{
  const original=context.localStorage.setItem;context.localStorage.setItem=()=>{throw Error('quota')};assert.equal(run('queueLocalChange()'),false);assert.equal(run('localSaveFailed'),true);context.localStorage.setItem=original;
 });
 await test('Date ranges include both boundaries and support legacy Dominican dates',async()=>{
  run("reportFilter={preset:'custom',from:'2026-11-01',to:'2026-11-17'};");
  for(const date of ['01/11/2026','17/11/2026','2026-11-17'])assert.equal(run(`inReportPeriod({dateStr:'${date}'})`),true);
  for(const date of ['31/10/2026','18/11/2026',''])assert.equal(run(`inReportPeriod({dateStr:'${date}'})`),false);
 });
 await test('Today, week (Monday), month and full history respect RD timezone',async()=>{
  run("clockOffset = new Date('2026-11-17T02:00:00Z').getTime() - Date.now(); reportFilter={preset:'today'};");assert.equal(run('reportBounds().from'),'2026-11-16');
  run("reportFilter.preset='week'");assert.equal(run('reportBounds().from'),'2026-11-16');
  run("reportFilter.preset='month'");assert.equal(run('reportBounds().from'),'2026-11-01');
  run("reportFilter.preset='all'");assert.equal(run('inReportPeriod({})'),true);
 });
 await test('Voided remote orders cannot be resurrected by an offline copy',async()=>{
  assert.equal(run("mergeCloudState({orders:[{id:'x',voided:true}]},{orders:[{id:'x',voided:false}]},{},true).orders[0].voided"),true);
 });
 await test('Dashboard and CSV use the same date range and exclude voided orders',async()=>{
  const elements={};context.document.getElementById=id=>elements[id] ||= {innerHTML:'',classList:{add(){},remove(){}}};
  let exported;context.URL={createObjectURL:blob=>{exported=blob;return 'blob:test'},revokeObjectURL(){}};
  context.document.createElement=()=>({click(){}});
  run(`currentUser={role:'admin'};adminUnlockedInSession=true;reportFilter={preset:'custom',from:'2026-11-17',to:'2026-11-17'};
   appState.currentShift=null;appState.shiftsHistory=[];appState.custodyItems=[];
   appState.orders=[{id:'a',invoiceNumber:'001',dateStr:'17/11/2026',cashierName:'Demo',customerName:'Cliente "Prueba"',total:100,cashAmount:100,transferAmount:0},
   {id:'b',invoiceNumber:'002',dateStr:'16/11/2026',total:900,cashAmount:900,transferAmount:0},
   {id:'c',invoiceNumber:'003',dateStr:'17/11/2026',total:500,cashAmount:500,transferAmount:0,voided:true}];
   renderAdminDashboard();window.exportFullBackupCSV();`);
  assert.ok(elements['admin-live-kpis'].innerHTML.includes('RD$ 100'));assert.ok(!elements['admin-live-kpis'].innerHTML.includes('RD$ 900'));
  const csv=await exported.text();assert.equal(csv.split('\r\n').length,2);assert.ok(csv.includes('Cliente ""Prueba""'));assert.ok(!csv.includes('"002"'));
 });
 console.log('All 10 checks passed. Firebase writes were simulated; production was never contacted.');
})().catch(e=>{console.error(e);process.exitCode=1});
