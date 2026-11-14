import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPortable} from '../runtime.mjs';
import {startReview} from '../review/server.mjs';
import {client} from '../review/surface.mjs';
const packet={requester:'Codex',project:'review-test',brief:'Review <script>alert("x")</script> publication.',context:{goal:'Prevent overwrites',materials:[{id:'publish.mjs',content:'publish(); claim();'}]}};
async function fixture(fn,options={}){
 const stateDir=await mkdtemp(join(tmpdir(),'zesia-review-test-'));let calls=0,preflights=0,session;
 const runtime=createPortable({stateDir,configuration:async()=>({url:'https://api.zesia.dev',token:'synthetic-private-token'}),preflight:async()=>{preflights++;return{ok:true};},consult:async()=>{calls++;return{consultId:'consult-1',decision:{assessment:'Independent assessment',recommendation:'Use immutable keys'},a2a:{contextId:'context-1'},qualityStatus:'partial'};},...options});
 try{const draft=await runtime.prepare(packet);session=await startReview({runtime,draftId:draft.draftId});const key=new URL(session.url).hash.slice(5);const headers={Authorization:'Bearer '+key,Origin:session.origin,'Content-Type':'application/json'};const request=(path,body,extra={})=>fetch(session.origin+path,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{}),...extra});await fn({runtime,draft,session,stateDir,headers,request,counts:()=>({calls,preflights})});}finally{session?.close();await rm(stateDir,{recursive:true,force:true});}
}
test('local review exposes exact materials only with a session capability and no cloud calls',()=>fixture(async({session,request,counts})=>{
 const page=await fetch(session.origin+'/');const html=await page.text();assert.equal(html.includes(packet.brief),false);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(html.includes('synthetic-private-token'),false);
 assert.equal((await fetch(session.origin+'/api/view')).status,403);const result=await(await request('/api/view')).json();assert.deepEqual(result.packet,packet);assert.equal(JSON.stringify(result).includes('synthetic-private-token'),false);assert.deepEqual(counts(),{calls:0,preflights:0});
}));
test('cross-origin, wrong Host, arbitrary destinations and changed hashes cannot approve a send',()=>fixture(async({session,request,draft,headers,counts})=>{
 assert.equal((await request('/api/send',{approvedHash:draft.approvedHash},{headers:{...headers,Origin:'https://evil.invalid'}})).status,403);
 const {request:rawRequest}=await import('node:http');const wrongHost=await new Promise((resolve,reject)=>{const q=rawRequest(session.origin+'/api/view',{headers:{...headers,Host:'evil.invalid'}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));});q.on('error',reject);q.end();});assert.equal(wrongHost,403);
 assert.equal((await request('/api/send',{approvedHash:draft.approvedHash},{headers:{Authorization:headers.Authorization,'Content-Type':'application/json'}})).status,403);
 assert.equal((await request('/api/send',{approvedHash:'changed'})).status,409);
 assert.equal((await request('/api/send',{approvedHash:draft.approvedHash,url:'https://evil.invalid'})).status,400);
 assert.equal((await request('/api/send',{approvedHash:draft.approvedHash,packet})).status,400);
 assert.equal((await request('/api/send',{approvedHash:draft.approvedHash,extra:'x'.repeat(2200)})).status,400);
 assert.deepEqual(counts(),{calls:0,preflights:0});
}));
test('browser approval sends once, survives refresh and returns the same local result to the agent',()=>fixture(async({request,draft,runtime,counts})=>{
 const result=await(await request('/api/send',{approvedHash:draft.approvedHash})).json();assert.equal(result.ok,true);assert.equal(result.decision.assessment,'Independent assessment');assert.equal(result.qualityStatus,'partial');
 assert.equal((await request('/api/send',{approvedHash:draft.approvedHash})).status,409);assert.equal((await(await request('/api/view')).json()).status,'completed');assert.deepEqual(counts(),{calls:1,preflights:0});assert.equal((await runtime.result(draft.draftId)).consultId,'consult-1');
}));
test('cancel persists across server sessions and direct CLI sends cannot bypass it',()=>fixture(async({request,draft,runtime,stateDir,counts})=>{
 assert.equal((await(await request('/api/cancel',{approvedHash:draft.approvedHash})).json()).status,'cancelled');const restarted=createPortable({stateDir});assert.equal((await restarted.send(draft.draftId,draft.approvedHash,'Send.')).status,'cancelled');assert.equal((await runtime.result(draft.draftId)).outcome,'not_started');assert.deepEqual(counts(),{calls:0,preflights:0});
}));
test('concurrent clicks and failed response transport never trigger a second consultation',()=>fixture(async({request,draft,counts})=>{
 const results=await Promise.all([request('/api/send',{approvedHash:draft.approvedHash}),request('/api/send',{approvedHash:draft.approvedHash})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await(await results.find(r=>r.status===200).json())).outcome,'unknown');assert.equal((await request('/api/send',{approvedHash:draft.approvedHash})).status,409);assert.equal(counts().preflights,0);
},{consult:async()=>{throw Error('Synthetic connection lost after submission');}}));
test('expired drafts cannot send and idle sessions shut down',()=>fixture(async({request,draft,session,runtime})=>{
 const view=await runtime.inspect(draft.draftId);assert.ok(view);let closed=false;const tiny=await startReview({runtime,draftId:draft.draftId,idleMs:15,lifetimeMs:50,onClose:()=>closed=true});await new Promise(r=>setTimeout(r,60));assert.equal(closed,true);await assert.rejects(fetch(tiny.origin+'/api/view'));
},{now:()=>Date.now()-16*60*1000}));
test('expired review approval is rejected before preflight',()=>fixture(async({request,draft,counts})=>{
 assert.equal((await request('/api/send',{approvedHash:draft.approvedHash})).status,410);assert.deepEqual(counts(),{calls:0,preflights:0});
},{now:()=>Date.now()-16*60*1000}));
test('browser rendering uses textContent, no HTML interpolation or external requests',()=>{
 assert.equal(/innerHTML|insertAdjacentHTML|document.write/.test(client),false);assert.match(client,/textContent=packet.brief/);assert.match(client,/history.replaceState/);assert.equal(/https:\/\//.test(client),false);new Function(client);
});

test('local review uses the actual official A2A CLI and preserves follow-up context',async()=>{
 const {createServer}=await import('node:http');const {consultOverA2A}=await import('../runtime/a2a.mjs');
 const stateDir=await mkdtemp(join(tmpdir(),'zesia-review-a2a-'));let received=[];
 const remote=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);res.setHeader('content-type','application/json');
 if(req.url==='/v1/consult/preflight')return res.end(JSON.stringify({format:'zesia.consult.preflight.v1',ok:true,modelCalls:0}));
 received.push(input);res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{message:{messageId:'reply-'+received.length,contextId:'review-context',role:'ROLE_AGENT',parts:[{mediaType:'application/vnd.zesia.consult+json',data:{format:'zesia.consult.v0',consultId:'c'+received.length,advice:'Use immutable publication.',followUp:{requests:[{id:'q1',kind:'evidence',question:'Which operation claims publication?'}]}}}]}}}));});
 await new Promise(r=>remote.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+remote.address().port;const runtime=createPortable({stateDir,configuration:async()=>({url,token:'synthetic-test-token'})});const sessions=[];
 try{
 const initial=await runtime.prepare(packet);assert.equal(received.length,0);
 async function approve(draft){const s=await startReview({runtime,draftId:draft.draftId});sessions.push(s);const response=await fetch(s.origin+'/api/send',{method:'POST',headers:{Origin:s.origin,Authorization:'Bearer '+new URL(s.url).hash.slice(5),'Content-Type':'application/json'},body:JSON.stringify({approvedHash:draft.approvedHash})});assert.equal((await response.json()).ok,true);}
 await approve(initial);const next=await runtime.followup(initial.draftId,[{requestId:'q1',text:'The object store supports conditional creates.',sourceRef:'tool:storage-docs'}]);assert.equal(received.length,1);await approve(next);assert.equal(received.length,2);assert.equal(received[1].params.message.contextId,'review-context');assert.equal(received[1].params.message.parts[0].data.context.continuation.round,2);assert.equal((await runtime.result(next.draftId)).a2a.contextId,'review-context');
 }finally{sessions.forEach(s=>s.close());remote.closeAllConnections();await new Promise(r=>remote.close(r));await rm(stateDir,{recursive:true,force:true});}
});
