// Run the existing destructive demo smoke workflow against a fresh temporary server.
import {spawn} from 'node:child_process';
import {cpSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sandbox=mkdtempSync(join(tmpdir(),'agrova-smoke-'));
let server;
const freePort=()=>new Promise((done,fail)=>{
 const socket=net.createServer();
 socket.once('error',fail);
 socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>done(port));});
});

try{
 for(const entry of ['server.mjs','lib','public','package.json'])cpSync(join(project,entry),join(sandbox,entry),{recursive:true});
 const port=await freePort();
 const base=`http://127.0.0.1:${port}`;
 server=spawn(process.execPath,['--no-warnings','server.mjs'],{cwd:sandbox,env:{...process.env,PORT:String(port),GEMINI_API_KEY:''},stdio:'pipe'});
 let serverLog='';
 server.stdout.on('data',chunk=>serverLog+=chunk);
 server.stderr.on('data',chunk=>serverLog+=chunk);
 let ready=false;
 for(let attempt=0;attempt<80;attempt++){
  if(server.exitCode!==null)break;
  try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}
  await new Promise(done=>setTimeout(done,100));
 }
 if(!ready)throw Error(`Temporary server did not start. ${serverLog}`);
 const smoke=spawn(process.execPath,[join(project,'scripts','smoke-test.mjs')],{cwd:sandbox,env:{...process.env,TEST_BASE_URL:base},stdio:'inherit'});
 const code=await new Promise((done,fail)=>{smoke.once('error',fail);smoke.once('exit',exitCode=>done(exitCode));});
 if(code!==0)throw Error(`Disposable smoke test exited with ${code}. ${serverLog}`);
 console.log('PASS: smoke workflow ran only against a temporary database.');
}catch(error){console.error(error);process.exitCode=1;
}finally{
 if(server){server.kill('SIGTERM');await new Promise(done=>{if(server.exitCode!==null||server.signalCode!==null)return done();const timer=setTimeout(done,1500);server.once('exit',()=>{clearTimeout(timer);done();});});}
 rmSync(sandbox,{recursive:true,force:true});
}
