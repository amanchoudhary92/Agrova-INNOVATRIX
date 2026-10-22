// Isolated integration smoke test. NEVER opens or resets the user's storage/agrova.sqlite.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import net from 'node:net';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const tmp=mkdtempSync(join(tmpdir(),'agrova-patch-verify-'));
let server=null;const checks=[];
const check=(name,fn)=>checks.push([name,fn]);
function port(){return new Promise((ok,no)=>{const s=net.createServer();s.once('error',no);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>ok(port));});});}
async function call(base,method,path,payload,cookie){const h={};if(payload!==undefined)h['Content-Type']='application/json';if(cookie)h.Cookie=cookie;const r=await fetch(base+path,{method,headers:h,body:payload===undefined?undefined:JSON.stringify(payload)});const data=await r.json();return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]||null};}
async function waitForServer(base,child){for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error('Server exited unexpectedly: '+child.exitCode);try{const r=await fetch(base+'/api/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server did not become healthy');}
async function main(){
 for(const entry of ['server.mjs','lib','public','package.json']) cpSync(join(project,entry),join(tmp,entry),{recursive:true});
 const portNum=await port(),base=`http://127.0.0.1:${portNum}`;
 server=spawn(process.execPath,['--no-warnings','server.mjs'],{cwd:tmp,env:{...process.env,PORT:String(portNum),NODE_ENV:'development',GEMINI_API_KEY:''},stdio:'pipe'});
 let serverLog='';server.stdout.on('data',b=>serverLog+=b);server.stderr.on('data',b=>serverLog+=b);
 await waitForServer(base,server);
 const api=(method,path,payload,cookie)=>call(base,method,path,payload,cookie);
 let unauth=await api('GET','/api/bootstrap');assert.equal(unauth.status,401);checks.push('Unauthenticated bootstrap rejected');
 const mgr=await api('POST','/api/auth/login',{username:'manager@agrova.test',password:'Agrova123!'});assert.equal(mgr.status,200);checks.push('Manager login');
 const buyer=await api('POST','/api/auth/login',{username:'sauce@agrova.test',password:'Buyer123!'});assert.equal(buyer.status,200);checks.push('Buyer login');
 const other=await api('POST','/api/auth/login',{username:'fresh@agrova.test',password:'Buyer123!'});assert.equal(other.status,200);checks.push('Second buyer login');
 const mgrCookie=mgr.cookie, buyerCookie=buyer.cookie;
 const baseManager=await api('GET','/api/bootstrap',undefined,mgrCookie);assert.equal(baseManager.status,200);assert(baseManager.data.lots.length>=3);checks.push('Existing seeded inventory preserved');
 const price=await api('PUT','/api/lots/LOT-001/expected-price',{price_inr:23.45},mgrCookie);assert.equal(price.status,200);
 const priceData=await api('GET','/api/bootstrap',undefined,mgrCookie);assert.equal(priceData.data.farmer_prices.find(p=>p.lot_id==='LOT-001').price_paise,2345);checks.push('Farmer expected price persists on server');
 const forbiddenPrice=await api('PUT','/api/lots/LOT-001/expected-price',{price_inr:12},buyerCookie);assert.equal(forbiddenPrice.status,403);checks.push('Buyer cannot edit farmer price');
 const order=await api('POST','/api/buyer/orders',{crop:'Onions',grade:'B',quantity_kg:12,price_inr:18.5},buyerCookie);assert.equal(order.status,201);const orderId=order.data.id;checks.push('Buyer request accepted into database');
 const seen=await api('GET','/api/bootstrap',undefined,buyerCookie);assert(seen.data.orders.some(x=>x.id===orderId));checks.push('Buyer order survives page refresh');
 const seenManager=await api('GET','/api/bootstrap',undefined,mgrCookie);assert(seenManager.data.orders.some(x=>x.id===orderId));checks.push('FPO manager can see buyer request');
 const seenOther=await api('GET','/api/bootstrap',undefined,other.cookie);assert(!seenOther.data.orders.some(x=>x.id===orderId));checks.push('Other buyers cannot see order');
 const key='test_duplicate_request_0123456789';
 const pay=await api('POST','/api/payments/demo-attempts',{order_id:orderId,status:'success',idempotency_key:key},buyerCookie);assert.equal(pay.status,200);assert.equal(pay.data.simulated,true);assert.equal(pay.data.money_received,false);
 const dup=await api('POST','/api/payments/demo-attempts',{order_id:orderId,status:'success',idempotency_key:key},buyerCookie);assert.equal(dup.data.attempt.id,pay.data.attempt.id);checks.push('Duplicate payment attempts idempotent');
 const conflict=await api('POST','/api/payments/demo-attempts',{order_id:orderId,status:'failed',idempotency_key:key},buyerCookie);assert.equal(conflict.status,409);checks.push('Idempotency key collision rejected');
 const forbidden=await api('POST','/api/payments/demo-attempts',{order_id:orderId,status:'success',idempotency_key:'different_random_0123456789'},other.cookie);assert.equal(forbidden.status,403);checks.push('Other buyer cannot post payment event');
 const history=await api('GET','/api/bootstrap',undefined,buyerCookie);assert.equal(history.data.payment_attempts.filter(p=>p.order_id===orderId).length,1);checks.push('Order-linked simulation persisted once');
 const otherHistory=await api('GET','/api/bootstrap',undefined,other.cookie);assert(!otherHistory.data.payment_attempts.some(p=>p.order_id===orderId));checks.push('Other buyer cannot read payment history');
 const paused=await api('POST','/api/buyer/orders',{crop:'x',grade:'A',quantity_kg:10,price_inr:10},buyerCookie);assert.equal(paused.status,400);checks.push('Invalid crop rejected');
 // A workspace is activated ONLY for accounts explicitly linked by fpo_id.
 const previous=process.cwd();process.chdir(tmp);
 try{
  const {run,hashPassword,one}=await import(pathToFileURL(join(tmp,'lib','db.mjs'))+'?test='+Date.now());
  run('INSERT INTO users(id,username,password_hash,display_name,role,buyer_id,fpo_id) VALUES(?,?,?,?,?,?,?)','USR-TENANT','tenant@example.test',hashPassword('TenantPass123'),'Tenant FPO Manager','manager',null,'11111111-1111-4111-8111-111111111111');
 }finally{process.chdir(previous);}
 const tenant=await api('POST','/api/auth/login',{username:'tenant@example.test',password:'TenantPass123'});assert.equal(tenant.status,200);
 const empty=await api('GET','/api/bootstrap',undefined,tenant.cookie);assert.equal(empty.status,200);assert.equal(empty.data.lots.length,0);checks.push('New FPO does not inherit demo lots');
 const created=await api('POST','/api/lots',{farmer:'Tenant Farmer',crop:'Onions',quantity_kg:12,grade:'A',safety:'cleared'},tenant.cookie);assert.equal(created.status,201);const tenantLot=created.data.id;
 const tenantBoot=await api('GET','/api/bootstrap',undefined,tenant.cookie);assert(tenantBoot.data.lots.some(x=>x.id===tenantLot));
 const rootBoot=await api('GET','/api/bootstrap',undefined,mgrCookie);assert(!rootBoot.data.lots.some(x=>x.farmer==='Tenant Farmer'));checks.push('FPO-specific lots isolated from legacy manager');
 const logout=await api('POST','/api/auth/logout',{},tenant.cookie);assert.equal(logout.status,200);
 const loggedOut=await api('GET','/api/bootstrap',undefined,tenant.cookie);assert.equal(loggedOut.status,401);checks.push('Tenant logout invalidates central session');
 console.log('\nPASS '+checks.length+' integration checks on TEMPORARY database:');for(const c of checks)console.log(' ✓',c);
}
try{await main();}catch(e){console.error('INTEGRATION CHECK FAILED:',e);process.exitCode=1;}finally{
 if(server){server.kill('SIGTERM');await new Promise(r=>{if(server.exitCode!==null||server.signalCode!==null)return r();const t=setTimeout(r,1500);server.once('exit',()=>{clearTimeout(t);r();});});}
 try{rmSync(tmp,{recursive:true,force:true});}catch{}
}
