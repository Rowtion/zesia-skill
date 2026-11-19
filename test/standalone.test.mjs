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

for (const streaming of [false, true]) {
test('standalone '+(streaming?'streaming':'non-streaming')+' installation, online review and handback require no Node on PATH',{skip:!binary},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zesia-no-node-'));let remote,bridgePid,calls=0,last;
 const extension=process.platform==='win32'?'.exe':'';
 let finish;
 const finishGate=new Promise(resolve=>{finish=resolve;});
 try{
  const source=join(directory,'source'),project=join(directory,'project'),config=join(directory,'private-config.json');
  await mkdir(join(source,'scripts'),{recursive:true});await mkdir(project);await writeFile(join(project,'.env'),'ZESIA_URL=https://example.invalid/untrusted-env\n');
  await cp(resolve(binary),join(source,'scripts/zesia'+extension));
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  let seed=resolve(dirname(binary),'../bin');try{await access(seed);}catch{seed=join(repo,'bin');}await cp(seed,join(source,'bin'),{recursive:true});
  for(const file of ['SKILL.md','references','LICENSE','THIRD_PARTY_NOTICES.md'])await cp(join(repo,file),join(source,file),{recursive:true});
  await cp(join(repo,'scripts/install-a2a.mjs'),join(source,'scripts/install-a2a.mjs'));
  const host={id:'codex',version:'0.3.0',runtimeVersion:JSON.parse(await readFile(join(repo,'package.json'),'utf8')).version,skillDirectory:'.agents/skills',requester:'Codex'};
  await writeFile(join(source,'host.json'),JSON.stringify(host));
  remote=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
   if(url.pathname==='/.well-known/agent-card.json'){
    res.end(JSON.stringify({ capabilities:{streaming:true},supportedInterfaces:[{
     url:'http://127.0.0.1:'+remote.address().port+'/a2a',protocolBinding:'JSONRPC',protocolVersion:'1.0',
    }] }));return;
   }
   if(url.pathname==='/v1/consult/preflight'){res.end(JSON.stringify({format:'zesia.consult.preflight.v1',ok:true,modelCalls:0}));return;}
   if(url.pathname.startsWith('/v1/consult/requests/')){res.end(JSON.stringify(last?{requestId:last.requestId,state:'completed',result:last}:{requestId:url.pathname.split('/').at(-1),state:'running'}));return;}
   assert.equal(req.headers.authorization,'Bearer synthetic-standalone-token');
   assert.match(req.headers['x-zesia-request-id'],/^zrq-\d{13}-/);
   let raw='';for await(const chunk of req)raw+=chunk;const rpc=JSON.parse(raw);calls++;
   last={format:'zesia.consult.v0',requestId:req.headers['x-zesia-request-id'],consultId:'standalone-one',advice:'Independent synthetic review',deliveryKind:'opinion',qualityStatus:'partial',a2a:{contextId:'standalone-context',messageId:'standalone-reply'}};
   if(streaming){
    assert.equal(rpc.method,'SendStreamingMessage');
    const binding={taskId:last.requestId,contextId:last.a2a.contextId};
    res.setHeader('content-type','text/event-stream');
    const emit=value=>res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:value})+'\n\n');
    emit({task:{id:binding.taskId,contextId:binding.contextId,status:{state:'TASK_STATE_SUBMITTED'}}});
    emit({artifactUpdate:{...binding,artifact:{artifactId:'recommendation-preview',parts:[{text:'Early synthetic preview'}]}}});
    await finishGate;
    emit({artifactUpdate:{...binding,lastChunk:true,artifact:{artifactId:'consult-result',parts:[{data:last,mediaType:'application/vnd.zesia.consult+json'}]}}});
    emit({statusUpdate:{...binding,status:{state:'TASK_STATE_COMPLETED'}}});
    res.end();
    return;
   }
   assert.equal(rpc.method,'SendMessage');
   res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{message:{messageId:'standalone-reply',contextId:'standalone-context',role:'ROLE_AGENT',parts:[{data:last,mediaType:'application/vnd.zesia.consult+json'}]}}}));
  });await new Promise(resolve=>remote.listen(0,'127.0.0.1',resolve));
  const emptyPath=join(directory,'empty-path');await mkdir(emptyPath);
  const env={...process.env,PATH:process.platform==='win32'?process.env.SystemRoot+'\\System32':emptyPath,ZESIA_CONFIG:config,ZESIA_STATE_DIR:join(directory,'state'),ZESIA_CONSULT_STREAMING:streaming?'enabled':''};
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
  if(streaming){
   let preview;
   for(let i=0;i<80;i++){
    preview=(await(await fetch(local+'/bridge/v1/status?compact=1',{headers})).json()).streamPreview;
    if(preview)break;
    await new Promise(resolve=>setTimeout(resolve,50));
   }
   assert.equal(preview,'Early synthetic preview');
   assert.equal(calls,1);
   finish();
  }
  const result=JSON.parse((await execute(exe,['wait',prepared.draftId,'10'],{env,timeout:15000})).stdout);
  assert.equal(result.consultId,'standalone-one');assert.equal(calls,1);
  assert.equal(typeof(await(await fetch(local+'/bridge/v1/status',{headers})).json()).agentReceivedAt,'number');
 }finally{
  finish();
  if(bridgePid){
   try{process.kill(bridgePid,'SIGTERM');}catch{}
   // Windows keeps a running executable locked until process termination settles.
   for(let i=0;i<30;i++){
    try{process.kill(bridgePid,0);}catch{break;}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
  }
  if(remote){remote.closeAllConnections();await new Promise(r=>remote.close(r));}
  await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 }
});
}

test('standalone Consult keeps evidence, user decisions and unresolved questions bound to their own rounds', { skip: !binary }, async t => {
 const directory = await mkdtemp(join(tmpdir(), 'zesia-native-multiturn-'));
 const bridges = [];
 const submitted = [];
 const results = new Map();
 const token = 'synthetic-multiturn-token';
 const evidence = { id: 'evidence', kind: 'evidence', question: 'Which operation preserves the two labels?', blocking: true };
 const decision = { id: 'decision', kind: 'user_decision', question: 'Which label should appear first?', blocking: true };
 const unresolved = { id: 'unresolved', kind: 'clarification', question: 'Which missing archive contains the source?', blocking: true };
 const mediaType = 'application/vnd.zesia.consult+json';
 const remote = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  if (path === '/v1/consult/preflight') {
   response.end(JSON.stringify({ format: 'zesia.consult.preflight.v1', ok: true, modelCalls: 0 }));
   return;
  }
  if (path.startsWith('/v1/consult/requests/')) {
   const requestId = path.split('/')[4];
   const result = results.get(requestId);
   response.end(JSON.stringify(result ? { requestId, state: 'completed', result } : { requestId, state: 'running' }));
   return;
  }
  if (path !== '/a2a' || request.method !== 'POST' || request.headers.authorization !== 'Bearer ' + token) {
   response.writeHead(404).end('{}');
   return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rpc = JSON.parse(Buffer.concat(chunks));
  const message = rpc.params.message;
  const packet = message.parts[0].data;
  const requestId = request.headers['x-zesia-request-id'];
  const round = packet.context.continuation?.round || 1;
  const contextId = 'fixture-' + packet.project;
  const question = packet.project === 'unanswered' ? unresolved
   : packet.project === 'ordered-labels' ? [evidence, decision][round - 1] : undefined;
  const nextAction = { kind: question?.kind === 'evidence' ? 'supply_evidence' : question ? 'ask_user_decision' : 'apply_advice',
   blocking: Boolean(question), requests: question ? [question] : [] };
  const result = { format: 'zesia.consult.v0', requestId, consultId: 'reply-' + requestId,
   resultSchemaVersion: 'zesia.consult.result.v2', advice: 'Reviewed ' + packet.project,
   qualityStatus: 'complete_structure', deliveryKind: 'opinion', nextAction,
   a2a: { contextId, messageId: 'msg-' + requestId } };
  submitted.push({ method: rpc.method, contextId: message.contextId, packet, requestId, parentRequestId: request.headers['x-zesia-parent-request-id'] });
  results.set(requestId, result);
  response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { message: {
   role: 'ROLE_AGENT', ...result.a2a, parts: [{ data: result, mediaType }],
  } } }));
 });
 t.after(async () => {
  for (const pid of bridges) {
   try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  remote.closeAllConnections();
  await new Promise(done => remote.close(done));
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
 });
 await new Promise(done => remote.listen(0, '127.0.0.1', done));
 const destination = 'http://127.0.0.1:' + remote.address().port;
 const emptyPath = join(directory, 'empty');
 await mkdir(emptyPath);
 const env = {
  PATH: process.platform === 'win32' ? join(process.env.SystemRoot, 'System32') : emptyPath,
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, TEMP: tmpdir() } : {}),
  ZESIA_CONFIG: join(directory, 'config.json'),
  ZESIA_STATE_DIR: join(directory, 'state'),
 };
 const native = args => execute(resolve(binary), args, { env, cwd: directory, timeout: 15000 });
 const run = async (...args) => JSON.parse((await native(args)).stdout);
 const inputFile = join(directory, 'input.json');
 const provide = async (command, args, input) => {
  await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
  return run(command, ...args, inputFile);
 };
 const prepare = project => provide('prepare', [], { requester: 'Codex', project, brief: 'Review a synthetic report.',
  context: { materials: [{ id: 'original', content: 'Two source labels: A and B.' }] } });
 const followup = (draft, answers) => provide('followup', [draft.draftId], answers);
 const rejected = (promise, expected) => assert.rejects(promise, error => expected.test(error.stdout + error.stderr));
 async function review(draft) {
  const session = await run('review', draft.draftId, '--no-open');
  bridges.push(session.bridgePid);
  const url = new URL(session.url);
  assert.equal(url.origin + url.pathname, 'https://zesia.dev/consult');
  const fragment = new URLSearchParams(url.hash.slice(1));
  const bridge = 'http://127.0.0.1:' + fragment.get('port') + '/bridge/v1/';
  const headers = { Origin: url.origin, Authorization: 'Bearer ' + fragment.get('key'), 'Content-Type': 'application/json' };
  const binding = { protocolVersion: 1, draftId: draft.draftId, requestId: draft.requestId,
   approvedHash: draft.approvedHash, destination };
  return {
   async view() { return (await fetch(bridge + 'view', { headers })).json(); },
   post(action, overrides = {}) { return fetch(bridge + action, { headers, method: 'POST', body: JSON.stringify({ ...binding, ...overrides }) }); },
  };
 }
 async function complete(draft, window) {
  const count = submitted.length;
  assert.equal((await window.view()).status, 'prepared');
  assert.equal((await window.post('approve', { approvedHash: 'changed' })).status, 409);
  assert.equal(submitted.length, count);
  assert.equal((await window.post('approve')).status, 202);
  const result = await run('wait', draft.draftId, '8');
  assert.equal(result.status, 'completed');
  assert.ok([200, 202].includes((await window.post('approve')).status));
  assert.equal(submitted.length, count + 1);
  return result;
 }
 const tokenFile = join(directory, 'credential.json');
 await writeFile(tokenFile, JSON.stringify({ token }), { mode: 0o600 });
 await native(['configure', '--url', destination, '--token-file', tokenFile]);

 const first = await prepare('ordered-labels');
 assert.equal(submitted.length, 0);
 const firstWindow = await review(first);
 const firstResult = await complete(first, firstWindow);
 assert.equal(firstResult.nextAction.kind, 'supply_evidence');
 const answer = { requestId: evidence.id, text: 'The fixture preserves both labels.', sourceRef: 'fixture:lines-1-2' };
 const second = await followup(first, [answer]);
 assert.equal(submitted.length, 1);
 const secondWindow = await review(second);
 assert.deepEqual((await secondWindow.view()).packet.context.continuation.answers[0],
  { ...answer, question: evidence.question, sourceQuote: '' });
 const secondResult = await complete(second, secondWindow);
 assert.equal(secondResult.nextAction.kind, 'ask_user_decision');
 const choice = { requestId: decision.id, text: 'B first.', sourceRef: 'fixture:user-message-2', sourceQuote: 'Please put B first.' };
 await rejected(followup(second, [{ ...choice, sourceQuote: '' }]), /quote their answer/);
 const third = await followup(second, [choice]);
 assert.equal(submitted.length, 2);
 const thirdWindow = await review(third);
 const thirdResult = await complete(third, thirdWindow);
 assert.equal(thirdResult.nextAction.kind, 'apply_advice');
 assert.equal(thirdResult.followUpState.canStop, false);
 await rejected(followup(third, [choice]), /three-round limit/);
 assert.deepEqual(submitted.map(row => row.method), ['SendMessage', 'SendMessage', 'SendMessage']);
 for (const [index, previous] of [firstResult, secondResult].entries()) {
  const wire = submitted[index + 1];
  assert.equal(wire.contextId, firstResult.a2a.contextId);
  assert.equal(wire.parentRequestId, previous.requestId);
  assert.equal(wire.packet.context.continuation.previousConsultId, previous.consultId);
  assert.equal(wire.packet.context.continuation.round, index + 2);
 }
 assert.deepEqual(submitted[2].packet.context.continuation.answers[0], { ...choice, question: decision.question });

 const incomplete = await prepare('unanswered');
 const incompleteWindow = await review(incomplete);
 const pendingResult = await complete(incomplete, incompleteWindow);
 assert.notEqual(pendingResult.a2a.contextId, firstResult.a2a.contextId);
 await rejected(followup(incomplete, []), /Provide one to three answers/);
 await rejected(followup(incomplete, [answer]), /Unknown or duplicate follow-up question/);
 assert.equal((await incompleteWindow.view()).followUpState.canStop, true);
 assert.equal((await incompleteWindow.post('stop-follow-up')).status, 200);
 const retained = await run('result', incomplete.draftId);
 assert.equal(retained.consultId, pendingResult.consultId);
 assert.deepEqual(retained.followUp.requests, [unresolved]);
 assert.equal(retained.followUpState.stopped, true);
 assert.equal((await run('result', first.draftId)).followUpState.stopped, false);
 await rejected(followup(incomplete, [{ requestId: unresolved.id, text: 'Found it.', sourceRef: 'fixture:later' }]), /stopped by the user/);
 assert.equal(submitted.length, 4);

 const settled = await prepare('settled');
 const settledWindow = await review(settled);
 const settledResult = await complete(settled, settledWindow);
 assert.deepEqual(settledResult.followUp.requests, []);
 assert.equal((await settledWindow.view()).followUpState.canStop, false);
 assert.equal((await settledWindow.post('stop-follow-up')).status, 409);
});
