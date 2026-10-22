/** Agrova pilot B2B market. Additive schema only. No real money movements. */
import {randomUUID,randomInt,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {db,one,sql,run,transaction,audit,hashPassword} from './db.mjs';
import {validEmail,validPassword} from './auth.mjs';
import {sampleInvoicePdf} from './market_pdf.mjs';
const now=()=>new Date().toISOString();
const uid=()=>randomUUID();
const err=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const check=(condition,message,status=400)=>{if(!condition)err(message,status)};
const text=(value,max=140)=>{check(typeof value==='string'&&value.trim().length>0&&value.trim().length<=max,'Valid text required');return value.trim()};
const kg=value=>{const n=Number(value);check(Number.isFinite(n)&&n>0&&n<=1000000&&Math.round(n*1000)===n*1000,'Quantity must be positive (up to 3 decimals)');return n};
const paisa=value=>{const n=Number(value);check(Number.isSafeInteger(n)&&n>=0&&n<=1e11,'Invalid nonnegative amount');return n};
const numberOrNull=value=>{if(value===null||value===undefined||value==='')return null;const n=Number(value);check(Number.isFinite(n)&&n>=0&&n<=50000,'Invalid distance');return n};
const sha=v=>createHash('sha256').update(v).digest('hex');
const json=v=>JSON.stringify(v);
const find=(table,id)=>{const found=one(`SELECT * FROM ${table} WHERE id=?`,id);check(found,'Record not found',404);return found};
const access=user=>check(user,'Sign in first',401);
const isAdmin=user=>user?.role==='manager';
function member(user){access(user);return one('SELECT * FROM market_members WHERE user_id=?',user.id)}
function role(user,...roles){const m=member(user);check(m&&roles.includes(m.role),`Required role: ${roles.join(', ')}`,403);return m}
function admin(user){access(user);check(isAdmin(user),'Admin access required',403)}
function canFpo(user,id){if(isAdmin(user))return;const m=role(user,'fpo');check(m.fpo_id===id,'FPO data access denied',403)}
function ownsOrder(user,order){access(user);if(isAdmin(user))return;const m=member(user);check(m&&((m.role==='buyer'&&m.user_id===order.buyer_user_id)||(m.role==='fpo'&&m.fpo_id===order.fpo_id)),'Order access denied',403)}
function buyer(user){return role(user,'buyer')}
const order=id=>find('market_orders',id);
function safeMoney(qty,price,transport){const total=Math.round(qty*price)+transport;check(Number.isSafeInteger(total),'Order cost too large');return total}
function initialSchema(){db.exec(`
 CREATE TABLE IF NOT EXISTS market_fpos(id TEXT PRIMARY KEY,name TEXT NOT NULL,location TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS market_members(user_id TEXT PRIMARY KEY REFERENCES users(id),role TEXT NOT NULL CHECK(role IN ('farmer','fpo','buyer')),fpo_id TEXT REFERENCES market_fpos(id),created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_market_members_fpo ON market_members(fpo_id);
 CREATE TABLE IF NOT EXISTS market_farmers(id TEXT PRIMARY KEY,owner_user_id TEXT UNIQUE NOT NULL REFERENCES users(id),fpo_id TEXT NOT NULL REFERENCES market_fpos(id),name TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS market_listings(id TEXT PRIMARY KEY,fpo_id TEXT NOT NULL REFERENCES market_fpos(id),farmer_name TEXT NOT NULL,crop TEXT NOT NULL,grade TEXT NOT NULL,stock_kg REAL NOT NULL CHECK(stock_kg>=0),price_paise INTEGER NOT NULL CHECK(price_paise>=0),estimated_distance_km REAL,transport_paise INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_market_listings_crop ON market_listings(crop,grade);
 CREATE TABLE IF NOT EXISTS market_orders(id TEXT PRIMARY KEY,buyer_user_id TEXT NOT NULL REFERENCES users(id),listing_id TEXT NOT NULL REFERENCES market_listings(id),fpo_id TEXT NOT NULL REFERENCES market_fpos(id),quantity_kg REAL NOT NULL CHECK(quantity_kg>0),total_paise INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_market_orders_fpo ON market_orders(fpo_id);
 CREATE TABLE IF NOT EXISTS market_payments(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES market_orders(id),status TEXT NOT NULL,attempt_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS market_invoices(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES market_orders(id),fpo_id TEXT NOT NULL REFERENCES market_fpos(id),invoice_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS market_deliveries(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES market_orders(id),otp_hash TEXT NOT NULL,proof_mime TEXT,proof_data TEXT,delivered_at TEXT,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS market_ratings(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES market_orders(id),buyer_user_id TEXT NOT NULL REFERENCES users(id),fpo_id TEXT NOT NULL REFERENCES market_fpos(id),stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),comment TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_market_ratings_fpo ON market_ratings(fpo_id);
 CREATE TABLE IF NOT EXISTS market_payment_events(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES market_orders(id),previous_status TEXT NOT NULL,new_status TEXT NOT NULL,scenario TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS market_delivery_events(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES market_orders(id),event_type TEXT NOT NULL,notes TEXT,created_at TEXT NOT NULL);
 `);
 // Schema upgrades from previous Stage 2 are additive; legacy records remain in place.
 const cols=sql('PRAGMA table_info(market_listings)').map(r=>r.name);
 if(!cols.includes('created_by'))db.exec('ALTER TABLE market_listings ADD COLUMN created_by TEXT');
 const paymentCols=sql('PRAGMA table_info(market_payments)').map(r=>r.name);
 if(!paymentCols.includes('stock_released'))db.exec('ALTER TABLE market_payments ADD COLUMN stock_released INTEGER NOT NULL DEFAULT 0');
 const orderCols=sql('PRAGMA table_info(market_orders)').map(r=>r.name);
 if(!orderCols.includes('price_paise_snapshot'))db.exec('ALTER TABLE market_orders ADD COLUMN price_paise_snapshot INTEGER');
 if(!orderCols.includes('transport_paise_snapshot'))db.exec('ALTER TABLE market_orders ADD COLUMN transport_paise_snapshot INTEGER');
 const deliveryCols=sql('PRAGMA table_info(market_deliveries)').map(r=>r.name);
 if(!deliveryCols.includes('otp_expires_at'))db.exec('ALTER TABLE market_deliveries ADD COLUMN otp_expires_at INTEGER');
 if(!deliveryCols.includes('attempts'))db.exec('ALTER TABLE market_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
 if(!deliveryCols.includes('otp_salt'))db.exec('ALTER TABLE market_deliveries ADD COLUMN otp_salt TEXT');
 }
initialSchema();
function listingInput(b){
 const crop=text(b.crop),grade=text(b.grade,3).toUpperCase();check(['A','B','C'].includes(grade),'Grade must be A/B/C');
 const stock=kg(b.stock_kg),price=paisa(b.price_paise),transport=paisa(b.transport_paise??0),distance=numberOrNull(b.estimated_distance_km);
 return {crop,grade,stock,price,transport,distance};
}
function buyerOrders(user){if(isAdmin(user))return sql('SELECT * FROM market_orders ORDER BY created_at DESC');const m=member(user);check(m,'Marketplace profile required',403);if(m.role==='fpo')return sql('SELECT * FROM market_orders WHERE fpo_id=? ORDER BY created_at DESC',m.fpo_id);if(m.role==='buyer')return sql('SELECT * FROM market_orders WHERE buyer_user_id=? ORDER BY created_at DESC',user.id);return []}
function withRating(items){return items.map(l=>{const rating=one('SELECT ROUND(AVG(stars),2) AS avg, COUNT(*) AS count FROM market_ratings WHERE fpo_id=?',l.fpo_id);return {...l,review_count:rating.count,average_rating:rating.avg}})}
function ranks(items,quantity){const matched=withRating(items.map(l=>({...l,landed_cost_paise:safeMoney(quantity,l.price_paise,l.transport_paise),distance_source:'user_entered_estimate',estimated_transport:true})));
 const cheapest=[...matched].sort((a,b)=>a.landed_cost_paise-b.landed_cost_paise);
 const nearest=[...matched].filter(x=>x.estimated_distance_km!=null).sort((a,b)=>a.estimated_distance_km-b.estimated_distance_km);
 const rated=[...matched].filter(x=>x.review_count>=3).sort((a,b)=>b.average_rating-a.average_rating||a.landed_cost_paise-b.landed_cost_paise);
 // Explicit MVP value heuristic: adjusted landed cost with up to 10% review-based discount; unreviewed listings are not penalized.
 const value=[...matched].sort((a,b)=>((a.landed_cost_paise*(a.review_count>=3?(1-0.025*(a.average_rating-1)):1))- (b.landed_cost_paise*(b.review_count>=3?(1-0.025*(b.average_rating-1)):1))));
 return {matches:cheapest,recommendations:{cheapest_delivered:cheapest[0]?.id??null,best_value:value[0]?.id??null,nearest:nearest[0]?.id??null,highest_rated:rated[0]?.id??null},explanation:{best_value:'Heuristic discounts delivered cost by up to 10% for FPOs with >=3 verified reviews; unreviewed suppliers not penalized',road_distance:'Distances are entered estimates, not live road routes'}}
}
function setPayment(user,o,p,newStatus,scenario){
 const previous=p.status;
 if(previous===newStatus)return {status:newStatus,idempotent:true};
 check(previous!=='verified','Verified payments cannot be reversed via demo callbacks',409);
 check(previous!=='failed','Failed attempts are final; create a fresh order',409);
 if(scenario.startsWith('reconcile_'))check(previous==='uncertain','Only uncertain payments can be reconciled',409);
 else check(previous==='pending','Payment already processed or uncertain; reconcile it',409);
 run('UPDATE market_payments SET status=?,updated_at=? WHERE id=?',newStatus,now(),p.id);
 let status={verified:'paid',failed:'payment_failed',uncertain:'payment_uncertain'}[newStatus];
 run('UPDATE market_orders SET status=? WHERE id=?',status,o.id);
 if(newStatus==='failed'&&!p.stock_released){run('UPDATE market_listings SET stock_kg=stock_kg+? WHERE id=?',o.quantity_kg,o.listing_id);run('UPDATE market_payments SET stock_released=1 WHERE id=?',p.id)}
 if(newStatus==='verified'){
  const l=find('market_listings',o.listing_id),f=find('market_fpos',o.fpo_id),b=one('SELECT display_name,username FROM users WHERE id=?',o.buyer_user_id);
  const issuedAt=now();const invoice={invoice_number:'DEMO-'+o.id,order_id:o.id,fpo_id:o.fpo_id,seller:f.name,buyer:b?.display_name||'Buyer',buyer_email:b?.username||'',crop:l.crop,grade:l.grade,quantity_kg:o.quantity_kg,unit_price_paise:o.price_paise_snapshot??l.price_paise,transport_paise:o.transport_paise_snapshot??l.transport_paise,total_paise:o.total_paise,issued_at:issuedAt,document_type:'SAMPLE / DEMO — NOT A TAX INVOICE',tax_note:'Tax not calculated. Determine applicability before production.'};
  run('INSERT OR IGNORE INTO market_invoices(id,order_id,fpo_id,invoice_json,created_at) VALUES(?,?,?,?,?)',uid(),o.id,o.fpo_id,json(invoice),issuedAt);
 }
 run('INSERT INTO market_payment_events VALUES(?,?,?,?,?,?)',uid(),o.id,previous,newStatus,scenario,now());
 audit(user.id,'DEMO_PAYMENT',o.id,{previous,newStatus,scenario});return {status:newStatus,idempotent:false};
}
function proofBuffer(b){const mime=text(b.photo_mime,40);check(['image/png','image/jpeg','image/webp'].includes(mime),'JPEG, PNG or WebP delivery photo required');const encoded=text(b.photo_base64,550000);check(encoded.length%4===0&&/^[A-Za-z0-9+/]+={0,2}$/.test(encoded),'Invalid base64 photo');const bytes=Buffer.from(encoded,'base64');check(bytes.length>=12&&bytes.length<=350000,'Delivery photo must be 12 bytes to 350 KB');const magic=mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';check(magic,'Image bytes do not match MIME type');return {mime,encoded};}
function marketRoute(path,method,user,b={}){
 if(path==='/api/market/fpos'&&method==='GET'){access(user);return {status:200,data:{fpos:sql('SELECT * FROM market_fpos ORDER BY name')}}}
 if(path==='/api/market/fpos'&&method==='POST'){admin(user);const name=text(b.name),location=text(b.location);const fpoId=uid();transaction(()=>{run('INSERT INTO market_fpos VALUES(?,?,?,?)',fpoId,name,location,now());audit(user.id,'FPO_CREATED',fpoId,{name})});return {status:201,data:{id:fpoId}}}
 if(path==='/api/market/members'&&method==='POST'){
  admin(user);const email=validEmail(b.email),display=text(b.display_name),password=b.password;validPassword(password);const marketRole=text(b.role,12);check(['farmer','fpo','buyer'].includes(marketRole),'Invalid marketplace role');const fpoId=marketRole==='buyer'?null:text(b.fpo_id,64);if(fpoId)find('market_fpos',fpoId);check(!one('SELECT id FROM users WHERE username=?',email),'Email already exists',409);
  const userId=uid();transaction(()=>{run('INSERT INTO users(id,username,password_hash,display_name,role,buyer_id) VALUES(?,?,?,?,?,?)',userId,email,hashPassword(password),display,'buyer',marketRole==='buyer'?userId:null);run('INSERT INTO market_members VALUES(?,?,?,?)',userId,marketRole,fpoId,now());if(marketRole==='farmer')run('INSERT INTO market_farmers VALUES(?,?,?,?,?)',uid(),userId,fpoId,display,now());audit(user.id,'MARKET_MEMBER_CREATED',userId,{marketRole,fpoId})});return {status:201,data:{user_id:userId,market_role:marketRole}};
 }
 if(path==='/api/market/me'&&method==='GET'){access(user);return {status:200,data:{account:{id:user.id,display_name:user.display_name},market_profile:member(user),admin:isAdmin(user)}}}
 if(path==='/api/market/farmers'&&method==='GET'){access(user);const m=member(user);if(isAdmin(user))return {status:200,data:{farmers:sql('SELECT id,fpo_id,name,created_at FROM market_farmers ORDER BY created_at DESC')}};check(m&&m.fpo_id&&['fpo','farmer'].includes(m.role),'FPO or farmer access required',403);return {status:200,data:{farmers:sql('SELECT id,fpo_id,name,created_at FROM market_farmers WHERE fpo_id=?',m.fpo_id)}}}
 if(path==='/api/market/listings'&&method==='POST'){
  access(user);const m=member(user);check(isAdmin(user)||m&&['fpo','farmer'].includes(m.role),'Farmer/FPO access required',403);const fpoId=isAdmin(user)?text(b.fpo_id,64):m.fpo_id;if(!isAdmin(user)&&b.fpo_id!==undefined)check(b.fpo_id===fpoId,'FPO access denied',403);find('market_fpos',fpoId);const {crop,grade,stock,price,transport,distance}=listingInput(b);const farmerName=m?.role==='farmer'?user.display_name:text(b.farmer_name);const listingId=uid();transaction(()=>{run('INSERT INTO market_listings(id,fpo_id,farmer_name,crop,grade,stock_kg,price_paise,estimated_distance_km,transport_paise,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',listingId,fpoId,farmerName,crop,grade,stock,price,distance,transport,now(),user.id);audit(user.id,'MARKET_LISTING_CREATED',listingId,{fpoId,stock})});return {status:201,data:{id:listingId}};
 }
 if(path==='/api/market/listings'&&method==='GET'){access(user);const m=member(user);check(isAdmin(user)||m,'Marketplace profile required',403);if(isAdmin(user))return {status:200,data:{listings:sql('SELECT * FROM market_listings ORDER BY created_at DESC')}};if(m.role==='fpo')return {status:200,data:{listings:sql('SELECT * FROM market_listings WHERE fpo_id=? ORDER BY created_at DESC',m.fpo_id)}};if(m.role==='farmer')return {status:200,data:{listings:sql('SELECT * FROM market_listings WHERE created_by=? ORDER BY created_at DESC',user.id)}};return {status:200,data:{listings:sql('SELECT id,fpo_id,crop,grade,stock_kg,price_paise,estimated_distance_km,transport_paise FROM market_listings WHERE stock_kg>0')}};
 }
 let m=path.match(/^\/api\/market\/listings\/([\w-]+)$/);
 if(m&&method==='PATCH'){access(user);const l=find('market_listings',m[1]);const profile=member(user);check(isAdmin(user)||(profile?.role==='fpo'&&profile.fpo_id===l.fpo_id)||(profile?.role==='farmer'&&l.created_by===user.id),'Listing access denied',403);const stock=Number(b.stock_kg),price=paisa(b.price_paise);check(Number.isFinite(stock)&&stock>=0&&Math.round(stock*1000)===stock*1000,'Invalid available quantity');transaction(()=>{run('UPDATE market_listings SET stock_kg=?,price_paise=? WHERE id=?',stock,price,l.id);audit(user.id,'MARKET_LISTING_UPDATED',l.id,{stock,price})});return {status:200,data:{ok:true}}}
 if(path==='/api/market/matches'&&method==='GET'){access(user);const qty=kg(b.quantity_kg),crop=text(b.crop),grade=text(b.grade,3).toUpperCase();check(['A','B','C'].includes(grade),'Invalid grade');const items=sql('SELECT l.*,f.name fpo_name,f.location FROM market_listings l JOIN market_fpos f ON f.id=l.fpo_id WHERE lower(l.crop)=lower(?) AND l.grade=? AND l.stock_kg>=?',crop,grade,qty);return {status:200,data:ranks(items,qty)}}
 if(path==='/api/market/orders'&&method==='POST'){
  buyer(user);const key=text(b.idempotency_key,128),listingId=text(b.listing_id,64),quantity=kg(b.quantity_kg);const result=transaction(()=>{const prior=one('SELECT p.order_id,o.buyer_user_id,o.listing_id,o.quantity_kg FROM market_payments p JOIN market_orders o ON o.id=p.order_id WHERE p.attempt_key=?',key);if(prior){check(prior.buyer_user_id===user.id&&prior.listing_id===listingId&&prior.quantity_kg===quantity,'Idempotency key reused with different order',409);return {id:prior.order_id,duplicate:true}}const l=find('market_listings',listingId);check(l.stock_kg>=quantity,'Not enough available stock',409);const stock=run('UPDATE market_listings SET stock_kg=stock_kg-? WHERE id=? AND stock_kg>=?',quantity,listingId,quantity);check(stock.changes===1,'Stock changed. Retry',409);const orderId=uid(),t=now(),amount=safeMoney(quantity,l.price_paise,l.transport_paise);run('INSERT INTO market_orders(id,buyer_user_id,listing_id,fpo_id,quantity_kg,total_paise,status,created_at,price_paise_snapshot,transport_paise_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)',orderId,user.id,listingId,l.fpo_id,quantity,amount,'payment_pending',t,l.price_paise,l.transport_paise);run('INSERT INTO market_payments(id,order_id,status,attempt_key,created_at,updated_at,stock_released) VALUES(?,?,?,?,?,?,0)',uid(),orderId,'pending',key,t,t);audit(user.id,'MARKET_ORDER_CREATED',orderId,{quantity,amount});return {id:orderId,duplicate:false}});return {status:result.duplicate?200:201,data:{order_id:result.id,idempotent:result.duplicate}};
 }
 if(path==='/api/market/orders'&&method==='GET')return {status:200,data:{orders:buyerOrders(user)}};
 m=path.match(/^\/api\/market\/orders\/([\w-]+)\/payment$/);
 if(m&&method==='POST'){buyer(user);check(process.env.NODE_ENV!=='production','Demo payment simulator is disabled in production',403);const scenario=text(b.scenario,30);check(['success','failure','uncertain','reconcile_success','reconcile_failure'].includes(scenario),'Unsupported demo scenario');const result=transaction(()=>{const o=order(m[1]);check(o.buyer_user_id===user.id,'Buyer access denied',403);const p=find('market_payments',one('SELECT id FROM market_payments WHERE order_id=?',o.id)?.id);const status={success:'verified',failure:'failed',uncertain:'uncertain',reconcile_success:'verified',reconcile_failure:'failed'}[scenario];return setPayment(user,o,p,status,scenario)});return {status:200,data:{...result,demo:true}}}
 m=path.match(/^\/api\/market\/orders\/([\w-]+)\/invoice(\.pdf)?$/);
 if(m&&method==='GET'){const o=order(m[1]);ownsOrder(user,o);const inv=one('SELECT * FROM market_invoices WHERE order_id=?',o.id);check(inv,'No invoice for this order',404);if(!isAdmin(user)&&member(user)?.role==='fpo')canFpo(user,inv.fpo_id);const doc=JSON.parse(inv.invoice_json);if(m[2])return {status:200,body:sampleInvoicePdf(doc),headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${doc.invoice_number}.pdf"`}};return {status:200,data:{invoice_id:inv.id,...doc}}}
 if(path==='/api/market/invoices'&&method==='GET'){access(user);const m=member(user);check(isAdmin(user)||m&&['buyer','fpo'].includes(m.role),'Invoice access denied',403);const invoices=isAdmin(user)?sql('SELECT id,order_id,fpo_id,created_at FROM market_invoices ORDER BY created_at DESC'):m.role==='fpo'?sql('SELECT id,order_id,fpo_id,created_at FROM market_invoices WHERE fpo_id=? ORDER BY created_at DESC',m.fpo_id):sql('SELECT i.id,i.order_id,i.fpo_id,i.created_at FROM market_invoices i JOIN market_orders o ON o.id=i.order_id WHERE o.buyer_user_id=? ORDER BY i.created_at DESC',user.id);return {status:200,data:{invoices}}}
 m=path.match(/^\/api\/market\/orders\/([\w-]+)\/delivery$/);
 if(m&&method==='POST'){const o=order(m[1]);canFpo(user,o.fpo_id);check(['paid','dispatched'].includes(o.status),'Payment must be verified before dispatch',409);const existing=one('SELECT * FROM market_deliveries WHERE order_id=?',o.id);check(!existing,'Delivery already initiated',409);const otp=String(randomInt(100000,1000000)),salt=randomBytes(16).toString('hex'),expires=Date.now()+30*60*1000;const deliveryId=uid();transaction(()=>{run('INSERT INTO market_deliveries(id,order_id,otp_hash,proof_mime,proof_data,delivered_at,created_at,otp_expires_at,attempts,otp_salt) VALUES(?,?,?,?,?,?,?,?,?,?)',deliveryId,o.id,sha(salt+otp),null,null,null,now(),expires,0,salt);run('UPDATE market_orders SET status=? WHERE id=?','dispatched',o.id);run('INSERT INTO market_delivery_events VALUES(?,?,?,?,?)',uid(),o.id,'dispatched','Awaiting buyer confirmation',now());audit(user.id,'MARKET_DISPATCHED',o.id,{deliveryId})});return {status:201,data:{delivery_id:deliveryId,demo_otp:process.env.NODE_ENV==='production'?undefined:otp,demo:true,expires_minutes:30}}}
 m=path.match(/^\/api\/market\/orders\/([\w-]+)\/confirm-delivery$/);
 if(m&&method==='POST'){buyer(user);const o=order(m[1]);check(o.buyer_user_id===user.id,'Buyer access denied',403);check(o.status==='dispatched','Order not dispatched',409);const otp=text(b.otp,6);check(/^\d{6}$/.test(otp),'Six-digit OTP required');const proof=proofBuffer(b);const d=one('SELECT * FROM market_deliveries WHERE order_id=?',o.id);check(d,'Delivery not created',404);check(d.otp_expires_at&&Date.now()<=d.otp_expires_at,'Delivery OTP expired',409);check(d.attempts<5,'Too many OTP attempts',429);const a=Buffer.from(sha((d.otp_salt||'')+otp),'hex'),expected=Buffer.from(d.otp_hash,'hex');if(!(a.length===expected.length&&timingSafeEqual(a,expected))){run('UPDATE market_deliveries SET attempts=attempts+1 WHERE id=?',d.id);err('Invalid delivery OTP',403)}transaction(()=>{run('UPDATE market_deliveries SET proof_mime=?,proof_data=?,delivered_at=? WHERE id=?',proof.mime,proof.encoded,now(),d.id);run('UPDATE market_orders SET status=? WHERE id=?','delivered',o.id);run('INSERT INTO market_delivery_events VALUES(?,?,?,?,?)',uid(),o.id,'delivered','Buyer OTP and photo confirmed',now());audit(user.id,'MARKET_DELIVERED',o.id,{proof:true})});return {status:200,data:{delivered:true}}}
 m=path.match(/^\/api\/market\/orders\/([\w-]+)\/delivery-status$/);
 if(m&&method==='GET'){const o=order(m[1]);ownsOrder(user,o);const d=one('SELECT id,order_id,proof_mime,delivered_at,created_at FROM market_deliveries WHERE order_id=?',o.id);const events=sql('SELECT event_type,notes,created_at FROM market_delivery_events WHERE order_id=? ORDER BY created_at',o.id);return {status:200,data:{delivery:d,events}}}
 m=path.match(/^\/api\/market\/orders\/([\w-]+)\/rating$/);
 if(m&&method==='POST'){buyer(user);const o=order(m[1]);check(o.buyer_user_id===user.id,'Not your order',403);check(o.status==='delivered','Only delivered orders can be reviewed',409);const stars=Number(b.stars),comment=text(b.comment,500);check(Number.isSafeInteger(stars)&&stars>=1&&stars<=5,'Stars must be 1-5');check(!one('SELECT id FROM market_ratings WHERE order_id=?',o.id),'Order already reviewed',409);const reviewId=uid();transaction(()=>{run('INSERT INTO market_ratings VALUES(?,?,?,?,?,?,?)',reviewId,o.id,user.id,o.fpo_id,stars,comment,now());audit(user.id,'MARKET_RATING_CREATED',reviewId,{order:o.id,stars})});return {status:201,data:{review_id:reviewId}}}
 if(path==='/api/market/ratings'&&method==='GET'){access(user);const stats=sql('SELECT f.id,f.name,COUNT(r.id) review_count,ROUND(AVG(r.stars),2) average_rating FROM market_fpos f LEFT JOIN market_ratings r ON r.fpo_id=f.id GROUP BY f.id ORDER BY CASE WHEN COUNT(r.id)>=3 THEN 0 ELSE 1 END,average_rating DESC');return {status:200,data:{ratings:stats.map(x=>({...x,ranking_eligible:x.review_count>=3,display_rating:x.review_count>=3?x.average_rating:null}))}}}
 if(path==='/api/market/overview'&&method==='GET'){admin(user);return {status:200,data:{fpos:one('SELECT COUNT(*) n FROM market_fpos').n,market_users:one('SELECT COUNT(*) n FROM market_members').n,open_orders:one("SELECT COUNT(*) n FROM market_orders WHERE status!='delivered'").n,invoices:one('SELECT COUNT(*) n FROM market_invoices').n,deliveries:one('SELECT COUNT(*) n FROM market_deliveries WHERE delivered_at IS NOT NULL').n}}}
 return null;
}
export {marketRoute};
