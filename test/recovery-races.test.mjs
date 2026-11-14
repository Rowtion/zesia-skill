import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createPortable} from '../runtime.mjs';
const packet={requester:'Codex',project:'recovery-race',brief:'Review the synthetic result.',context:{goal:'Preserve the completed opinion.'}};
const configuration=async()=>({url:'https://api.zesia.dev',token:'synthetic-private-token'});

test('a late send error cannot overwrite an opinion recovered by another runtime instance',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-recovery-race-'));let rejectSend,started;
 const sending=new Promise(resolve=>{started=resolve;});const pending=new Promise((_,reject)=>{rejectSend=reject;});
 const options={stateDir:directory,configuration,preflight:async()=>({ok:true})};
 const sender=createPortable({...options,consult:async()=>{started();return pending;}});
 const receiver=createPortable({...options,recover:async({requestId})=>({state:'completed',result:{format:'zesia.consult.v0',requestId,consultId:'preserved',advice:'Keep this actual recovered opinion.'}})});
 try{
  const draft=await sender.prepare(packet);const send=sender.send(draft.draftId,draft.approvedHash,'User approved.');await sending;
  assert.equal((await receiver.result(draft.draftId)).consultId,'preserved');
  rejectSend(Error('The original response timed out.'));assert.equal((await send).consultId,'preserved');
  assert.equal((await sender.inspect(draft.draftId)).status,'completed');
  assert.equal((await createPortable(options).result(draft.draftId)).advice,'Keep this actual recovered opinion.');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('CLI wait keeps reading a running recovery until the same request completes without inference',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-recovery-wait-'));let reads=0,otherCalls=0,requestId;
 const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(!req.url.startsWith('/v1/consult/requests/')){otherCalls++;res.writeHead(500);return res.end('{}');}
  assert.equal(req.headers.authorization,'Bearer synthetic-private-token');reads++;
  res.end(JSON.stringify(reads===1?{requestId,state:'running'}:{requestId,state:'completed',result:{format:'zesia.consult.v0',requestId,consultId:'eventually-completed',advice:'The original opinion.'}}));
 });
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={url:'http://127.0.0.1:'+server.address().port,token:'synthetic-private-token'};
  const runtime=createPortable({stateDir:directory,configuration:async()=>config,preflight:async()=>({ok:true}),consult:async()=>{throw Error('Lost response.');}});
  const draft=await runtime.prepare(packet);requestId=draft.requestId;await runtime.send(draft.draftId,draft.approvedHash,'User approved.');
  const configFile=join(directory,'config.json');await writeFile(configFile,JSON.stringify(config),{mode:0o600});
  const {stdout}=await promisify(execFile)(process.execPath,['cli.mjs','wait',draft.draftId,'5'],{env:{...process.env,ZESIA_CONFIG:configFile,ZESIA_STATE_DIR:directory},timeout:10000});
  assert.equal(JSON.parse(stdout).consultId,'eventually-completed');assert.equal(otherCalls,0);assert.ok(reads>=2);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
