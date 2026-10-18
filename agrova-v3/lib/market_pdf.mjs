/** Minimal single-page ASCII-safe PDF for SAMPLE / DEMO invoices. Not a tax invoice. */
const clean=value=>String(value??'').replace(/[^\x20-\x7e]/g,'?').replace(/[()\\]/g,'\\$&').slice(0,105);
export function sampleInvoicePdf(invoice){
 const inr=p=>(Number(p)/100).toFixed(2);
 const lines=[
 'AGROVA - SAMPLE / DEMO INVOICE',
 'NOT A TAX INVOICE - NO GST/TAX VALIDATION',
 `Invoice: ${invoice.invoice_number}`,
 `Order: ${invoice.order_id}`,
 `Date: ${invoice.issued_at}`,
 `Seller / FPO: ${invoice.seller}`,
 `Buyer: ${invoice.buyer}`,
 `Product: ${invoice.crop} (Grade ${invoice.grade})`,
 `Quantity (kg): ${invoice.quantity_kg}`,
 `Unit price (INR): ${inr(invoice.unit_price_paise)}`,
 `Transport (INR): ${inr(invoice.transport_paise)}`,
 `Total (INR): ${inr(invoice.total_paise)}`,
 'Payment: VERIFIED IN DEMO SIMULATOR ONLY',
 'This document is for hackathon demonstrations only.'
 ];
 const ops=lines.map((l,i)=>`BT /F1 ${i===0?17:11} Tf 45 ${760-i*39} Td (${clean(l)}) Tj ET`).join('\n');
 const objects=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`];
 let pdf='%PDF-1.4\n',offsets=[0];for(let i=1;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i} 0 obj\n${objects[i]}\nendobj\n`}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length}\n0000000000 65535 f \n`;for(let i=1;i<objects.length;i++)pdf+=`${String(offsets[i]).padStart(10,'0')} 00000 n \n`;pdf+=`trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf,'ascii');
}
