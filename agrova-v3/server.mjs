import http from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,extname} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {db,sql,one,run,transaction,nextId,audit,seedDemo,comparePassword,tokenHash,withWorkspace,workspaceFor} from './lib/db.mjs';
import {finiteKg,moneyPaise,maxOffer,matchStock,reconcile,heuristicTextExtract,correctionReason,evidenceQuantities} from './lib/domain.mjs';
import {freeQuantity,orderCoverage,netRecovery,qualityCheck} from './lib/v3.mjs';
import {latestEvidenceVersion,listEvidenceVersions,insertEvidenceVersion} from './lib/evidence-versions.mjs';
const publicDir=resolve('public');const storageDir=resolve('storage');
const error=(message,code=400)=>Object.assign(new Error(message),{status:code});
const ensure=(condition,message,code=400)=>{if(!condition)throw error(message,code)};
const validate=(fn)=>{try{return fn();}catch(e){throw error(e.message);}};
const allowedGrade=['A','B','C'];const allowedSafety=['cleared','hold','pending'];
const now=()=>new Date().toISOString();
const str=(v,max=140)=>{const s=String(v??'').trim();ensure(s.length>0&&s.length<=max,'Required text is missing or too long.');return s};
const row=(table,id)=>{const item=one(`SELECT * FROM ${table} WHERE id=?`,id);ensure(item,`${table.slice(0,-1)} not found.`,404);return item};
const originalActive=()=>sql("SELECT * FROM original_allocations WHERE status IN ('reserved','dispatched')");
const active=()=>[...sql("SELECT * FROM offers WHERE status IN ('reserved','delivered')"),...originalActive()];
const coverage=o=>orderCoverage(o,sql('SELECT * FROM lots'),sql('SELECT * FROM offers'),sql('SELECT * FROM original_allocations'));

function reply(res,status,data,headers={}){const body=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(body)}
async function bodyJson(req){let chunks=[];let size=0;for await (const chunk of req){size+=chunk.length;ensure(size<=8500000,'Request too large (5 MB upload limit).',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{throw error('Invalid JSON payload.')}}
function loggedIn(req){const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('agrova_session='))?.split('=')[1];if(!token)return null;const s=one('SELECT u.id,u.username,u.display_name,u.role,u.buyer_id,u.fpo_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',tokenHash(token),Date.now());return s||null;}
const requireUser=(user)=>{ensure(user,'Sign in to continue.',401);return user};
const manager=(user)=>{requireUser(user);ensure(user.role==='manager','FPO manager access required.',403);return user;};
const canViewDelivery=(user,d)=>{manager(user);return d};
function breakdown(delivery){
 const docs=sql('SELECT * FROM evidence WHERE delivery_id=? ORDER BY created_at DESC,id DESC',delivery.id);
 const evidence=docs.map(({file_path,...doc})=>{
  const versions=listEvidenceVersions(doc.id).map((version,index)=>({version_number:version.version_number,reason:version.reason,manager_id:version.manager_id,manager_name:one('SELECT display_name FROM users WHERE id=?',version.manager_id)?.display_name||version.manager_id,created_at:version.created_at,verified:JSON.parse(version.verified_json),current:index===0}));
  return {...doc,proposed:parseJSON(doc.proposed_json),verified:versions[0]?.verified||null,versions};
 });
 const verified=kind=>evidence.find(d=>d.kind===kind && d.verified)?.verified||null;
 const ins=verified('inspection');
 const buyer=verified('buyer');
 const offer=row('offers',delivery.offer_id);
 const rate=offer.agreed_price_paise;
 const rec=reconcile(ins?.accepted_kg??delivery.accepted_kg,buyer?.accepted_kg??null,rate,ins?.deductions_inr!=null?moneyPaise(ins.deductions_inr):0);
 const reviews=sql('SELECT * FROM reviews WHERE delivery_id=? ORDER BY created_at DESC,id DESC',delivery.id);
 const latest=reviews[0]||null;
 const inspectionConflict=ins!=null && Math.abs(ins.accepted_kg-delivery.accepted_kg)>0.0001;
 const reviewEvent=latest?one("SELECT rowid FROM events WHERE action='REVIEW_RECORDED' AND ref=? ORDER BY rowid DESC LIMIT 1",latest.id):null;
 const verifiedAfterReview=reviewEvent ? !!one("SELECT id FROM events WHERE rowid>? AND action IN ('EVIDENCE_VERIFIED','EVIDENCE_CORRECTED') AND ref IN (SELECT id FROM evidence WHERE delivery_id=?) LIMIT 1",reviewEvent.rowid,delivery.id) : false;
 const correctionAfterReview=reviewEvent ? !!one("SELECT id FROM events WHERE rowid>? AND action='EVIDENCE_CORRECTED' AND ref IN (SELECT id FROM evidence WHERE delivery_id=?) LIMIT 1",reviewEvent.rowid,delivery.id) : false;
 const settlement_status=correctionAfterReview?'needs_review':latest&&!verifiedAfterReview?(latest.decision==='more_evidence'?'more_evidence':'reviewed_unpaid'):(inspectionConflict||rec.difference_kg!=null&&rec.difference_kg!==0?'needs_review':'awaiting_buyer_evidence');
 return {...delivery,offer,inspection_document_kg:ins?.accepted_kg??null,buyer_document_kg:buyer?.accepted_kg??null,inspection_conflict:inspectionConflict,reconciliation:rec,settlement_status,latest_review:latest,evidence};
}
const parseJSON=v=>{try{return JSON.parse(v)}catch{return null}};
function bootstrap(user){requireUser(user);
 const orders=user.role==='buyer'?sql('SELECT * FROM orders WHERE buyer_id=? ORDER BY id',user.buyer_id):sql('SELECT * FROM orders ORDER BY id');
 const offers=user.role==='buyer'?sql('SELECT ofr.* FROM offers ofr JOIN orders o ON o.id=ofr.order_id WHERE o.buyer_id=? ORDER BY ofr.created_at DESC,ofr.id DESC',user.buyer_id):sql('SELECT * FROM offers ORDER BY created_at DESC,id DESC');
 const payment_attempts=user.role==='buyer'
 ?sql('SELECT p.* FROM demo_payment_attempts p JOIN orders o ON o.id=p.order_id WHERE o.buyer_id=? ORDER BY p.rowid',user.buyer_id)
 :sql('SELECT * FROM demo_payment_attempts ORDER BY rowid');
 if(user.role==='buyer')return {user,orders,offers,payment_attempts,events:[],server_time:now()};
 return {user,version:'3.1',farmer_prices:sql('SELECT * FROM farmer_price_notes'),payment_attempts,suppliers:sql('SELECT * FROM supplier_quotes ORDER BY created_at,id'),original_allocations:sql('SELECT * FROM original_allocations ORDER BY id'),lots:sql('SELECT * FROM lots ORDER BY id'),orders,cases:sql('SELECT * FROM cases ORDER BY id'),offers,deliveries:sql('SELECT * FROM deliveries ORDER BY created_at DESC,id DESC').map(breakdown),events:sql('SELECT e.*,coalesce(u.display_name,e.actor_id) actor_name FROM events e LEFT JOIN users u ON u.id=e.actor_id ORDER BY e.created_at DESC,e.id DESC LIMIT 100'),server_time:now(),ai_enabled:!!process.env.GEMINI_API_KEY};
}
function cleanExtract(data){const n=(v,max=10000000)=>{if(v==null||v==='')return null;const x=Number(v);return Number.isFinite(x)&&x>=0&&x<=max?x:null};return {lot_ref:typeof data?.lot_ref==='string'?data.lot_ref.slice(0,50):null,delivered_kg:n(data?.delivered_kg),accepted_kg:n(data?.accepted_kg),rejected_kg:n(data?.rejected_kg),rate_inr:n(data?.rate_inr),deductions_inr:n(data?.deductions_inr),document_date:typeof data?.document_date==='string'?data.document_date.slice(0,40):null,source_reference:typeof data?.source_reference==='string'?data.source_reference.slice(0,220):null};}
async function extractEvidence(record){
 const file=await readFile(join(storageDir,record.file_path));
 if(!process.env.GEMINI_API_KEY){ensure(record.mime==='text/plain','Gemini is not configured. For PDF/images, enter and verify fields manually, or set GEMINI_API_KEY.',422);return {engine:'offline-text-parser',fields:cleanExtract(heuristicTextExtract(file.toString('utf8')))};}
 const model=process.env.GEMINI_MODEL||'gemini-2.5-flash';
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),30000);
 try{
  const part=record.mime==='text/plain'?{text:file.toString('utf8')}:{inline_data:{mime_type:record.mime,data:file.toString('base64')}};
  const resp=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},body:JSON.stringify({contents:[{role:'user',parts:[{text:'Extract only values actually printed in this agricultural delivery receipt/buyer statement. Output ONLY JSON object with keys lot_ref, delivered_kg, accepted_kg, rejected_kg, rate_inr, deductions_inr, document_date, source_reference. Use null for absent or unreadable values. Never invent. source_reference should cite the printed heading/line or page.'},part]}],generationConfig:{responseMimeType:'application/json',temperature:0}})});
  const payload=await resp.json();ensure(resp.ok,`Gemini request failed (${resp.status}): ${String(payload.error?.message||'API error').slice(0,180)}`,502);
  const text=payload.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('');ensure(text,'Gemini returned no extracted fields.',502);
  return {engine:'gemini',fields:cleanExtract(JSON.parse(text))};
 }finally{clearTimeout(timeout)}
}
async function handle(req,res){const url=new URL(req.url,'http://localhost');const path=url.pathname;const method=req.method||'GET';const user=loggedIn(req);
 // Tenant-scoped accounts execute inside their own database. Legacy demo users
 // retain the original database, preventing existing data migration or loss.
 return withWorkspace(user?.fpo_id?workspaceFor(user.fpo_id):null,async()=>{
 try{
 if(method!=='GET'&&req.headers.origin){const origin=new URL(req.headers.origin);ensure(origin.host===req.headers.host,'Cross-origin write requests are not allowed.',403);}
 if(path==='/api/health')return reply(res,200,{ok:true,app:'Agrova V3',server_time:now()});
 if(path==='/api/auth/login'&&method==='POST'){
  const b=await bodyJson(req);const account=one('SELECT * FROM users WHERE username=?',String(b.username||'').trim().toLowerCase());ensure(account&&comparePassword(String(b.password||''),account.password_hash),'Invalid email or password.',401);
  const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',tokenHash(token),account.id,Date.now()+1000*60*60*12);
  return reply(res,200,{ok:true}, {'Set-Cookie':`agrova_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${process.env.NODE_ENV==='production'?'; Secure':''}`});
 }
 if(path==='/api/auth/logout'&&method==='POST'){
  const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('agrova_session='))?.split('=')[1];if(token)withWorkspace(null,()=>run('DELETE FROM sessions WHERE token_hash=?',tokenHash(token)));
  return reply(res,200,{ok:true},{'Set-Cookie':'agrova_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});
 }
 if(path==='/api/bootstrap'&&method==='GET')return reply(res,200,bootstrap(user));
 if(path==='/api/demo/reset'&&method==='POST'){
  manager(user);seedDemo();audit(user.id,'DEMO_RESET','ALL',{});return reply(res,200,{ok:true});
 }
 if(path==='/api/lots'&&method==='POST'){
  manager(user);const b=await bodyJson(req);const quantity=finiteKg(b.quantity_kg);const grade=str(b.grade,2);const safety=str(b.safety,10);ensure(allowedGrade.includes(grade)&&allowedSafety.includes(safety),'Invalid grade/safety.');
  const id=transaction(()=>{const id=nextId('lot','LOT');run('INSERT INTO lots VALUES(?,?,?,?,?,?,?,1)',id,str(b.farmer),str(b.crop),quantity,grade,safety,now());audit(user.id,'LOT_CREATED',id,{quantity,grade,safety});return id;});return reply(res,201,{id});
 }
 let m=path.match(/^\/api\/lots\/(LOT-\d+)$/);
 if(m&&method==='PATCH'){
  manager(user);const b=await bodyJson(req);const id=m[1];const current=row('lots',id);const quantity=finiteKg(b.quantity_kg);const grade=str(b.grade,2);const safety=str(b.safety,10);ensure(allowedGrade.includes(grade)&&allowedSafety.includes(safety),'Invalid grade/safety.');
  return reply(res,200,transaction(()=>{const locked=active().filter(a=>a.lot_id===id);const utilized=locked.reduce((s,a)=>s+a.quantity_kg,0);
   ensure(quantity>=utilized,'Quantity cannot be lower than reserved or delivered volume.',409);
   if(locked.length)ensure(current.grade===grade&&current.safety===safety,'Reserved/delivered lots cannot change grade or safety. Start a new inspection workflow.',409);
   run('UPDATE lots SET quantity_kg=?,grade=?,safety=?,version=version+1 WHERE id=?',quantity,grade,safety,id);audit(user.id,'LOT_INSPECTION_UPDATED',id,{from:current,to:{quantity,grade,safety}});return {ok:true};}));
 }
 // Buyer-created orders are stored server-side and scoped to the signed-in buyer.
 if(path==='/api/buyer/orders'&&method==='POST'){
  requireUser(user);ensure(user.role==='buyer','Buyer account required.',403);
  const b=await bodyJson(req);const quantity=finiteKg(b.quantity_kg);
  ensure(quantity>=0.001,'Quantity must be at least 0.001 kg.');
  ensure(quantity<=100000,'Quantity cannot exceed 100,000 kg.');
  const crop=str(b.crop,100);ensure(crop.length>=2,'Crop must contain at least 2 characters.');
  const grade=str(b.grade,2);ensure(allowedGrade.includes(grade),'Invalid grade.');
  const rawPrice=Number(b.price_inr);ensure(Number.isFinite(rawPrice)&&rawPrice>0&&rawPrice<=100000,'Invalid target price.');
  const price=moneyPaise(rawPrice);
  return reply(res,201,transaction(()=>{const id=nextId('order','ORD');
   run('INSERT INTO orders (id,buyer_id,buyer_name,crop,grade,quantity_kg,price_paise,availability,is_original,created_at,transport_paise,handling_paise) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id,user.buyer_id,user.display_name,crop,grade,quantity,price,'accepting',0,now(),0,0);
   audit(user.id,'BUYER_ORDER_REQUESTED',id,{quantity,crop,grade});return {id,status:'request_recorded',note:'Order request only. No inventory reserved or payment processed.'};}));
 }
 // Persistent but *informational* farmer expected price. Not a validated sale rate.
 let priceMatch=path.match(/^\/api\/lots\/(LOT-\d+)\/expected-price$/);
 if(priceMatch&&method==='PUT'){
  manager(user);const b=await bodyJson(req),lot=row('lots',priceMatch[1]);
  const clear=b.price_inr===null||b.price_inr==='';
  const value=Number(b.price_inr);
  if(!clear)ensure(Number.isFinite(value)&&value>=0&&value<=100000,'Expected price must be between ₹0 and ₹100,000.');
  return reply(res,200,transaction(()=>{
   if(clear)run('DELETE FROM farmer_price_notes WHERE lot_id=?',lot.id);
   else run('INSERT INTO farmer_price_notes(lot_id,price_paise,updated_by,updated_at) VALUES(?,?,?,?) ON CONFLICT(lot_id) DO UPDATE SET price_paise=excluded.price_paise,updated_by=excluded.updated_by,updated_at=excluded.updated_at',lot.id,moneyPaise(value),user.id,now());
   audit(user.id,'FARMER_EXPECTED_PRICE_UPDATED',lot.id,{clear,price_inr:clear?null:value});return {ok:true};}));
 }
 // An auditable payment *simulator*, NEVER proof of actual funds received.
 if(path==='/api/payments/demo-attempts'&&method==='POST'){
  requireUser(user);const b=await bodyJson(req),order=row('orders',str(b.order_id,40));
  ensure(user.role==='manager'||(user.role==='buyer'&&order.buyer_id===user.buyer_id),'Not your order.',403);
  const status=str(b.status,20),key=str(b.idempotency_key,90);
  ensure(['pending','success','failed','delayed','refund'].includes(status),'Unsupported simulator state.');
  ensure(/^[a-zA-Z0-9_-]{16,90}$/.test(key),'Invalid idempotency key.');
  const attempt=transaction(()=>{
   const previous=one('SELECT * FROM demo_payment_attempts WHERE actor_id=? AND idempotency_key=?',user.id,key);
   if(previous){ensure(previous.order_id===order.id&&previous.status===status,'Idempotency key reused for a different attempt.',409);return previous;}
   const id=nextId('demo-payment','PAY-DEMO');
   run('INSERT INTO demo_payment_attempts(id,order_id,actor_id,idempotency_key,status,created_at) VALUES(?,?,?,?,?,?)',id,order.id,user.id,key,status,now());
   audit(user.id,'SIMULATED_PAYMENT_'+status.toUpperCase(),order.id,{attempt_id:id,simulated:true});
   return one('SELECT * FROM demo_payment_attempts WHERE id=?',id);
  });
  return reply(res,200,{attempt,simulated:true,money_received:false});
 }
 if(path==='/api/orders'&&method==='POST'){
  manager(user);const b=await bodyJson(req);const quantity=finiteKg(b.quantity_kg);const price=moneyPaise(b.price_inr);const grade=str(b.grade,2);ensure(allowedGrade.includes(grade),'Invalid grade.');const availability=b.availability==='paused'?'paused':'accepting';
  return reply(res,201,transaction(()=>{const id=nextId('order','ORD');run('INSERT INTO orders (id,buyer_id,buyer_name,crop,grade,quantity_kg,price_paise,availability,is_original,created_at,transport_paise,handling_paise) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,str(b.buyer_id,50).toLowerCase(),str(b.buyer_name),str(b.crop),grade,quantity,price,availability,0,now(),moneyPaise(b.transport_inr??0),moneyPaise(b.handling_inr??0));audit(user.id,'BUYER_ORDER_CREATED',id,{buyer:b.buyer_name,quantity});return {id};}));
 }
 m=path.match(/^\/api\/orders\/(ORD-\d+)$/);
 if(m&&method==='PATCH'){
  requireUser(user);const b=await bodyJson(req);const order=row('orders',m[1]);ensure(user.role==='manager'||user.buyer_id===order.buyer_id,'Cannot edit another buyer order.',403);
  const qty=finiteKg(b.quantity_kg);const price=moneyPaise(b.price_inr);const availability=b.availability==='paused'?'paused':'accepting';
  return reply(res,200,transaction(()=>{const reserved=active().filter(o=>o.order_id===order.id);ensure(qty>=reserved.reduce((s,x)=>s+x.quantity_kg,0),'Demand cannot be smaller than reserved/delivered volume.',409);ensure(!reserved.length||price===order.price_paise,'Cannot reprice an order with existing reservations.',409);
   const transport=moneyPaise(b.transport_inr??order.transport_paise/100),handling=moneyPaise(b.handling_inr??order.handling_paise/100);
   run('UPDATE orders SET quantity_kg=?,price_paise=?,availability=?,transport_paise=?,handling_paise=? WHERE id=?',qty,price,availability,transport,handling,order.id);audit(user.id,'ORDER_UPDATED',order.id,{qty,price,availability});return {ok:true};}));
 }
 // V3 partner sourcing. Quotes are user-entered demo offers, not a live supplier marketplace.
 if(path==='/api/sourcing/quotes'&&method==='POST'){
  manager(user);const b=await bodyJson(req);const original=row('orders',str(b.original_order_id,40));ensure(original.is_original===1,'Only original buyer commitments can be sourced.');
  const quantity=finiteKg(b.offered_kg),rate=moneyPaise(b.rate_inr),transport=moneyPaise(b.transport_inr??0),handling=moneyPaise(b.handling_inr??0);
  const grade=str(b.grade,2),crop=str(b.crop,140),supplier=str(b.supplier_name,140),location=str(b.location,140);
  ensure(allowedGrade.includes(grade),'Choose Grade A, B or C.');
  return reply(res,201,transaction(()=>{const id=nextId('source','SRC');run('INSERT INTO supplier_quotes(id,original_order_id,supplier_name,location,crop,grade,offered_kg,unit_price_paise,transport_paise,handling_paise,source_reference,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,original.id,supplier,location,crop,grade,quantity,rate,transport,handling,'MANUALLY_ENTERED_QUOTE','quoted',now());audit(user.id,'SOURCING_QUOTE_CREATED',id,{original:original.id,supplier,quantity});return {id};}));
 }
 let srcm=path.match(/^\/api\/sourcing\/(SRC-\d+)\/(confirm|receive|cancel)$/);
 if(srcm&&method==='POST'){
  manager(user);const id=srcm[1],action=srcm[2],b=await bodyJson(req);
  return reply(res,200,transaction(()=>{
   const q=row('supplier_quotes',id);const original=row('orders',q.original_order_id);
   if(action==='confirm'){
    ensure(q.status==='quoted','Only open quotes can be confirmed.',409);
    run("UPDATE supplier_quotes SET status='demo_confirmed' WHERE id=?",id);
    audit(user.id,'SUPPLIER_CONFIRMATION_SIMULATED',id,{warning:'Demo action, not supplier authenticated.'});
    return {status:'demo_confirmed'};
   }
   if(action==='cancel'){
    ensure(['quoted','demo_confirmed'].includes(q.status),'Cannot cancel an already received supply.',409);
    run("UPDATE supplier_quotes SET status='cancelled' WHERE id=?",id);
    audit(user.id,'SUPPLIER_QUOTE_CANCELLED',id,{});return {status:'cancelled'};
   }
   ensure(q.status==='demo_confirmed','Confirm this illustrative quote before receiving.',409);
   const qty=finiteKg(b.received_kg),grade=str(b.grade,2),safety=str(b.safety,10);
   ensure(qty<=q.offered_kg+.0001,'Received quantity cannot exceed the confirmed quotation.',409);
   ensure(allowedGrade.includes(grade)&&allowedSafety.includes(safety),'Invalid inspection grade or safety status.');
   const lotId=nextId('lot','LOT');run('INSERT INTO lots VALUES(?,?,?,?,?,?,?,1)',lotId,q.supplier_name,q.crop,qty,grade,safety,now());
   run("UPDATE supplier_quotes SET status='received',received_kg=?,received_lot_id=? WHERE id=?",qty,lotId,id);
   audit(user.id,'SUPPLY_RECEIVED_INSPECTED',id,{received_kg:qty,received_lot_id:lotId,grade,safety,eligible:qualityCheck({grade,crop:q.crop,safety},original)});
   return {status:'received',lot_id:lotId,eligible:qualityCheck({grade,crop:q.crop,safety},original)};
  }));
 }
 if(path==='/api/original/allocate'&&method==='POST'){
  manager(user);const b=await bodyJson(req);
  return reply(res,201,transaction(()=>{
   const original=row('orders',str(b.order_id,40)),lot=row('lots',str(b.lot_id,40)),qty=finiteKg(b.quantity_kg);
   ensure(original.is_original===1,'Only original orders supported.');ensure(qualityCheck(lot,original),'Crop, grade or safety does not meet original order requirements.',409);
   ensure(qty<=freeQuantity(lot,sql('SELECT * FROM offers'),originalActive())+.0001,'This stock is already reserved or insufficient.',409);
   const used=active().filter(a=>a.order_id===original.id).reduce((s,x)=>s+x.quantity_kg,0);
   ensure(qty+used<=original.quantity_kg+.0001,'Original order capacity exceeded.',409);
   const id=nextId('allocation','ALC');run('INSERT INTO original_allocations(id,order_id,lot_id,quantity_kg,status,created_at) VALUES(?,?,?,?,?,?)',id,original.id,lot.id,qty,'reserved',now());
   audit(user.id,'ORIGINAL_STOCK_ALLOCATED',id,{order:original.id,lot:lot.id,quantity_kg:qty});return {id};
  }));
 }
 if(path==='/api/original/auto-allocate'&&method==='POST'){
  manager(user);const b=await bodyJson(req);return reply(res,200,transaction(()=>{
   const original=row('orders',str(b.order_id,40));ensure(original.is_original===1,'Original buyer order required.');
   let needed=original.quantity_kg-active().filter(x=>x.order_id===original.id).reduce((s,x)=>s+x.quantity_kg,0);
   const created=[];
   for(const lot of sql('SELECT * FROM lots ORDER BY id')){
    if(needed<=.0001)break;if(!qualityCheck(lot,original))continue;
    const left=freeQuantity(lot,sql('SELECT * FROM offers'),originalActive());const take=Math.round(Math.min(left,needed)*1000)/1000;
    if(take<=0)continue;
    const id=nextId('allocation','ALC');run('INSERT INTO original_allocations(id,order_id,lot_id,quantity_kg,status,created_at) VALUES(?,?,?,?,?,?)',id,original.id,lot.id,take,'reserved',now());
    created.push({id,lot_id:lot.id,quantity_kg:take});needed=Math.max(0,Math.round((needed-take)*1000)/1000);
   }
   audit(user.id,'ORIGINAL_AUTO_ALLOCATION',original.id,{created,remaining_to_allocate_kg:needed});return {created,remaining_to_allocate_kg:needed,fulfillment_status:needed>0?'partially_allocated':'fully_allocated_dispatch_pending'};
  }));
 }
 let allocm=path.match(/^\/api\/original\/allocations\/(ALC-\d+)\/(cancel|dispatch)$/);
 if(allocm&&method==='POST'){
  manager(user);return reply(res,200,transaction(()=>{const a=row('original_allocations',allocm[1]);if(allocm[2]==='cancel'){
   ensure(a.status==='reserved','Only reserved allocations can be released.',409);run("UPDATE original_allocations SET status='cancelled' WHERE id=?",a.id);audit(user.id,'ORIGINAL_ALLOCATION_CANCELLED',a.id,{});
  }else{ensure(a.status==='reserved','Only reserved allocations can be marked dispatched.',409);run("UPDATE original_allocations SET status='dispatched' WHERE id=?",a.id);audit(user.id,'ORIGINAL_DISPATCH_RECORDED',a.id,{note:'Dispatched, not buyer-accepted or paid.'});}return {ok:true};}));
 }
 if(path==='/api/recovery/comparison'&&method==='GET'){
  manager(user);const lot=row('lots',str(url.searchParams.get('lot_id'),40));const result=sql('SELECT * FROM orders WHERE is_original=0').map(o=>{
   const max=maxOffer(lot,o,active());return {...o,max_kg:max,economics:max>0?netRecovery(max,o.price_paise,o.transport_paise,o.handling_paise):null};
  }).sort((a,b)=>(b.economics?.net_paise??-1e15)-(a.economics?.net_paise??-1e15));return reply(res,200,{offers:result});
 }
 if(path==='/api/lots/passport'&&method==='GET'){
  manager(user);const lot=row('lots',str(url.searchParams.get('lot_id'),40));const linked=sql('SELECT * FROM offers WHERE lot_id=?',lot.id);const original=sql('SELECT * FROM original_allocations WHERE lot_id=?',lot.id);const source=one('SELECT * FROM supplier_quotes WHERE received_lot_id=?',lot.id);
  return reply(res,200,{lot,source,offers:linked,allocations:original,available_kg:freeQuantity(lot,linked,original),statement:'Internal FPO inspection record. Not a third-party safety certificate.'});
 }
 if(path==='/api/cases'&&method==='POST'){
  manager(user);const b=await bodyJson(req);const lot=row('lots',str(b.lot_id,30));const original=row('orders',str(b.original_order_id,30));ensure(original.is_original===1,'Select an original buyer order.');return reply(res,201,transaction(()=>{const id=nextId('case','CASE');run('INSERT INTO cases VALUES(?,?,?,?)',id,lot.id,original.id,now());audit(user.id,'CASE_CREATED',id,{lot:lot.id,order:original.id});return {id};}));
 }
 if(path==='/api/offers'&&method==='POST'){
  manager(user);const b=await bodyJson(req);const quantity=finiteKg(b.quantity_kg);const c=row('cases',str(b.case_id,30)),lot=row('lots',c.lot_id),order=row('orders',str(b.order_id,30));ensure(order.is_original===0,'Pick an alternative recovery buyer.');
  return reply(res,201,transaction(()=>{ensure(quantity<=maxOffer(lot,order,active()),'Offer exceeds available compatible stock or buyer demand.',409);const id=nextId('offer','OFF');run('INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?)',id,c.id,lot.id,order.id,quantity,order.price_paise,'offered',0,now());audit(user.id,'OFFER_SENT',id,{order:order.id,quantity});return {id};}));
 }
 m=path.match(/^\/api\/offers\/(OFF-\d+)\/(accept|demo-accept|reserve|cancel)$/);
 if(m&&method==='POST'){
  requireUser(user);const o=row('offers',m[1]);const action=m[2];return reply(res,200,transaction(()=>{
   if(action==='accept'||action==='demo-accept'){
    if(action==='accept'){ensure(user.role==='buyer','Buyer account required.',403);const order=row('orders',o.order_id);ensure(order.buyer_id===user.buyer_id,'Not your offer.',403);}else manager(user);
    ensure(o.status==='offered','This offer is no longer pending.',409);run('UPDATE offers SET status=?,buyer_accepted_demo=? WHERE id=?','accepted',action==='demo-accept'?1:0,o.id);audit(user.id,action==='accept'?'BUYER_ACCEPTED_OFFER':'DEMO_BUYER_ACCEPTED',o.id,{});
   }else if(action==='reserve'){
    manager(user);ensure(o.status==='accepted','Buyer acceptance is required before reservation.',409);const lot=row('lots',o.lot_id),order=row('orders',o.order_id);ensure(order.price_paise===o.agreed_price_paise,'Buyer rate changed. Cancel this offer and obtain acceptance for a new one.',409);ensure(o.quantity_kg<=maxOffer(lot,order,active())+0.0001,'Not enough eligible inventory or buyer demand. Reservation denied.',409);
    run("UPDATE offers SET status='reserved' WHERE id=?",o.id);audit(user.id,'STOCK_RESERVED',o.id,{quantity:o.quantity_kg});
   }else{manager(user);ensure(['offered','accepted','reserved'].includes(o.status),'Delivered offers cannot be cancelled.',409);run("UPDATE offers SET status='cancelled' WHERE id=?",o.id);audit(user.id,'OFFER_CANCELLED',o.id,{});}
   return {ok:true};}));
 }
 if(path==='/api/deliveries'&&method==='POST'){
  manager(user);const b=await bodyJson(req);return reply(res,201,transaction(()=>{const offer=row('offers',str(b.offer_id,30));ensure(offer.status==='reserved','Reserve the offer first.',409);ensure(!one('SELECT id FROM deliveries WHERE offer_id=?',offer.id),'Delivery exists.',409);
   const delivered=finiteKg(b.delivered_kg),accepted=finiteKg(b.accepted_kg,{allowZero:true}),rejected=finiteKg(b.rejected_kg,{allowZero:true});ensure(Math.abs(delivered-offer.quantity_kg)<0.0001,'For this MVP, the whole reserved quantity must be delivered.',409);ensure(Math.abs(accepted+rejected-delivered)<0.0001,'Accepted plus rejected must equal delivered quantity.');
   const id=nextId('delivery','DLV');run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)',id,offer.id,delivered,accepted,rejected,String(b.inspection_note||'').slice(0,1000),now());run("UPDATE offers SET status='delivered' WHERE id=?",offer.id);audit(user.id,'DELIVERY_INSPECTED',id,{delivered,accepted,rejected});return {id};}));
 }
 if(path==='/api/evidence'&&method==='POST'){
  manager(user);const b=await bodyJson(req);row('deliveries',str(b.delivery_id,30));const kind=str(b.kind,20);ensure(['inspection','buyer'].includes(kind),'Choose an evidence type.');const mime=str(b.mime,80);ensure(['text/plain','application/pdf','image/jpeg','image/png','image/webp'].includes(mime),'Only TXT, PDF, JPEG, PNG and WebP are supported.');
  const fileName=str(b.file_name,160).replace(/[^\w.()\- ]/g,'_');const raw=Buffer.from(String(b.base64||''),'base64');ensure(raw.length>0&&raw.length<=5*1024*1024,'Choose a file under 5 MB.');
  if(mime==='application/pdf')ensure(raw.subarray(0,4).toString()==='%PDF','Invalid PDF file.');
  if(mime==='image/png')ensure(raw.subarray(1,4).toString()==='PNG','Invalid PNG file.');
  const diskName=randomUUID()+'.bin';await writeFile(join(storageDir,diskName),raw,{flag:'wx'});
  return reply(res,201,transaction(()=>{const id=nextId('evidence','EVD');run('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?)',id,b.delivery_id,kind,fileName,mime,diskName,null,null,'pending',now());audit(user.id,'EVIDENCE_UPLOADED',id,{kind,fileName});return {id};}));
 }
 m=path.match(/^\/api\/evidence\/(EVD-\d+)\/(extract|verify|correct|file)$/);
 if(m){manager(user);const evidence=row('evidence',m[1]);if(m[2]==='extract'&&method==='POST'){
   const output=await extractEvidence(evidence);transaction(()=>{run('UPDATE evidence SET proposed_json=?,engine=? WHERE id=?',JSON.stringify(output.fields),output.engine,evidence.id);audit(user.id,'EXTRACTION_PROPOSED',evidence.id,{engine:output.engine});});return reply(res,200,output);
  }
  if(m[2]==='verify'&&method==='POST'){
   const b=await bodyJson(req);const accepted=finiteKg(b.accepted_kg,{allowZero:true});const d=row('deliveries',evidence.delivery_id);ensure(accepted<=d.delivered_kg,'Accepted quantity cannot exceed delivered.');const verified={accepted_kg:accepted,delivered_kg:b.delivered_kg==null?null:finiteKg(b.delivered_kg,{allowZero:true}),rejected_kg:b.rejected_kg==null?null:finiteKg(b.rejected_kg,{allowZero:true}),rate_inr:b.rate_inr==null?null:Number(b.rate_inr),deductions_inr:b.deductions_inr==null?0:Number(b.deductions_inr),lot_ref:String(b.lot_ref||'').slice(0,50),source_reference:String(b.source_reference||'').slice(0,220)};
   ensure(Number.isFinite(verified.deductions_inr)&&verified.deductions_inr>=0&&verified.deductions_inr<=1000000,'Invalid deduction.');
   return reply(res,200,transaction(()=>{
    const current=row('evidence',evidence.id);
    ensure(!current.verified_json,'Evidence is already verified. Use Correct with a reason.',409);
    ensure(!latestEvidenceVersion(current.id),'Evidence is already verified. Use Correct with a reason.',409);
    const version=insertEvidenceVersion(current,verified,user.id);
    run('UPDATE evidence SET verified_json=? WHERE id=?',JSON.stringify(verified),current.id);
    audit(user.id,'EVIDENCE_VERIFIED',current.id,{accepted,kind:current.kind,version_number:version.version_number});
    return {ok:true};
   }));
  }
  if(m[2]==='correct'&&method==='POST'){
   const b=await bodyJson(req);const reason=validate(()=>correctionReason(b.reason));
   const result=transaction(()=>{
    const current=row('evidence',evidence.id);
    ensure(current.verified_json,'Verify evidence before correcting it.',409);
    const latest=latestEvidenceVersion(current.id);
    ensure(latest&&latest.verified_json===current.verified_json,'Verified evidence history is out of sync. Refresh before correcting.',409);
    ensure(b.expected_verified_json===current.verified_json,'Evidence changed since this form opened. Refresh and review the latest values.',409);
    const delivery=row('deliveries',current.delivery_id);
    const quantities=validate(()=>evidenceQuantities(b,delivery.delivered_kg));
    const corrected={accepted_kg:quantities.accepted_kg,delivered_kg:quantities.delivered_kg,rejected_kg:b.rejected_kg==null?null:validate(()=>finiteKg(b.rejected_kg,{allowZero:true})),rate_inr:b.rate_inr==null?null:Number(b.rate_inr),deductions_inr:b.deductions_inr==null?0:Number(b.deductions_inr),lot_ref:String(b.lot_ref||'').slice(0,50),source_reference:String(b.source_reference||'').slice(0,220)};
    ensure(corrected.rate_inr==null||Number.isFinite(corrected.rate_inr)&&corrected.rate_inr>=0&&corrected.rate_inr<=1000000,'Invalid document rate.');
    ensure(Number.isFinite(corrected.deductions_inr)&&corrected.deductions_inr>=0&&corrected.deductions_inr<=1000000,'Invalid deduction.');
    const previous=JSON.parse(current.verified_json);
    ensure(JSON.stringify(corrected)!==JSON.stringify(previous),'No evidence values changed.',409);
    const version=insertEvidenceVersion(current,corrected,user.id,reason);
    run('UPDATE evidence SET verified_json=? WHERE id=?',JSON.stringify(corrected),current.id);
    audit(user.id,'EVIDENCE_CORRECTED',current.id,{kind:current.kind,version_number:version.version_number,old_kg:previous.accepted_kg,new_kg:corrected.accepted_kg,reason,previous,corrected});
    return {ok:true};
   });
   return reply(res,200,result);
  }
  if(m[2]==='file'&&method==='GET'){
   const data=await readFile(join(storageDir,evidence.file_path));res.writeHead(200,{'Content-Type':evidence.mime,'Content-Disposition':`inline; filename="${evidence.file_name.replace(/["\\]/g,'')}"`,'X-Content-Type-Options':'nosniff','Cache-Control':'private,no-store','Content-Security-Policy':'sandbox'});res.end(data);return;
  }
 }
 if(path==='/api/reviews'&&method==='POST'){
  manager(user);const b=await bodyJson(req);const delivery=row('deliveries',str(b.delivery_id,30));const decision=str(b.decision,30);ensure(['inspection_basis','buyer_basis','more_evidence'].includes(decision),'Invalid review decision.');const note=str(b.note,1000);const d=breakdown(delivery);if(decision==='buyer_basis')ensure(d.reconciliation.buyer_kg!=null,'Verify a buyer statement first.');
  return reply(res,201,transaction(()=>{const id=nextId('review','REV');run('INSERT INTO reviews VALUES(?,?,?,?,?,?)',id,delivery.id,decision,note,user.id,now());audit(user.id,'REVIEW_RECORDED',id,{delivery:delivery.id,decision,note});return {id,status:'reviewed_unpaid'};}));
 }
 return serveStatic(res,path);
 }catch(e){const status=e.status||500;if(status>=500)console.error('[Agrova]',e);return reply(res,status,{error:status>=500 && !String(e.message).startsWith('Gemini')?'Unexpected server error.':e.message});}
 });
}
async function serveStatic(res,path){if(path.startsWith('/api/'))return reply(res,404,{error:'Endpoint not found.'});const file=path==='/'?'/index.html':path;const absolute=resolve(publicDir,'.'+file);if(!absolute.startsWith(publicDir + (process.platform === 'win32' ? '\\' : '/'))&&!['/index.html', '/'].includes(file))return reply(res,403,{error:'Forbidden'});
 const dest=existsSync(absolute)?absolute:resolve(publicDir,'index.html');const ext=extname(dest);const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[ext]||'application/octet-stream';res.writeHead(200,{'Content-Type':mime,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});res.end(await readFile(dest));}
const port=Number(process.env.PORT||3000);
http.createServer((req,res)=>{handle(req,res).catch(err=>{console.error(err);if(!res.headersSent)reply(res,500,{error:'Server error.'});else res.end()});}).listen(port,'0.0.0.0',()=>console.log(`Agrova V3 at http://localhost:${port}`));
