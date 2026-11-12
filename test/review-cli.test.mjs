import test from 'node:test';import assert from 'node:assert/strict';
import{fork,execFile}from'node:child_process';import{promisify}from'node:util';import{fileURLToPath}from'node:url';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createPortable}from'../runtime.mjs';import{launchReview}from'../review/launch.mjs';
const cli=process.env.ZESIA_REVIEW_TEST_ENTRY||fileURLToPath(new URL('../cli.mjs',import.meta.url));const execute=promisify(execFile);
test('CLI review process preserves state, emits only a local link and returns cancellation to the agent',async()=>{
 const stateDir=await mkdtemp(join(tmpdir(),'zesia-review-cli-'));let child;
 try{const runtime=createPortable({stateDir,configuration:async()=>({url:'https://api.zesia.dev'})});const draft=await runtime.prepare({requester:'Codex',project:'cli-test',brief:'Review this publication.',context:{goal:'Prevent a race'}});
 child=fork(cli,['serve-review',draft.draftId,'--no-open'],{env:{...process.env,ZESIA_STATE_DIR:stateDir},stdio:['ignore','ignore','ignore','ipc']});const session=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(Error('Review exited before readiness.')));});assert.equal(session.ok,true);assert.equal(session.packet,undefined);assert.equal(session.browserOpened,false);
 const origin=new URL(session.url).origin;const response=await fetch(origin+'/api/cancel',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+new URL(session.url).hash.slice(5),'Content-Type':'application/json'},body:JSON.stringify({approvedHash:draft.approvedHash})});assert.equal((await response.json()).status,'cancelled');
 const result=await execute(process.execPath,[cli,'result',draft.draftId],{env:{...process.env,ZESIA_STATE_DIR:stateDir}}).catch(e=>e);assert.equal(JSON.parse(result.stdout).status,'cancelled');
 }finally{if(child){child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}await rm(stateDir,{recursive:true,force:true});}
});
test('launch failure returns a usable error instead of leaving the agent waiting',async()=>{
 await assert.rejects(launchReview(fileURLToPath(new URL('./missing-entry.mjs',import.meta.url)),'not-a-draft',{openBrowser:false}),/stopped before starting/);
});
