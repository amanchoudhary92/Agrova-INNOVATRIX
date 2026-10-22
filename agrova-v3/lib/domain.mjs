export const roundKg = (value) => Math.round(Number(value) * 1000) / 1000;
export function finiteKg(x, {allowZero=false}={}) {
  const n=Number(x);
  if(!Number.isFinite(n) || n < 0 || (!allowZero && n === 0) || n > 10000000) throw new Error('Enter a valid positive quantity (kg).');
  return roundKg(n);
}
export function moneyPaise(x) {
  const n=Number(x);
  if(!Number.isFinite(n) || n<0 || n>100000000) throw new Error('Invalid INR amount.');
  return Math.round(n*100);
}
export function correctionReason(value){
 const reason=String(value??'').trim();
 if(reason.length<10||reason.length>1000)throw new Error('Correction reason must be between 10 and 1000 characters.');
 return reason;
}
export function mismatch(required,eligible){return Math.max(0,roundKg(Number(required)-Number(eligible)));}
export function canUseLot(lot,order){return lot.crop.toLowerCase().trim()===order.crop.toLowerCase().trim() && lot.grade===order.grade && lot.safety==='cleared';}
export function matchStock(lots,order,allocations=[]){
  const eligible=lots.filter(l=>canUseLot(l,order)).reduce((sum,lot)=>sum+Math.max(0,lot.quantity_kg-allocations.filter(a=>a.lot_id===lot.id && ['reserved','delivered'].includes(a.status)).reduce((s,a)=>s+a.quantity_kg,0)),0);
  const alreadyAllocated=allocations.filter(a=>a.order_id===order.id && ['reserved','delivered'].includes(a.status)).reduce((s,a)=>s+a.quantity_kg,0);
  const needed=Math.max(0,order.quantity_kg-alreadyAllocated);
  return {eligible_kg:roundKg(eligible),filled_kg:roundKg(alreadyAllocated),unfilled_kg:mismatch(needed,eligible)};
}
export function maxOffer(lot,order,allocations=[]){
  if(!canUseLot(lot,order) || order.availability!=='accepting')return 0;
  const used=allocations.filter(a=>a.lot_id===lot.id && ['reserved','delivered'].includes(a.status)).reduce((s,a)=>s+a.quantity_kg,0);
  const ordered=allocations.filter(a=>a.order_id===order.id && ['reserved','delivered'].includes(a.status)).reduce((s,a)=>s+a.quantity_kg,0);
  return roundKg(Math.max(0,Math.min(lot.quantity_kg-used,order.quantity_kg-ordered)));
}
export function reconcile(inspectionKg,buyerKg,pricePaise,deductionsPaise=0){
 const inspection=finiteKg(inspectionKg,{allowZero:true});
 const buyer=buyerKg==null?null:finiteKg(buyerKg,{allowZero:true});
 const difference=buyer==null?null:roundKg(inspection-buyer);
 return {inspection_kg:inspection,buyer_kg:buyer,difference_kg:difference,disputed_paise:difference==null?0:Math.round(Math.abs(difference)*pricePaise),inspection_payable_paise:Math.max(0,Math.round(inspection*pricePaise)-deductionsPaise),buyer_reported_paise:buyer==null?null:Math.max(0,Math.round(buyer*pricePaise)-deductionsPaise)};
}
export function hindiExplanation({farmer,grade,quantity,offerQty,acceptedQty,pricePaise,unresolved}){
 const fmt=n=>Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
 if(acceptedQty!=null)return `${farmer} जी, आपकी ${fmt(offerQty)} किलो ग्रेड ${grade} फसल भेजी गई। निरीक्षण में ${fmt(acceptedQty)} किलो स्वीकार हुई। तय दर पर ₹${fmt(Math.round(acceptedQty*pricePaise)/100)} बनते हैं (सहमति के अनुसार कटौतियों से पहले)। ${unresolved?'खरीदार के रिकॉर्ड में अंतर है और समीक्षा जारी है।':'निपटान की स्थिति पोर्टल में देखें।'}`;
 return `${farmer} जी, आपकी ${fmt(quantity)} किलो फसल ग्रेड ${grade} है। मूल खरीदार की गुणवत्ता शर्त अलग है। दूसरे खरीदार को ${fmt(offerQty)} किलो का प्रस्ताव दिया जा सकता है। ${fmt(Math.max(0,quantity-offerQty))} किलो अभी इस प्रस्ताव में शामिल नहीं है।`;
}
export function heuristicTextExtract(text){
 const pick=(keys)=>{for(const key of keys){const m=text.match(new RegExp('(?:^|\\n)\\s*'+key+'\\s*[:=\\-]\\s*([0-9]+(?:\\.[0-9]+)?)','im'));if(m)return Number(m[1]);}return null;};
 const ref=text.match(/\b(?:LOT|ORD|CASE)-\d{3,}\b/i);
 const date=text.match(/\b20\d\d-\d\d-\d\d\b/);
 return {lot_ref:ref?.[0]?.toUpperCase()??null,delivered_kg:pick(['delivered','received','भेजी']),accepted_kg:pick(['accepted','स्वीकृत']),rejected_kg:pick(['rejected','अस्वीकृत']),rate_inr:pick(['rate','price']),deductions_inr:pick(['deductions','deduction']),document_date:date?.[0]??null};
}
