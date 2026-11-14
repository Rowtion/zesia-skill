import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
const binary=process.env.ZESIA_NATIVE_TEST_BIN;

test('standalone installation, online review, official A2A and agent result require no Node on PATH',{skip:!binary},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-no-node-'));let remote,bridgePid,calls=0,last;
 const extension=process.platform==='win32'?'.exe':'';
 try{
  const source=join(directory,'source'),project=join(directory,'project'),config=join(directory,'private-config.json');
  await mkdir(join(source,'scripts'),{recursive:true});await mkdir(project);await writeFile(join(project,'.env'),'ZESIA_URL=https://example.invalid/untrusted-env\n');
  await cp(resolve(binary),join(source,'scripts/zesia'+extension));
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  let seed=resolve(dirname(binary),'../bin');try{await access(seed);}catch{seed=join(repo,'bin');}await cp(seed,join(source,'bin'),{recursive:true});
  for(const file of ['SKILL.md','references','LICENSE','THIRD_PARTY_NOTICES.md'])await cp(join(repo,file),join(source,file),{recursive:true});
  await cp(join(repo,'scripts/install-a2a.mjs'),join(source,'scripts/install-a2a.mjs'));
  const host={id:'codex',version:'0.3.0',runtimeVersion:'0.4.0',skillDirectory:'.agents/skills',requester:'Codex'};
  await writeFile(join(source,'host.json'),JSON.stringify(host));
  remote=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
   if(url.pathname==='/v1/consult/preflight'){res.end(JSON.stringify({format:'zesia.consult.preflight.v1',ok:true,modelCalls:0}));return;}
   if(url.pathname.startsWith('/v1/consult/requests/')){res.end(JSON.stringify(last?{requestId:last.requestId,state:'completed',result:last}:{requestId:url.pathname.split('/').at(-1),state:'running'}));return;}
   assert.equal(req.headers.authorization,'Bearer synthetic-standalone-token');
   assert.match(req.headers['x-zesia-request-id'],/^zrq-\d{13}-/);
   let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);calls++;
   last={format:'zesia.consult.v0',requestId:req.headers['x-zesia-request-id'],consultId:'standalone-one',advice:'Independent synthetic review',deliveryKind:'opinion',qualityStatus:'partial',a2a:{contextId:'standalone-context'}};
   res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{message:{messageId:'standalone-reply',contextId:'standalone-context',role:'ROLE_AGENT',parts:[{data:last,mediaType:'application/vnd.zesia.consult+json'}]}}}));
  });await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
  const emptyPath=join(directory,'empty-path');await mkdir(emptyPath);
  const env={...process.env,PATH:process.platform==='win32'?process.env.SystemRoot+'\\System32':emptyPath,ZESIA_CONFIG:config,ZESIA_STATE_DIR:join(directory,'state')};
  // All executable calls use direct paths. No system Node, Bun or global PATH setup.
  if(process.platform!=='win32')await assert.rejects(execute('/bin/sh',['-c','command -v node'],{env}));
  const sourceExe=join(source,'scripts/zesia'+extension);
  const installed=JSON.parse((await execute(sourceExe,['install',project],{env,cwd:project,timeout:30000})).stdout);
  assert.equal(installed.ok,true);
  const exe=join(installed.destination,'scripts/zesia'+extension);
  const tokenFile=join(directory,'token.json');await writeFile(tokenFile,JSON.stringify({token:'synthetic-standalone-token'}),{mode:0o600});
  await execute(exe,['configure','--token-file',tokenFile,'--url','http://127.0.0.1:'+remote.address().port],{env,timeout:10000});
  const packetFile=join(directory,'packet.json');await writeFile(packetFile,JSON.stringify({requester:'Codex',project:'no-node-proof',brief:'Review synthetic ordering.',context:{goal:'Keep artifacts consistent.'}}));
  const prepared=JSON.parse((await execute(exe,['prepare',packetFile],{env,cwd:project,timeout:10000})).stdout);assert.equal(calls,0);assert.equal(prepared.destination,'http://127.0.0.1:'+remote.address().port);
  const session=JSON.parse((await execute(exe,['review',prepared.draftId,'--no-open'],{env,timeout:15000})).stdout);bridgePid=session.bridgePid;
  assert.equal(session.ok,true);assert.equal(new URL(session.url).origin,'https://zesia.dev');
  const params=new URLSearchParams(new URL(session.url).hash.slice(1));const local='http://127.0.0.1:'+params.get('port');
  const headers={origin:'https://zesia.dev',authorization:'Bearer '+params.get('key'),'content-type':'application/json'};
  const view=await(await fetch(local+'/bridge/v1/view',{headers})).json();assert.equal(calls,0);assert.ok(!JSON.stringify(view).includes('synthetic-standalone-token'));
  await fetch(local+'/bridge/v1/approve',{method:'POST',headers,body:JSON.stringify({draftId:view.draftId,requestId:view.requestId,approvedHash:view.approvedHash,destination:view.destination,protocolVersion:1})});
  const result=JSON.parse((await execute(exe,['wait',prepared.draftId,'10'],{env,timeout:15000})).stdout);
  assert.equal(result.consultId,'standalone-one');assert.equal(calls,1);
  assert.equal(typeof(await(await fetch(local+'/bridge/v1/status',{headers})).json()).agentReceivedAt,'number');
 }finally{
  if(bridgePid){try{process.kill(bridgePid,'SIGTERM');}catch{}}
  if(remote){remote.closeAllConnections();await new Promise(r=>remote.close(r));}
  await rm(directory,{recursive:true,force:true});
 }
});
