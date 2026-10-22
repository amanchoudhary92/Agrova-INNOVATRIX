/** Agrova Round 2 unified checkout finishing patch — Node.js 22+.
 * Based on the verified round2-corrections commit 0993656346ee...
 * No external dependencies. Does not commit, push, reset, or touch live SQLite data.
 */
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';

const baseCommit='0993656346ee0f29982695d6d4a9ea02084497e0';
const cwd=resolve(process.argv[2]||process.cwd());
const git=(args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const check=(condition,message)=>{if(!condition)throw Error(message);};
const replaceOnce=(text,oldText,newText,label)=>{
 const index=text.indexOf(oldText);
 check(index>=0,`Could not locate '${label}'. Your source differs from the reviewed code. No files were written.`);
 check(text.indexOf(oldText,index+oldText.length)===-1,`More than one '${label}' location: refusing an unsafe edit.`);
 return text.slice(0,index)+newText+text.slice(index+oldText.length);
};
try {
 const root=git(['rev-parse','--show-toplevel']);
 const project=join(root,'agrova-v3');
 const files=['server.mjs','public/app.js','scripts/check-ui-render.mjs'];
 for (const path of files)check(existsSync(join(project,path)),`Missing ${path}. Run from the root of the Agrova-INNOVATRIX repository.`);
 check(/amanchoudhary92[\/:]Agrova-INNOVATRIX(?:\.git)?$/i.test(git(['remote','get-url','origin'])),'The Git remote is not the expected Agrova-INNOVATRIX repository.');
 check(git(['branch','--show-current'])==='round2-final-integration','Switch to the round2-final-integration branch before applying the kit.');
 git(['merge-base','--is-ancestor',baseCommit,'HEAD']);
 check(!git(['status','--porcelain','--untracked-files=no']),'Tracked files are modified. Commit/stash your work first.');
 const paths=files.map(x=>join(project,x));
 let [server,app,ui]=paths.map(path=>readFileSync(path,'utf8'));
 check(server.includes('listEvidenceVersions(doc.id)')&&app.includes('function versionHistory(doc)')&&app.includes('function docLine(doc)'),'Expected append-only backend and history UI not found.');
 check(!app.includes('function activityEventDetail(e)'), 'This kit is already applied. Do not apply it twice.');

 // Server: show the manager's display name beside each stored immutable version.
 server=replaceOnce(server,
  'reason:version.reason,manager_id:version.manager_id,created_at:version.created_at,verified:',
  'reason:version.reason,manager_id:version.manager_id,manager_name:one(\'SELECT display_name FROM users WHERE id=?\',version.manager_id)?.display_name||version.manager_id,created_at:version.created_at,verified:',
  'evidence version manager name');

 // Browser: use the display name, falling back to the permanent manager ID.
 app=replaceOnce(app,'Manager ${esc(v.manager_id)}','Manager ${esc(v.manager_name||v.manager_id)}','version history manager label');

 // Browser: the raw correction JSON was legible to machines but not judges.
 const activityFn=`function activityEventDetail(e){
 if(e.action==='EVIDENCE_CORRECTED'){
  let d={};try{d=JSON.parse(e.detail||'{}');}catch{}
  const oldKg=d.old_kg??d.previous?.accepted_kg;
  const newKg=d.new_kg??d.corrected?.accepted_kg;
  return \`<p><strong>Accepted:</strong> \${oldKg==null?'Unknown':kg(oldKg)+' kg'} → \${newKg==null?'Unknown':kg(newKg)+' kg'}<br><strong>Reason:</strong> \${esc(d.reason||'Not recorded in this event')}</p>\`;
 }
 return \`<p>\${esc(e.detail)}</p>\`;
}
`;
 app=replaceOnce(app,'function activity(){',activityFn+'function activity(){','activity format function');
 app=replaceOnce(app,
  "<p>${esc(e.detail)}</p></div>`).join('')}</div></div>`;}",
  "${activityEventDetail(e)}</div>`).join('')}</div></div>`;}",
  'activity log detail rendering');

 // Add two useful regression assertions to the existing real browser render tests.
 ui=replaceOnce(ui,
  "   {version_number:2,current:true,verified:verified.verified,reason:'Receipt quantity was transcribed incorrectly.',manager_id:'USR-001',created_at:new Date().toISOString()},",
  "   {version_number:2,current:true,verified:verified.verified,reason:'Receipt quantity was transcribed incorrectly.',manager_id:'USR-001',manager_name:'FPO Manager',created_at:new Date().toISOString()},",
  'UI fixture manager identity');
 ui=replaceOnce(ui,
  "  assert(verifiedLine.includes('Initial verification · no correction reason'));",
  "  assert(verifiedLine.includes('Initial verification · no correction reason'));\n  assert(verifiedLine.includes('FPO Manager'), 'History shows the correcting manager');",
  'UI fixture current manager name assertion');

 // Document the unified submission. No external stack, libraries, or schemas.
 const notePath=join(project,'ROUND2_FINAL_TECH_NOTE.md');
 check(!existsSync(notePath),'ROUND2_FINAL_TECH_NOTE.md already exists. Review it before replacing.');
 const note=`# Agrova Round 2 — Technical Note\n\n1. Extends the existing Node.js 22, SQLite and vanilla JavaScript Round 1 codebase.\n2. The additive evidence_versions table stores verification and correction history.\n3. First verification creates Version 1; each correction appends another version.\n4. SQLite triggers prevent changes or deletion to existing evidence versions.\n5. Latest verification is selected by version_number DESC for both evidence kinds.\n6. Reconciliation and the farmer ledger derive their values from the latest versions.\n7. A correction after review reopens the delivery as needs_review.\n8. The settlement screen shows newest-first version history with reason, actor, time and a current marker.\n9. Correction audit events show previous kg, new kg, actor and reason.\n10. Manager-only correction APIs enforce reason and kg validation; buyers receive 403.\n\nTests: npm test; node scripts/check-ui-render.mjs; npm run smoke:isolated.\n`;
 // All anchor checks succeeded. Write the fully prepared files together.
 for(const [i,contents] of [server,app,ui].entries())writeFileSync(paths[i],contents,'utf8');
 writeFileSync(notePath,note,'utf8');
 console.log('PASS: unified settlement history with actor names, readable correction audit and UI regressions integrated.');
 console.log('No repository commit or push performed.');
 console.log('Now run npm test, node scripts/check-ui-render.mjs and npm run smoke:isolated inside agrova-v3.');
} catch (error) {
 console.error('INTEGRATION STOPPED:',error.message);
 process.exitCode=1;
}
