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
}
