import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const original=process.cwd();
const temporary=mkdtempSync(join(tmpdir(),'agrova-version-schema-'));
process.chdir(temporary);
const {db,run,one,seedDemo,nextId}=await import('../lib/db.mjs');

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
