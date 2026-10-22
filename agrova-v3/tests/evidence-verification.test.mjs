import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import {DatabaseSync} from 'node:sqlite';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sandbox=mkdtempSync(join(tmpdir(),'agrova-evidence-test-'));
let server;
let base;
let managerCookie;
let deliveryId;
const versionsFor=id=>{const history=new DatabaseSync(join(sandbox,'storage','agrova.sqlite'));try{return history.prepare('SELECT * FROM evidence_versions WHERE evidence_id=? ORDER BY version_number').all(id);}finally{history.close();}};

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
  const versions=versionsFor(expected.id);
  assert.equal(versions.length,1);
  assert.equal(versions[0].version_number,1);
  assert.equal(versions[0].reason,null);
  assert.equal(versions[0].manager_id,'USR-001');
  assert.deepEqual(JSON.parse(versions[0].verified_json),evidence.verified);
 }
 const verificationEvents=bootstrap.data.events.filter(event=>event.action==='EVIDENCE_VERIFIED'&&verified.some(item=>item.id===event.ref));
 assert.equal(verificationEvents.length,2);
});

test('manager correction uses a separate route and preserves before-and-after audit values',async()=>{
 const initial=(await api('GET','/api/bootstrap')).data;
 const delivery=initial.deliveries.find(item=>item.id===deliveryId);
 const buyerEvidence=delivery.evidence.find(item=>item.kind==='buyer');
 const path=`/api/evidence/${buyerEvidence.id}/correct`;
 const fields={...buyerEvidence.verified,accepted_kg:27,reason:'Buyer receipt transcription fixed.',expected_verified_json:JSON.stringify(buyerEvidence.verified)};
 const review=await api('POST','/api/reviews',{delivery_id:deliveryId,decision:'more_evidence',note:'Check the original buyer statement.'});
 assert.equal(review.status,201);
 assert.equal((await api('POST',path,{...fields,reason:'short'})).status,400);
 assert.equal((await api('POST',path,{...fields,accepted_kg:31})).status,400);
 const buyerLogin=await api('POST','/api/auth/login',{username:'sauce@agrova.test',password:'Buyer123!'},null);
 assert.equal(buyerLogin.status,200);
 assert.equal((await api('POST',path,fields,buyerLogin.cookie)).status,403);
 const corrected=await api('POST',path,fields);
 assert.equal(corrected.status,200);
 assert.equal(corrected.data.ok,true);
 const updated=(await api('GET','/api/bootstrap')).data;
 const settlement=updated.deliveries.find(item=>item.id===deliveryId);
 assert.equal(settlement.evidence.find(item=>item.id===buyerEvidence.id).verified.accepted_kg,27);
 assert.deepEqual(settlement.evidence.find(item=>item.id===buyerEvidence.id).versions.map(item=>item.version_number),[2,1]);
 assert.equal(settlement.evidence.find(item=>item.id===buyerEvidence.id).versions[0].current,true);
 assert.equal(settlement.reconciliation.disputed_paise,1600);
 assert.equal(settlement.settlement_status,'needs_review');
 const auditEvent=updated.events.find(event=>event.action==='EVIDENCE_CORRECTED'&&event.ref===buyerEvidence.id);
 assert.equal(JSON.parse(auditEvent.detail).previous.accepted_kg,25);
 assert.equal(JSON.parse(auditEvent.detail).corrected.accepted_kg,27);
 assert.equal(JSON.parse(auditEvent.detail).reason,fields.reason);
 assert.equal(JSON.parse(auditEvent.detail).old_kg,25);
 assert.equal(JSON.parse(auditEvent.detail).new_kg,27);
 const versions=versionsFor(buyerEvidence.id);
 assert.deepEqual(versions.map(item=>item.version_number),[1,2]);
 assert.equal(JSON.parse(versions[0].verified_json).accepted_kg,25);
 assert.equal(JSON.parse(versions[1].verified_json).accepted_kg,27);
 assert.equal(versions[1].reason,fields.reason);
 assert.equal((await api('POST',path,fields)).status,409);
});

test('correction requires verified evidence and rejects stale snapshots',async()=>{
 const upload=await api('POST','/api/evidence',{delivery_id:deliveryId,kind:'buyer',file_name:'new-statement.txt',mime:'text/plain',base64:Buffer.from('Accepted: 24').toString('base64')});
 assert.equal(upload.status,201);
 const unverified=await api('POST',`/api/evidence/${upload.data.id}/correct`,{accepted_kg:24,reason:'Corrected statement reference.'});
 assert.equal(unverified.status,409);

 const before=(await api('GET','/api/bootstrap')).data;
 const inspection=before.deliveries.find(item=>item.id===deliveryId).evidence.find(item=>item.kind==='inspection');
 const path=`/api/evidence/${inspection.id}/correct`;
 const stale=JSON.stringify(inspection.verified);
 assert.equal((await api('POST',path,{...inspection.verified,accepted_kg:'',reason:'Inspection receipt reading fixed.',expected_verified_json:stale})).status,400);
 const first=await api('POST',path,{...inspection.verified,accepted_kg:27,reason:'Inspection receipt reading fixed.',expected_verified_json:stale});
 assert.equal(first.status,200);
 const second=await api('POST',path,{...inspection.verified,accepted_kg:26,reason:'Another inspection adjustment.',expected_verified_json:stale});
 assert.equal(second.status,409);
 const after=(await api('GET','/api/bootstrap')).data;
 const correctedDelivery=after.deliveries.find(item=>item.id===deliveryId);
 assert.equal(correctedDelivery.evidence.find(item=>item.id===inspection.id).verified.accepted_kg,27);
 assert.equal(correctedDelivery.reconciliation.disputed_paise,0);
 assert.equal(correctedDelivery.settlement_status,'needs_review','a correction after review reopens even a zero-difference delivery');
 assert.equal(after.events.filter(event=>event.action==='EVIDENCE_CORRECTED'&&event.ref===inspection.id).length,1);
});

test('repeat verify rejects both evidence kinds without changing verified values or events',async()=>{
 const before=(await api('GET','/api/bootstrap')).data;
 const delivery=before.deliveries.find(item=>item.id===deliveryId);
 const snapshots=delivery.evidence.filter(item=>item.verified).map(item=>({id:item.id,verified:item.verified}));
 const eventCount=before.events.filter(event=>event.action==='EVIDENCE_VERIFIED').length;
 for(const {id} of snapshots){
  const repeat=await api('POST',`/api/evidence/${id}/verify`,{accepted_kg:1,delivered_kg:30,rate_inr:16});
  assert.equal(repeat.status,409);
  assert.match(repeat.data.error,/already verified/);
 }
 const after=(await api('GET','/api/bootstrap')).data;
 const unchanged=after.deliveries.find(item=>item.id===deliveryId);
 for(const {id,verified} of snapshots)assert.deepEqual(unchanged.evidence.find(item=>item.id===id).verified,verified);
 assert.equal(after.events.filter(event=>event.action==='EVIDENCE_VERIFIED').length,eventCount);
});

test('settlement reads newest version even if the legacy mirror becomes stale',async()=>{
 const before=(await api('GET','/api/bootstrap')).data;
 const buyer=before.deliveries.find(item=>item.id===deliveryId).evidence.find(item=>item.kind==='buyer'&&item.verified);
 const history=new DatabaseSync(join(sandbox,'storage','agrova.sqlite'));
 try{
  history.prepare('UPDATE evidence SET verified_json=? WHERE id=?').run(JSON.stringify({...buyer.verified,accepted_kg:1}),buyer.id);
  const delivery=(await api('GET','/api/bootstrap')).data.deliveries.find(item=>item.id===deliveryId);
  assert.equal(delivery.evidence.find(item=>item.id===buyer.id).verified.accepted_kg,27);
  assert.equal(delivery.reconciliation.buyer_kg,27);
 }finally{
  history.prepare('UPDATE evidence SET verified_json=? WHERE id=?').run(JSON.stringify(buyer.verified),buyer.id);
  history.close();
 }
});

test('later corrections append without changing any earlier version',async()=>{
 const before=(await api('GET','/api/bootstrap')).data;
 const buyer=before.deliveries.find(item=>item.id===deliveryId).evidence.find(item=>item.kind==='buyer'&&item.verified);
 const earlier=versionsFor(buyer.id);
 assert.deepEqual(earlier.map(item=>item.version_number),[1,2]);
 const changed=await api('POST',`/api/evidence/${buyer.id}/correct`,{
  ...buyer.verified,accepted_kg:26,rejected_kg:4,
  reason:'Buyer confirmed one further kilogram rejected.',
  expected_verified_json:JSON.stringify(buyer.verified)
 });
 assert.equal(changed.status,200);
 const later=versionsFor(buyer.id);
 assert.deepEqual(later.map(item=>item.version_number),[1,2,3]);
 assert.deepEqual(later.slice(0,2),earlier,'earlier rows must remain byte-for-byte unchanged');
 assert.equal(JSON.parse(later[2].verified_json).accepted_kg,26);
 const delivery=(await api('GET','/api/bootstrap')).data.deliveries.find(item=>item.id===deliveryId);
 assert.deepEqual(delivery.evidence.find(item=>item.id===buyer.id).versions.map(item=>item.version_number),[3,2,1]);
 assert.equal(delivery.evidence.find(item=>item.id===buyer.id).versions[0].current,true);
 assert.equal(delivery.reconciliation.disputed_paise,1600);
 assert.equal(delivery.settlement_status,'needs_review');
});
