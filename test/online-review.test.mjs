import test from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
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

test('a new review bridge reports the saved run in progress and recovers the same result',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-online-recover-'));
 let calls=0,requestId,session,clock=Date.now(),cloudState='running';
 const options={
  stateDir:directory,
  now:()=>clock,
  configuration:async()=>({url:'https://api.zesia.dev',token:'fixture-token'}),
  consult:async args=>{calls++;requestId=args.requestId;throw Error('Lost response');},
  recover:async args=>{
   assert.equal(args.requestId,requestId);
   if(cloudState==='unavailable')throw Error('Status unavailable');
   if(cloudState!=='completed')return {state:cloudState,requestId};
   return {state:'completed',requestId,result:{
    format:'zesia.consult.v0',requestId,consultId:'saved',advice:'Recovered actual opinion',
    a2a:{contextId:'same',messageId:'original-reply'},
   }};
  },
 };
 try{
  const original=createPortable(options);
  const prepared=await original.prepare(packet);
  await original.send(prepared.draftId,prepared.approvedHash,'Test approval for the original draft.');
  assert.equal(requestId,prepared.requestId);
  const runtime=createPortable(options);
  session=await startOnlineReview({runtime,draftId:prepared.draftId});
  const params=new URLSearchParams(new URL(session.url).hash.slice(1));
  const headers={origin:'https://zesia.dev',authorization:'Bearer '+params.get('key')};
  const read=async path=>(await fetch('http://127.0.0.1:'+session.port+'/bridge/v1/'+path,{headers})).json();

  const view=await read('view');
  assert.equal(view.requestId,requestId);
  assert.equal(view.requestInProgress,true);
  assert.equal((await read('status')).requestInProgress,true);
  const compact=await read('status?compact=1');
  assert.equal(compact.requestInProgress,true);
  assert.equal(Object.hasOwn(compact,'packet'),false);

  for(const state of ['unknown','unavailable']){
   cloudState=state;clock+=2000;
   const status=await read('status');
   assert.equal(status.status,'unknown');
   assert.equal(status.requestInProgress,false);
  }
  cloudState='completed';clock+=2000;
  const completed=await read('view');
  assert.equal(completed.status,'completed');
  assert.equal(completed.requestInProgress,false);
  assert.equal(completed.rawResult.requestId,requestId);
  assert.equal(completed.rawResult.a2a.messageId,'original-reply');
  assert.deepEqual((await runtime.result(prepared.draftId)).a2a,completed.rawResult.a2a);
  assert.equal(calls,1);
 }finally{session?.close();await rm(directory,{recursive:true,force:true});}
});

test('bridge configure saves activation token locally and flips configured from false to true',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-online-cfg-'));
 let config={url:'https://api.zesia.dev',token:''};
 const runtime=createPortable({
  stateDir:directory,
  configuration:async()=>config,
  saveConfiguration:async values=>{config={url:values.url,token:values.token};return join(directory,'agent.json');},
 });
 const prepared=await runtime.prepare(packet);
 const session=await startOnlineReview({runtime,draftId:prepared.draftId});
 const params=new URLSearchParams(new URL(session.url).hash.slice(1));
 const origin='http://127.0.0.1:'+params.get('port');
 const headers={origin:'https://zesia.dev',authorization:'Bearer '+params.get('key'),'content-type':'application/json'};
 try{
  const before=await(await fetch(origin+'/bridge/v1/view',{headers})).json();
  assert.equal(before.configured,false);
  assert.equal(JSON.stringify(before).includes('secret'),false);

  const badToken=await fetch(origin+'/bridge/v1/configure',{method:'POST',headers,body:JSON.stringify({protocolVersion:1,destination:'https://api.zesia.dev',token:'short'})});
  assert.equal(badToken.status,400);

  const validToken='A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
  const wrongDest=await fetch(origin+'/bridge/v1/configure',{method:'POST',headers,body:JSON.stringify({protocolVersion:1,destination:'https://zesia-consult-staging.cprindex.workers.dev',token:validToken})});
  assert.equal(wrongDest.status,409);
  assert.equal(config.token,'');

  const res=await fetch(origin+'/bridge/v1/configure',{method:'POST',headers,body:JSON.stringify({protocolVersion:1,destination:'https://api.zesia.dev',token:validToken})});
  assert.equal(res.status,200);
  const after=await res.json();
  assert.equal(after.configured,true);
  assert.equal(config.token,validToken);
  assert.equal(JSON.stringify(after).includes(validToken),false);
 }finally{
  session.close();
  await rm(directory,{recursive:true,force:true});
 }
});

test('401 unauthorized sets reauthRequired and configure resets draft for re-send',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-online-reauth-'));
 let config={url:'https://api.zesia.dev',token:'expired-or-revoked-token-1234567890123456'};
 const freshToken='N1ewT2oken3For4Reauth5Flow6Testing789012345';
 const runtime=createPortable({
  stateDir:directory,
  configuration:async()=>config,
  saveConfiguration:async values=>{config={url:values.url,token:values.token};return join(directory,'agent.json');},
  consult:async args=>{
   if(args.token!==freshToken)throw Object.assign(new Error('This credential is invalid, expired or revoked.'),{code:'unauthorized',status:401,outcome:'not_started'});
   return {format:'zesia.consult.v0',requestId:args.requestId,consultId:'reauth-ok',advice:'Succeeded after re-auth',qualityStatus:'complete_structure',deliveryKind:'opinion',a2a:{contextId:'reauth-ctx'}};
  },
 });
 const prepared=await runtime.prepare(packet);
 const session=await startOnlineReview({runtime,draftId:prepared.draftId});
 const params=new URLSearchParams(new URL(session.url).hash.slice(1));
 const origin='http://127.0.0.1:'+params.get('port');
 const headers={origin:'https://zesia.dev',authorization:'Bearer '+params.get('key'),'content-type':'application/json'};
 const approval={draftId:prepared.draftId,requestId:prepared.requestId,approvedHash:prepared.approvedHash,destination:prepared.destination,protocolVersion:1};
 try{
  await fetch(origin+'/bridge/v1/approve',{method:'POST',headers,body:JSON.stringify(approval)});
  let view;
  for(let i=0;i<30;i++){
   view=await(await fetch(origin+'/bridge/v1/status',{headers})).json();
   if(view.status==='failed'&&!view.requestInProgress)break;
   await new Promise(r=>setTimeout(r,5));
  }
  assert.equal(view.status,'failed');
  assert.equal(view.requestInProgress,false);
  assert.equal(view.reauthRequired,true);

  const reconfigured=await fetch(origin+'/bridge/v1/configure',{method:'POST',headers,body:JSON.stringify({protocolVersion:1,destination:'https://api.zesia.dev',token:freshToken})});
  assert.equal(reconfigured.status,200);
  const ready=await reconfigured.json();
  assert.equal(ready.status,'prepared');
  assert.equal(ready.reauthRequired,false);

  const resend=await fetch(origin+'/bridge/v1/approve',{method:'POST',headers,body:JSON.stringify(approval)});
  assert.equal(resend.status,202);
  let done;
  for(let i=0;i<30;i++){done=await(await fetch(origin+'/bridge/v1/status',{headers})).json();if(done.status==='completed')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(done.status,'completed');
  assert.equal(done.rawResult.consultId,'reauth-ok');
 }finally{
  session.close();
  await rm(directory,{recursive:true,force:true});
 }
});

test('concurrent configure across runtime instances cannot delete active send claim or reset unknown state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-online-concurrent-reauth-'));
 let config={url:'https://api.zesia.dev',token:'expired-token-1234567890123456789012345'};
 const freshToken='F1resh2Token3For4Concurrency5Test6789012345';
 let calls=0,release,startedResolve;
 const pending=new Promise(r=>{release=r;});
 const started=new Promise(r=>{startedResolve=r;});
 const runtimeFast=createPortable({
  stateDir:directory,
  configuration:async()=>config,
  saveConfiguration:async values=>{config={url:values.url,token:values.token};return join(directory,'agent.json');},
  consult:async args=>{
   if(args.token!==freshToken)throw Object.assign(new Error('This credential is invalid, expired or revoked.'),{code:'unauthorized',status:401,outcome:'not_started'});
   calls++;startedResolve();await pending;
   return {format:'zesia.consult.v0',requestId:args.requestId,consultId:'one-send-only',advice:'Ok',qualityStatus:'complete_structure',deliveryKind:'opinion',a2a:{contextId:'ctx'}};
  },
 });
 const runtimeSlow=createPortable({
  stateDir:directory,
  configuration:async()=>config,
  saveConfiguration:async values=>{await new Promise(r=>setTimeout(r,40));config={url:values.url,token:values.token};return join(directory,'agent.json');},
 });
 let sendPromise;
 try{
  const prepared=await runtimeFast.prepare(packet);
  const failed=await runtimeFast.send(prepared.draftId,prepared.approvedHash,'Approved');
  assert.equal(failed.code,'unauthorized');
  assert.equal(failed.reauthRequired,true);
  assert.equal((await runtimeFast.inspect(prepared.draftId)).status,'failed');

  const slowConfigure=runtimeSlow.configure({destination:'https://api.zesia.dev',token:freshToken,draftId:prepared.draftId});
  await runtimeFast.configure({destination:'https://api.zesia.dev',token:freshToken,draftId:prepared.draftId});
  sendPromise=runtimeFast.send(prepared.draftId,prepared.approvedHash,'Approved');
  await started;
  await slowConfigure;

  const during=await runtimeFast.inspect(prepared.draftId);
  assert.equal(during.status,'unknown');
  await access(join(directory,prepared.draftId+'.json.send'));
  const dup=await runtimeFast.send(prepared.draftId,prepared.approvedHash,'Approved');
  assert.equal(dup.code,'outcome_unknown');
  assert.equal(calls,1);

  release();
  const done=await sendPromise;
  assert.equal(done.status,'completed');
  assert.equal(calls,1);
 }finally{
  release?.();
  await sendPromise?.catch(()=>{});
  await rm(directory,{recursive:true,force:true});
 }
});

test('bounded discussion approval and stopping are explicit and keep the same authenticated binding', async () => {
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const draft = { draftId: 'one', requestId: 'request', approvedHash: 'hash', destination: 'https://api.zesia.dev', expiresAt };
  let permitted = false, stopped = false, release, started;
  const inFlight = new Promise(resolve => { release = resolve; });
  const sent = new Promise(resolve => { started = resolve; });
  let sends = 0;
  const runtime = {
    async inspect() {
      return { ...draft, status: sends ? 'sending' : 'prepared', discussionMaxRounds: 3, discussion: { canStop: permitted && !stopped } };
    },
    async send(id, hash, _description, options) {
      assert.equal(id, draft.draftId);
      assert.equal(hash, draft.approvedHash);
      sends++;
      permitted = options?.maxRounds === 3;
      started();
      await inFlight;
    },
    async stopDiscussion() { stopped = true; },
  };
  const bridge = await startOnlineReview({ runtime, draftId: draft.draftId });
  try {
    const key = new URLSearchParams(new URL(bridge.url).hash.slice(1)).get('key');
    const { expiresAt: _omit, ...binding } = draft;
    const call = (path, body, authorization = 'Bearer ' + key) => fetch('http://127.0.0.1:' + bridge.port + '/bridge/v1/' + path, {
      method: 'POST', headers: { authorization, origin: 'https://zesia.dev', 'content-type': 'application/json' },
      body: JSON.stringify({ ...binding, protocolVersion: 1, ...body }),
    });
    assert.equal((await call('approve', { maxRounds: 4 })).status, 400);
    assert.equal((await call('stop-discussion')).status, 409);
    assert.equal((await call('approve', { maxRounds: 3, arbitrary: true })).status, 400);
    assert.equal((await call('approve', { maxRounds: 3 })).status, 202);
    await sent;
    assert.equal(permitted, true);
    assert.equal((await call('approve', { maxRounds: 3 })).status, 202);
    assert.equal((await call('stop-discussion', { approvedHash: 'other' })).status, 409);
    assert.equal((await call('stop-discussion', {}, 'Bearer other')).status, 403);
    assert.equal((await call('stop-discussion')).status, 200);
    assert.equal(stopped, true);
    assert.equal(sends, 1);
  } finally {
    release();
    bridge.close();
  }
});
