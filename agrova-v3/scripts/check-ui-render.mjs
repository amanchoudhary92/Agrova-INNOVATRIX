import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const js=fs.readFileSync(join(here,'../public/app.js'),'utf8');
const fixture=JSON.parse(fs.readFileSync(join(here,'fixtures/manager_fixture.json'),'utf8'));
const tests=[];
const managerViews=['overview','farmer','fpo','lots','orders','marketplace','matching','payments','invoices','logistics','ratings','admin','fulfillment','recovery','economics','settlement','ledger','activity'];
const buyerViews=['portal','marketplace','matching','tracking','payments','invoices','ratings'];
function makeContext(user){
 const root={innerHTML:''},toast={innerHTML:''};
 const ctx=vm.createContext({
  console,Date,JSON,Math,Number,String,Object,Array,Set,Map,Promise,
  document:{querySelector:(s)=>s==='#app'?root:s==='#toasts'?toast:null,addEventListener:()=>{}},
  window:{scrollTo:()=>{}},setTimeout:()=>0,clearTimeout:()=>{},
  fetch:async()=>({ok:true,json:async()=>({...user})})
 });
 vm.runInContext(js,ctx,{filename:'app.js',timeout:3000});
 return {ctx,root,toast};
}
async function validate(type,user,views){
 const {ctx,root}=makeContext(user);
 await new Promise(r=>setTimeout(r,15));
 for(const view of views){
  const html=vm.runInContext(`view='${view}'; renderView()`,ctx,{timeout:1000});
  assert.equal(typeof html,'string');
  assert(html.length>80,`${type} ${view} too short`);
  assert(!html.includes('undefined</strong>'),`${type} ${view} prints undefined`);
  const h=(html.match(/<h1[^>]*>(.*?)<\/h1>/)||[])[1]||'';
  tests.push({type,view,size:html.length,title:h});
 }
 let full=vm.runInContext('render(); document.querySelector("#app").innerHTML',ctx,{timeout:1000});
 assert(full.includes('class="shell"') && full.includes('class="nav"'));
 if(type==='manager'){
  vm.runInContext("view='matching';",ctx);const matching=vm.runInContext('renderView()',ctx);
  assert(matching.includes('Cheapest delivered'));
  assert(matching.includes('North Valley Partner FPO'));
  assert(matching.includes('Highest rated'));
  assert(matching.includes('10 kg') || matching.includes('10'));
  const invoice=vm.runInContext("view='invoices';renderView()",ctx);
  assert(invoice.includes('SAMPLE DOCUMENT'));
 }
}
await validate('manager',fixture,managerViews);
await validate('buyer',{user:{id:'USR-002',role:'buyer',display_name:'Sauceworks Buyer',buyer_id:'sauceworks'},orders:fixture.orders.filter(o=>o.buyer_id==='sauceworks'),offers:[],events:[],server_time:Date.now()},buyerViews);
console.log(`PASS ${tests.length} server-fixture render checks + navigation checks`);
for(const t of tests)console.log(t.type.padEnd(7),t.view.padEnd(15),t.size,t.title);
