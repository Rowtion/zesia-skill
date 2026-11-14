import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortable } from './runtime.mjs';
const packet={requester:'Codex',project:'synthetic-review',brief:'Review the artifact publication order.',context:{goal:'Avoid a losing worker overwriting the winner.',materials:[{id:'code',content:'publish(); claimWinner();'}]}};
async function fixture(options={}){
 const stateDir=await mkdtemp(join(tmpdir(),'zesia-portable-test-'));let calls=0,preflights=0;
 const configuration=async()=>({url:'https://api.zesia.dev',token:'synthetic-test-only'});
 const runtime=createPortable({stateDir,configuration,preflight:async()=>{preflights++;return{ok:true,modelCalls:0};},consult:async args=>{calls++;return{format:'zesia.consult.v0',consultId:'c'+calls,advice:'Full independent advice.',decision:{assessment:'Full independent advice.',recommendation:'Publish an immutable per-run artifact.'},followUp:{requests:[{id:'q1',kind:'evidence',question:'Which storage operation is atomic?'}]},a2a:{contextId:args.contextId||'same-context'},qualityStatus:'complete_structure'};},...options});
 return{runtime,stateDir,counts:()=>({calls,preflights})};
}
test('portable preparation preserves actual requester and is private and local',async()=>{
 const f=await fixture(),d=await f.runtime.prepare(packet);assert.equal(d.packet.requester,'Codex');assert.deepEqual(f.counts(),{calls:0,preflights:0});assert.equal((await stat(join(f.stateDir,d.draftId+'.json'))).mode&0o777,0o600);
});
test('send refuses missing confirmation and a changed reviewed hash before any network request',async()=>{
 const f=await fixture(),d=await f.runtime.prepare(packet);await assert.rejects(f.runtime.send(d.draftId,d.approvedHash,''),/confirmation/);await assert.rejects(f.runtime.send(d.draftId,'changed','Send this packet.'),/hash mismatch/);assert.deepEqual(f.counts(),{calls:0,preflights:0});
});
test('concurrent requests claim one send and recover a compact local result without resending',async()=>{
 const f=await fixture(),d=await f.runtime.prepare(packet);const results=await Promise.all([f.runtime.send(d.draftId,d.approvedHash,'Send.'),f.runtime.send(d.draftId,d.approvedHash,'Send.')]);assert.equal(f.counts().calls,1);assert.ok(results.some(r=>r.ok));const r=await f.runtime.result(d.draftId);assert.equal(r.cached,true);assert.equal(r.decision.assessment,'Full independent advice.');assert.equal(r.packet,undefined);assert.equal(r.advice,'Full independent advice.');await f.runtime.send(d.draftId,d.approvedHash,'Send.');assert.equal(f.counts().calls,1);
});
test('follow-up carries original evidence and advice on the actual A2A context and requires another approval',async()=>{
 const f=await fixture(),d=await f.runtime.prepare(packet);await f.runtime.send(d.draftId,d.approvedHash,'Send.');const next=await f.runtime.followup(d.draftId,[{requestId:'q1',text:'Conditional create is atomic.',sourceRef:'tool:read'}]);assert.equal(next.packet.context.continuation.round,2);assert.equal(next.packet.context.continuation.answers[0].sourceQuote,'');assert.equal(next.packet.context.previousAdvice[0],'Full independent advice.');assert.equal(f.counts().calls,1);const r=await f.runtime.send(next.draftId,next.approvedHash,'Send the supplement.');assert.equal(r.a2a.contextId,'same-context');await assert.rejects(f.runtime.followup(d.draftId,[{requestId:'q1',text:'again',sourceRef:'tool:read'}]),/already exists/);
});
test('unknown delivery remains unknown across restarts and cannot be automatically sent again',async()=>{
 let calls=0;const f=await fixture({consult:async()=>{calls++;throw new Error('Connection closed after submission.');}}),d=await f.runtime.prepare(packet);const r=await f.runtime.send(d.draftId,d.approvedHash,'Send.');assert.equal(r.outcome,'unknown');const restarted=createPortable({stateDir:f.stateDir});await restarted.send(d.draftId,d.approvedHash,'Send.');assert.equal(calls,1);
});
test('preflight rejection makes zero paid requests and is returned with its usable details',async()=>{
 const f=await fixture({consult:async()=>{throw Object.assign(Error('Use a narrower question.'),{outcome:'not_started',details:{limit:100,used:150}})}}),d=await f.runtime.prepare(packet);const r=await f.runtime.send(d.draftId,d.approvedHash,'Send.');assert.equal(r.outcome,'not_started');assert.equal(r.details.limit,100);assert.equal(f.counts().calls,0);
});
