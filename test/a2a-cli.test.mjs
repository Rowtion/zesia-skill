import test from 'node:test';import assert from 'node:assert/strict';import{createServer}from'node:http';import{consultOverA2A}from'../runtime/a2a.mjs';
const input={requester:'Codex',project:'synthetic-cli-check',brief:'Review a commit order.',context:{goal:'Avoid duplicate publication.'}};
const jsonMessage=(messageId='reply-1',contextId='ctx-1')=>({jsonrpc:'2.0',id:1,result:{message:{messageId,contextId,role:'ROLE_AGENT',parts:[{mediaType:'application/vnd.zesia.consult+json',data:{format:'zesia.consult.v0',advice:'Publish only after the commit fence.',consultId:'c1',followUp:{requests:[]}}}]}}});
test('actual official CLI carries the exact packet, labels and continuity through the guard',async()=>{
 let calls=0;const result=await consultOverA2A({url:'https://consult.example',token:'synthetic-cli-secret',input,contextId:'ctx-1',clientRequestId:'request-1',fetch:async(url,init)=>{calls++;assert.equal(url,'https://consult.example/a2a');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer synthetic-cli-secret');const rpc=JSON.parse(init.body);assert.equal(rpc.method,'SendMessage');assert.deepEqual(rpc.params.configuration.acceptedOutputModes,['application/vnd.zesia.consult+json']);assert.deepEqual(rpc.params.message.parts[0].data,input);assert.equal(rpc.params.message.messageId,'request-1');assert.equal(rpc.params.message.contextId,'ctx-1');return Response.json({...jsonMessage(),id:rpc.id});}});
 assert.equal(calls,1);assert.equal(result.consultId,'c1');assert.equal(result.a2a.contextId,'ctx-1');
});
test('guard rejects upstream redirects without forwarding real credentials or retrying',async()=>{
 let sent=0;const sink=createServer((q,s)=>{sent++;s.end('{}');});await new Promise(r=>sink.listen(0,'127.0.0.1',r));let first=0;const redirect=createServer((q,s)=>{first++;s.writeHead(307,{location:'http://127.0.0.1:'+sink.address().port+'/a2a'});s.end();});await new Promise(r=>redirect.listen(0,'127.0.0.1',r));
 try{await assert.rejects(consultOverA2A({url:'http://127.0.0.1:'+redirect.address().port,token:'synthetic-secret',input}),e=>e.outcome==='unknown'&&e.retryAllowed===false);assert.equal(first,1);assert.equal(sent,0);}finally{sink.closeAllConnections();redirect.closeAllConnections();await Promise.all([new Promise(r=>sink.close(r)),new Promise(r=>redirect.close(r))]);}
});
test('unknown transport outcomes never cause a second upstream request',async()=>{
 let calls=0;await assert.rejects(consultOverA2A({url:'https://consult.example',token:'synthetic-secret',input,fetch:async()=>{calls++;throw Error('Lost connection after request');}}),e=>e.outcome==='unknown'&&e.retryAllowed===false);assert.equal(calls,1);
});
test('actual CLI consultation works with the original Node 20 cancellation API surface',async()=>{const any=AbortSignal.any;let calls=0;try{AbortSignal.any=undefined;const result=await consultOverA2A({url:'https://consult.example',token:'synthetic-cli-secret',input,fetch:async(url,init)=>{calls++;return Response.json({...jsonMessage(),id:JSON.parse(init.body).id});}});assert.equal(result.consultId,'c1');assert.equal(calls,1);}finally{AbortSignal.any=any;}});

test('single A2A submission preserves input rejection diagnostics', async () => {
 const diagnostic={ok:false,issues:[{field:'brief',limit:100,used:150}]};
 let calls=0;
 const fetch=async (_url,init)=>{
  calls++;
  return Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,error:{code:-32602,message:'Invalid input',data:[{
   '@type':'type.googleapis.com/google.rpc.ErrorInfo',domain:'a2a-protocol.org',
   metadata:{diagnostic:JSON.stringify(diagnostic)}
  }]}});
 };
 await assert.rejects(consultOverA2A({url:'https://consult.example',token:'synthetic-token',input,fetch}),error=>{
  assert.equal(error.outcome,'not_started');
  assert.deepEqual(error.details.preflight,diagnostic);
  return true;
 });
 assert.equal(calls,1);
});
