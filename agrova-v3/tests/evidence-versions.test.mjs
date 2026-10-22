import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const original=process.cwd();
const temporary=mkdtempSync(join(tmpdir(),'agrova-version-schema-'));
process.chdir(temporary);
const {db,run,one,sql,seedDemo,nextId,migrateEvidenceVersions}=await import('../lib/db.mjs');

after(()=>{db.close();process.chdir(original);rmSync(temporary,{recursive:true,force:true});});

test('evidence versions are append-only and survive demo reset without ID reuse',()=>{
 const snapshot=JSON.stringify({accepted_kg:28,delivered_kg:30});
 run('INSERT INTO evidence_versions VALUES(?,?,?,?,?,?,?)','EVD-019',1,'inspection',snapshot,null,'USR-001','2026-10-22T00:00:00.000Z');
 assert.throws(()=>run('UPDATE evidence_versions SET verified_json=? WHERE evidence_id=?',JSON.stringify({accepted_kg:1}),'EVD-019'),/append-only/);
 assert.throws(()=>run('DELETE FROM evidence_versions WHERE evidence_id=?','EVD-019'),/append-only/);
 seedDemo();
 assert.equal(one('SELECT verified_json FROM evidence_versions WHERE evidence_id=?','EVD-019').verified_json,snapshot);
 assert.equal(nextId('evidence','EVD'),'EVD-020');
});

test('legacy verification and correction events backfill once without changing evidence',()=>{
 const timestamp='2026-10-22T12:00:00.000Z';
 run('INSERT INTO offers VALUES(?,?,?,?,?,?,?,?,?)','OFR-LEGACY','CASE-001','LOT-002','ORD-002',30,1600,'delivered',1,timestamp);
 run('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)','DLV-LEGACY','OFR-LEGACY',30,28,2,'Legacy delivery',timestamp);
 const evidenceId=nextId('evidence','EVD');
 const original={accepted_kg:25,delivered_kg:30,rejected_kg:5,rate_inr:16,deductions_inr:0,lot_ref:'LOT-002',source_reference:'Buyer statement'};
 const corrected={...original,accepted_kg:27,rejected_kg:3};
 run('INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?,?)',evidenceId,'DLV-LEGACY','buyer','buyer.txt','text/plain','legacy.bin',null,JSON.stringify(corrected),'pending',timestamp);
 run('INSERT INTO events VALUES(?,?,?,?,?,?)','EVT-VERIFY','USR-001','EVIDENCE_VERIFIED',evidenceId,'{}',timestamp);
 run('INSERT INTO events VALUES(?,?,?,?,?,?)','EVT-CORRECT','USR-001','EVIDENCE_CORRECTED',evidenceId,JSON.stringify({previous:original,corrected,reason:'Buyer receipt revised.'}),timestamp);
 assert.equal(migrateEvidenceVersions(),1);
 const versions=sql('SELECT * FROM evidence_versions WHERE evidence_id=? ORDER BY version_number',evidenceId);
 assert.deepEqual(versions.map(item=>JSON.parse(item.verified_json)),[original,corrected]);
 assert.deepEqual(versions.map(item=>item.version_number),[1,2]);
 assert.equal(versions[0].reason,null);
 assert.equal(versions[1].reason,'Buyer receipt revised.');
 assert.equal(versions[1].manager_id,'USR-001');
 assert.equal(one('SELECT verified_json FROM evidence WHERE id=?',evidenceId).verified_json,JSON.stringify(corrected));
 assert.equal(migrateEvidenceVersions(),0);
 assert.equal(one('SELECT COUNT(*) AS count FROM evidence_versions WHERE evidence_id=?',evidenceId).count,2);
});
