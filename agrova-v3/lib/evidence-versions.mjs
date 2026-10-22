import {one,sql,run} from './db.mjs';

export const latestEvidenceVersion=evidenceId=>one('SELECT * FROM evidence_versions WHERE evidence_id=? ORDER BY version_number DESC LIMIT 1',evidenceId)||null;
export const listEvidenceVersions=evidenceId=>sql('SELECT * FROM evidence_versions WHERE evidence_id=? ORDER BY version_number DESC',evidenceId);

// Call only inside transaction(): insertion and the current-value mirror must commit together.
export function insertEvidenceVersion(evidence,verified,managerId,reason=null){
 const previous=latestEvidenceVersion(evidence.id);
 const version_number=(previous?.version_number||0)+1;
 const created_at=new Date().toISOString();
 run('INSERT INTO evidence_versions VALUES(?,?,?,?,?,?,?)',evidence.id,version_number,evidence.kind,JSON.stringify(verified),reason,managerId,created_at);
 return {version_number,created_at};
// Append-only evidence history. Every verification of an evidence document is kept
// as an immutable version row; earlier versions are never updated or deleted.
import {one,sql,run,audit,nextId,transactionSafe} from './db.mjs';
import {roundKg} from './domain.mjs';

const now=()=>new Date().toISOString();
const numberOrNull=(value)=>{if(value==null||value==='')return null;const n=Number(value);return Number.isFinite(n)?n:null;};
const kgOrNull=(value)=>{const n=numberOrNull(value);return n==null?null:roundKg(n);};

export function listEvidenceVersions(evidenceId){return sql('SELECT * FROM evidence_versions WHERE evidence_id=? ORDER BY version_number ASC',evidenceId);}

// The newest version is resolved by version_number, never by insertion order.
export function latestEvidenceVersion(evidenceId){return one('SELECT * FROM evidence_versions WHERE evidence_id=? ORDER BY version_number DESC LIMIT 1',evidenceId)||null;}

// Single entry point for callers: the first verification becomes version 1,
// every later verification is appended as a correction.
export function recordEvidenceVerification(evidence,verified,verified_by='system',options={}){
 const correction_reason=options.correction_reason??null;
 return transactionSafe(()=>{
  const existing=one('SELECT version_number FROM evidence_versions WHERE evidence_id=? ORDER BY version_number DESC LIMIT 1',evidence.id);
  if(!existing)return createInitialEvidenceVersion(evidence,verified,verified_by);
  return appendEvidenceCorrection(evidence,verified,verified_by,{correction_reason});
 });
}

export function normalizeVerified(verified){
 const accepted=kgOrNull(verified?.accepted_kg);
 if(accepted==null||accepted<0)throw new Error('Enter a valid accepted quantity (kg).');
 return {accepted_kg:accepted,delivered_kg:kgOrNull(verified?.delivered_kg),rejected_kg:kgOrNull(verified?.rejected_kg),rate_inr:numberOrNull(verified?.rate_inr),deductions_inr:numberOrNull(verified?.deductions_inr)??0,lot_ref:String(verified?.lot_ref||'').slice(0,50),source_reference:String(verified?.source_reference||'').slice(0,220)};
}

function insertVersion({evidence,snapshot,version_number,correction_reason,verified_by}){
 const id=nextId('evidence_version','EVV');
 const created_at=now();
 run('INSERT INTO evidence_versions(id,evidence_id,version_number,kind,accepted_kg,delivered_kg,rejected_kg,rate_inr,deductions_inr,lot_ref,source_reference,correction_reason,verified_by,verified_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  id,evidence.id,version_number,evidence.kind,snapshot.accepted_kg,snapshot.delivered_kg,snapshot.rejected_kg,snapshot.rate_inr,snapshot.deductions_inr,snapshot.lot_ref,snapshot.source_reference,correction_reason,verified_by,JSON.stringify(snapshot),created_at);
 return {id,evidence_id:evidence.id,version_number,kind:evidence.kind,accepted_kg:snapshot.accepted_kg,delivered_kg:snapshot.delivered_kg,rejected_kg:snapshot.rejected_kg,rate_inr:snapshot.rate_inr,deductions_inr:snapshot.deductions_inr,lot_ref:snapshot.lot_ref,source_reference:snapshot.source_reference,correction_reason,verified_by,created_at,verified:snapshot};
}

// Appends a corrected version. Earlier versions are never updated or deleted.
export function appendEvidenceCorrection(evidence,verified,verified_by='system',{correction_reason=null}={}){
 if(!evidence?.id)throw new Error('Evidence record is required.');
 if(!['inspection','buyer'].includes(evidence.kind))throw new Error('Unsupported evidence type.');
 const reason=String(correction_reason||'').trim().slice(0,500);
 if(!reason)throw new Error('A correction reason is required when revising a verified document.');
 const snapshot=normalizeVerified(verified);
 const actor=String(verified_by||'system');
 return transactionSafe(()=>{
  const latest=one('SELECT version_number FROM evidence_versions WHERE evidence_id=? ORDER BY version_number DESC LIMIT 1',evidence.id);
  if(!latest)throw new Error('This evidence has no verified version yet. Verify it first.');
  const version_number=latest.version_number+1;
  const version=insertVersion({evidence,snapshot,version_number,correction_reason:reason,verified_by:actor});
  run('UPDATE evidence SET verified_json=? WHERE id=?',JSON.stringify(snapshot),evidence.id);
  audit(actor,'EVIDENCE_CORRECTED',evidence.id,{version_number,previous_version_number:latest.version_number,kind:evidence.kind,accepted_kg:snapshot.accepted_kg,correction_reason:reason});
  return version;
 });
}

// Version 1: the original verification. No correction reason is required.
export function createInitialEvidenceVersion(evidence,verified,verified_by='system'){
 if(!evidence?.id)throw new Error('Evidence record is required.');
 if(!['inspection','buyer'].includes(evidence.kind))throw new Error('Unsupported evidence type.');
 const snapshot=normalizeVerified(verified);
 const actor=String(verified_by||'system');
 return transactionSafe(()=>{
  const existing=one('SELECT version_number FROM evidence_versions WHERE evidence_id=? ORDER BY version_number DESC LIMIT 1',evidence.id);
  if(existing)throw new Error('This evidence already has a verified version. Append a correction instead.');
  const version=insertVersion({evidence,snapshot,version_number:1,correction_reason:null,verified_by:actor});
  run('UPDATE evidence SET verified_json=? WHERE id=?',JSON.stringify(snapshot),evidence.id);
  audit(actor,'EVIDENCE_VERIFIED',evidence.id,{version_number:1,kind:evidence.kind,accepted_kg:snapshot.accepted_kg});
  return version;
 });
}
