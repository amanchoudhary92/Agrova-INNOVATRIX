import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sandbox=mkdtempSync(join(tmpdir(),'agrova-evidence-test-'));
let server;
let base;
let managerCookie;
let deliveryId;

const freePort=()=>new Promise((resolvePort,reject)=>{
 const socket=net.createServer();
 socket.once('error',reject);
 socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolvePort(port));});
});

async function api(method,path,body,cookie=managerCookie){
 const response=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json();
 return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}

async function waitUntilReady(){
 for(let attempt=0;attempt<80;attempt++){
  if(server.exitCode!==null)throw Error(`Test server exited with ${server.exitCode}`);
  try{if((await fetch(base+'/api/health')).ok)return;}catch{}
  await new Promise(resolveWait=>setTimeout(resolveWait,100));
 }
 throw Error('Test server did not become ready.');
}

before(async()=>{
 for(const entry of ['server.mjs','lib','public','package.json'])cpSync(join(project,entry),join(sandbox,entry),{recursive:true});
 const port=await freePort();base=`http://127.0.0.1:${port}`;
 server=spawn(process.execPath,['--no-warnings','server.mjs'],{cwd:sandbox,env:{...process.env,PORT:String(port),GEMINI_API_KEY:''},stdio:'pipe'});
 await waitUntilReady();
 const login=await api('POST','/api/auth/login',{username:'manager@agrova.test',password:'Agrova123!'},null);
 assert.equal(login.status,200);managerCookie=login.cookie;
 const offer=await api('POST','/api/offers',{case_id:'CASE-001',order_id:'ORD-002',quantity_kg:30});
 assert.equal(offer.status,201);
 assert.equal((await api('POST',`/api/offers/${offer.data.id}/demo-accept`,{})).status,200);
 assert.equal((await api('POST',`/api/offers/${offer.data.id}/reserve`,{})).status,200);
 const delivery=await api('POST','/api/deliveries',{offer_id:offer.data.id,delivered_kg:30,accepted_kg:28,rejected_kg:2});
 assert.equal(delivery.status,201);deliveryId=delivery.data.id;
});

after(async()=>{
 if(server){server.kill('SIGTERM');await new Promise(resolveExit=>{if(server.exitCode!==null||server.signalCode!==null)return resolveExit();const timer=setTimeout(resolveExit,1500);server.once('exit',()=>{clearTimeout(timer);resolveExit();});});}
 rmSync(sandbox,{recursive:true,force:true});
});

test('initial verification persists inspection and buyer evidence for reconciliation',async()=>{
 const verified=[];
 for(const [kind,accepted] of [['inspection',28],['buyer',25]]){
  const upload=await api('POST','/api/evidence',{delivery_id:deliveryId,kind,file_name:`${kind}.txt`,mime:'text/plain',base64:Buffer.from(`Lot: LOT-002\nDelivered: 30\nAccepted: ${accepted}\nRate: 16\n`).toString('base64')});
  assert.equal(upload.status,201);
  const verification=await api('POST',`/api/evidence/${upload.data.id}/verify`,{accepted_kg:accepted,delivered_kg:30,rejected_kg:30-accepted,rate_inr:16,deductions_inr:0,lot_ref:'LOT-002',source_reference:`${kind} source`});
  assert.deepEqual(verification,{status:200,data:{ok:true},cookie:undefined});
  verified.push({id:upload.data.id,kind,accepted});
 }

 const bootstrap=await api('GET','/api/bootstrap');
 assert.equal(bootstrap.status,200);
 const delivery=bootstrap.data.deliveries.find(item=>item.id===deliveryId);
 assert.equal(delivery.reconciliation.inspection_kg,28);
 assert.equal(delivery.reconciliation.buyer_kg,25);
 assert.equal(delivery.reconciliation.disputed_paise,4800);
 for(const expected of verified){
  const evidence=delivery.evidence.find(item=>item.id===expected.id);
  assert.equal(evidence.kind,expected.kind);
  assert.equal(evidence.verified.accepted_kg,expected.accepted);
  assert.equal(evidence.verified.delivered_kg,30);
 }
 const verificationEvents=bootstrap.data.events.filter(event=>event.action==='EVIDENCE_VERIFIED'&&verified.some(item=>item.id===event.ref));
 assert.equal(verificationEvents.length,2);
});
