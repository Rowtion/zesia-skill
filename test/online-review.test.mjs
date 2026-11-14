import test from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPortable} from '../runtime.mjs';
import {startOnlineReview} from '../review/online.mjs';
const packet={requester:'Codex',project:'bridge-test',brief:'Review the synthetic publication order.',context:{materials:[{id:'proof',content:'LOCAL-ONLY-CANARY'}]}};
async function setup(){
 const directory=await mkdtemp(join(tmpdir(),'zesia-online-test-'));let preflights=0,calls=0,recoveries=0,release,startedResolve;
 const pending=new Promise(resolve=>{release=resolve;});const started=new Promise(resolve=>{startedResolve=resolve;});
 const runtime=createPortable({stateDir:directory,configuration:async()=>({url:'https://api.zesia.dev',token:'long-lived-private-token'}),
  preflight:async()=>{preflights++;return {ok:true};},consult:async args=>{calls++;startedResolve();assert.match(args.requestId,/^zrq-\d{13}-/);await pending;return {format:'zesia.consult.v0',requestId:args.requestId,consultId:'one-consult',advice:'Same expert result',qualityStatus:'partial',deliveryKind:'opinion',a2a:{contextId:'one-context'}};},
  recover:async()=>{recoveries++;return {state:'running'};}});
 const prepared=await runtime.prepare(packet);const session=await startOnlineReview({runtime,draftId:prepared.draftId});
 const params=new URLSearchParams(new URL(session.url).hash.slice(1));
 const origin='http://127.0.0.1:'+params.get('port');const headers={origin:'https://zesia.dev',authorization:'Bearer '+params.get('key'),'content-type':'application/json'};
 const approval={draftId:prepared.draftId,requestId:prepared.requestId,approvedHash:prepared.approvedHash,destination:prepared.destination,protocolVersion:1};
 const request=(path,body,override={})=>fetch(origin+'/bridge/v1/'+path,{method:body?'POST':'GET',headers:{...headers,...override},...(body?{body:JSON.stringify(body)}:{})});
 return {directory,runtime,prepared,session,request,headers,approval,release,started,counts:()=>({preflights,calls,recoveries}),async close(){release();session.close();await rm(directory,{recursive:true,force:true});}};
}

test('online link holds only capability/port; preparation and read-only inspection make no cloud calls',async()=>{
 const s=await setup();try{
  assert.equal(new URL(s.session.url).origin,'https://zesia.dev');assert.equal(new URL(s.session.url).pathname,'/consult');
  assert.ok(!s.session.url.includes('CANARY')&&!s.session.url.includes('long-lived')&&!s.session.url.includes(s.prepared.requestId));
  const r=await s.request('view');const value=await r.json();
  assert.equal(r.headers.get('access-control-allow-origin'),'https://zesia.dev');
  assert.equal(value.packet.context.materials[0].content,'LOCAL-ONLY-CANARY');
  assert.ok(!JSON.stringify(value).includes('long-lived-private-token'));
  assert.deepEqual(s.counts(),{preflights:0,calls:0,recoveries:0});
  const preflight=await fetch('http://127.0.0.1:'+s.session.port+'/bridge/v1/view',{method:'OPTIONS',headers:{origin:'https://zesia.dev','access-control-request-method':'GET','access-control-request-headers':'authorization'}});
  assert.equal(preflight.status,204);
 }finally{await s.close();}
});

test('wrong origins, missing origin, wrong capability, Host spoofing and changed approval are refused before sending',async()=>{
 const s=await setup();try{
  for(const origin of ['https://evil.example','null',''])assert.equal((await s.request('view',null,{origin})).status,403);
  assert.equal((await s.request('view',null,{authorization:'Bearer wrong'})).status,403);
  const spoofed=await new Promise((resolve,reject)=>{const request=httpRequest('http://127.0.0.1:'+s.session.port+'/bridge/v1/view',{headers:{...s.headers,host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});assert.equal(spoofed,403);
  for(const override of [{destination:'https://evil.example'},{requestId:'wrong'},{approvedHash:'wrong'},{draftId:'wrong'},{packet:{brief:'replacement'}},{protocolVersion:2}])assert.ok((await s.request('approve',{...s.approval,...override})).status>=400);
  assert.deepEqual(s.counts(),{preflights:0,calls:0,recoveries:0});
 }finally{await s.close();}
});

test('approval starts exactly one execution; polling, duplicate clicks and agent receipt preserve the same result',async()=>{
 const s=await setup();try{
  const clicks=await Promise.all(Array.from({length:8},()=>s.request('approve',s.approval)));
  assert.ok(clicks.every(r=>r.status===202));
  const during=await(await s.request('status')).json();assert.equal(during.requestInProgress,true);
  await s.started;assert.equal(s.counts().calls,1);assert.equal(s.counts().preflights,0);
  const progress=await(await s.request('status?compact=1')).json();
  assert.equal(progress.requestInProgress,true);
  for(const key of ['packet','result','rawResult'])assert.equal(Object.hasOwn(progress,key),false);
  const stored=JSON.parse(await readFile(join(s.directory,s.prepared.draftId+'.json'),'utf8'));assert.equal(stored.approval.requestId,s.prepared.requestId);
  s.release();
  let value;
  for(let i=0;i<30;i++){value=await(await s.request('status')).json();if(value.status==='completed')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(value.rawResult.consultId,'one-consult');assert.equal(value.agentReceivedAt,null);
  const received=await s.runtime.result(s.prepared.draftId,{markReceived:true});assert.equal(received.consultId,'one-consult');
  assert.equal(typeof(await(await s.request('status')).json()).agentReceivedAt,'number');
  await s.request('approve',s.approval);assert.equal(s.counts().calls,1);
 }finally{await s.close();}
});

test('cancel persists and does not call preflight or cloud inference',async()=>{
 const s=await setup();try{await s.request('cancel',s.approval);assert.equal((await(await s.request('status')).json()).status,'cancelled');await s.request('approve',s.approval);assert.equal(s.counts().calls,0);}finally{await s.close();}
});

test('lost response recovers from cloud by the same request ID without another inference',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-online-recover-'));let calls=0,reads=0,id;
 try{
  const runtime=createPortable({stateDir:directory,configuration:async()=>({url:'https://api.zesia.dev',token:'private-token'}),preflight:async()=>({ok:true}),
   consult:async args=>{calls++;id=args.requestId;throw Error('Lost response');},recover:async args=>{reads++;assert.equal(args.requestId,id);return {state:'completed',requestId:id,result:{format:'zesia.consult.v0',requestId:id,consultId:'saved',advice:'Recovered actual opinion',a2a:{contextId:'same'}}};}});
  const prepared=await runtime.prepare(packet);await runtime.send(prepared.draftId,prepared.approvedHash,'User approved in the window.');
  const result=await runtime.result(prepared.draftId);assert.equal(result.consultId,'saved');assert.equal(calls,1);assert.equal(reads,1);
  await runtime.send(prepared.draftId,prepared.approvedHash,'User approved.');assert.equal(calls,1);
 }finally{await rm(directory,{recursive:true,force:true});}
});
