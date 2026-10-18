import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
const dbPath=resolve(process.cwd(),'storage/agrova.sqlite');mkdirSync(dirname(dbPath),{recursive:true});
export const db=new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const scope=new AsyncLocalStorage();
const connected=()=>scope.getStore()||db;
export const sql=(query,...params)=>connected().prepare(query).all(...params);
export const one=(query,...params)=>connected().prepare(query).get(...params);
export const run=(query,...params)=>connected().prepare(query).run(...params);
export function transaction(fn){const conn=connected();conn.exec('BEGIN IMMEDIATE');try{const v=fn();conn.exec('COMMIT');return v;}catch(e){conn.exec('ROLLBACK');throw e;}}
// Optional per-organization database workspace API, retained for existing V3.1 auth tests.
// Existing application routes continue to use the unchanged default database.
const workspaceConnections=new Map();
export function workspaceFor(fpoId){if(!/^[0-9a-f-]{36}$/i.test(String(fpoId)))throw Error('Invalid workspace id');return fpoId.toLowerCase();}
export function withWorkspace(workspace,fn){
 const id=workspaceFor(workspace);let conn=workspaceConnections.get(id);
 if(!conn){const folder=resolve(process.cwd(),'storage/workspaces');mkdirSync(folder,{recursive:true});conn=new DatabaseSync(resolve(folder,id+'.sqlite'));conn.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
 const tables=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
 for(const row of tables)conn.exec(row.sql);
 conn.exec('CREATE TABLE IF NOT EXISTS farmers(id TEXT PRIMARY KEY,name TEXT NOT NULL,phone TEXT,created_at TEXT NOT NULL)');
 workspaceConnections.set(id,conn);}
 return scope.run(conn,fn);
}
export function hashPassword(p){const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex')}
export function comparePassword(pass,store){const [salt,hex]=store.split(':');const got=scryptSync(pass,salt,64);const expected=Buffer.from(hex,'hex');return expected.length===got.length&&timingSafeEqual(got,expected)}
export const tokenHash=t=>createHash('sha256').update(t).digest('hex');
export function nextId(key,prefix){const item=one('SELECT val FROM counters WHERE name=?',key);const num=item?item.val:1;run('INSERT INTO counters(name,val) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET val=excluded.val',key,num+1);return prefix+'-'+String(num).padStart(3,'0')}
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,display_name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('manager','buyer')),buyer_id TEXT);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id));
CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,val INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lots(id TEXT PRIMARY KEY,farmer TEXT NOT NULL,crop TEXT NOT NULL,quantity_kg REAL NOT NULL CHECK(quantity_kg>=0),grade TEXT NOT NULL,safety TEXT NOT NULL CHECK(safety IN ('cleared','hold','pending')),created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,buyer_id TEXT NOT NULL,buyer_name TEXT NOT NULL,crop TEXT NOT NULL,grade TEXT NOT NULL,quantity_kg REAL NOT NULL CHECK(quantity_kg>0),price_paise INTEGER NOT NULL,availability TEXT NOT NULL CHECK(availability IN ('accepting','paused')),is_original INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY,lot_id TEXT NOT NULL,original_order_id TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(lot_id) REFERENCES lots(id),FOREIGN KEY(original_order_id) REFERENCES orders(id));
CREATE TABLE IF NOT EXISTS offers(id TEXT PRIMARY KEY,case_id TEXT NOT NULL,lot_id TEXT NOT NULL,order_id TEXT NOT NULL,quantity_kg REAL NOT NULL CHECK(quantity_kg>0),agreed_price_paise INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('offered','accepted','reserved','delivered','cancelled')),buyer_accepted_demo INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,FOREIGN KEY(case_id) REFERENCES cases(id),FOREIGN KEY(lot_id) REFERENCES lots(id),FOREIGN KEY(order_id) REFERENCES orders(id));
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,offer_id TEXT UNIQUE NOT NULL,delivered_kg REAL NOT NULL,accepted_kg REAL NOT NULL,rejected_kg REAL NOT NULL,inspection_note TEXT,created_at TEXT NOT NULL,FOREIGN KEY(offer_id) REFERENCES offers(id));
CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('inspection','buyer')),file_name TEXT NOT NULL,mime TEXT NOT NULL,file_path TEXT NOT NULL,proposed_json TEXT,verified_json TEXT,engine TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,FOREIGN KEY(delivery_id) REFERENCES deliveries(id));
CREATE TABLE IF NOT EXISTS reviews(id TEXT PRIMARY KEY,delivery_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('inspection_basis','buyer_basis','more_evidence')),note TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(delivery_id) REFERENCES deliveries(id));
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,ref TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_offers_lot ON offers(lot_id,status);
CREATE INDEX IF NOT EXISTS idx_offers_order ON offers(order_id,status);
CREATE INDEX IF NOT EXISTS idx_evidence_delivery ON evidence(delivery_id);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS supplier_quotes(
 id TEXT PRIMARY KEY, original_order_id TEXT NOT NULL REFERENCES orders(id), supplier_name TEXT NOT NULL,
 location TEXT NOT NULL, crop TEXT NOT NULL, grade TEXT NOT NULL, offered_kg REAL NOT NULL CHECK(offered_kg>0),
 unit_price_paise INTEGER NOT NULL, transport_paise INTEGER NOT NULL DEFAULT 0, handling_paise INTEGER NOT NULL DEFAULT 0,
 source_reference TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('quoted','demo_confirmed','received','cancelled')),
 received_kg REAL, received_lot_id TEXT REFERENCES lots(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS original_allocations(
 id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), lot_id TEXT NOT NULL REFERENCES lots(id),
 quantity_kg REAL NOT NULL CHECK(quantity_kg>0), status TEXT NOT NULL DEFAULT 'reserved'
 CHECK(status IN ('reserved','dispatched','cancelled')),created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orig_alloc_lot ON original_allocations(lot_id,status);
CREATE INDEX IF NOT EXISTS idx_quotes_order ON supplier_quotes(original_order_id,status);
`);
db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),purpose TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at TEXT,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id,purpose);`);
if(!db.prepare('PRAGMA table_info(users)').all().some(col=>col.name==='fpo_id'))db.exec('ALTER TABLE users ADD COLUMN fpo_id TEXT');
for(const [name,ddl] of [
 ['transport_paise','INTEGER NOT NULL DEFAULT 0'],
 ['handling_paise','INTEGER NOT NULL DEFAULT 0']
]){if(!db.prepare('PRAGMA table_info(orders)').all().some(col=>col.name===name))db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${ddl}`);}
export function audit(actor,action,ref,detail={}){run('INSERT INTO events VALUES(?,?,?,?,?,?)',nextId('event','EVT'),actor,action,ref,JSON.stringify(detail),new Date().toISOString());}
export function seedDemo(){return transaction(()=>{
 for(const table of ['original_allocations','supplier_quotes','reviews','evidence','deliveries','offers','cases','orders','lots','events','counters'])run('DELETE FROM '+table);
 const now=new Date().toISOString();
 for(const l of [['LOT-001','Asha Devi',30,'A'],['LOT-002','Ravi Kumar',40,'B'],['LOT-003','Meena Singh',25,'A']])run('INSERT INTO lots VALUES(?,?,?,?,?,?,?,1)',l[0],l[1],'Tomatoes',l[2],l[3],'cleared',now);
 run('INSERT INTO orders (id,buyer_id,buyer_name,crop,grade,quantity_kg,price_paise,availability,is_original,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)','ORD-001','freshmart','FreshMart','Tomatoes','A',80,2500,'accepting',1,now);
 run('INSERT INTO orders (id,buyer_id,buyer_name,crop,grade,quantity_kg,price_paise,availability,is_original,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)','ORD-002','sauceworks','SauceWorks','Tomatoes','B',30,1600,'accepting',0,now);
 run('UPDATE orders SET transport_paise=?,handling_paise=? WHERE id=?',3000,500,'ORD-002');
 run('INSERT INTO orders (id,buyer_id,buyer_name,crop,grade,quantity_kg,price_paise,availability,is_original,created_at,transport_paise,handling_paise) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)','ORD-003','cityfresh','CityFresh Wholesale','Tomatoes','B',30,1800,'accepting',0,now,10000,1000);
 run('INSERT INTO cases VALUES(?,?,?,?)','CASE-001','LOT-002','ORD-001',now);
 for(const [id,supplier,location,qty,rate,transport,handling] of [
  ['SRC-001','North Valley Partner FPO','Sonipat, Haryana',15,2100,6000,1000],
  ['SRC-002','Greenfields Partner FPO','Ghaziabad, Uttar Pradesh',10,2250,4500,500]
 ])run('INSERT INTO supplier_quotes(id,original_order_id,supplier_name,location,crop,grade,offered_kg,unit_price_paise,transport_paise,handling_paise,source_reference,status,received_kg,received_lot_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',id,'ORD-001',supplier,location,'Tomatoes','A',qty,rate,transport,handling,'ILLUSTRATIVE_PARTNER_QUOTE','quoted',null,null,now);
 
 for(const [a,b] of [['lot',4],['order',4],['case',2],['offer',1],['delivery',1],['evidence',1],['review',1],['event',1],['source',3],['allocation',1]])run('INSERT INTO counters VALUES(?,?)',a,b);
 audit('system','DEMO_RESET','CASE-001',{note:'Illustrative tomato pilot: quantities and prices are sample data.'});
 });}
if(!one('SELECT id FROM users LIMIT 1')){
 run('INSERT INTO users(id,username,password_hash,display_name,role,buyer_id) VALUES(?,?,?,?,?,?)','USR-001','manager@agrova.test',hashPassword('Agrova123!'),'FPO Manager','manager',null);
 run('INSERT INTO users(id,username,password_hash,display_name,role,buyer_id) VALUES(?,?,?,?,?,?)','USR-002','sauce@agrova.test',hashPassword('Buyer123!'),'SauceWorks Buyer','buyer','sauceworks');
 run('INSERT INTO users(id,username,password_hash,display_name,role,buyer_id) VALUES(?,?,?,?,?,?)','USR-003','fresh@agrova.test',hashPassword('Buyer123!'),'FreshMart Buyer','buyer','freshmart');
}
if(!one('SELECT id FROM lots LIMIT 1'))seedDemo();
