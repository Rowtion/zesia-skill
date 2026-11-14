import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import assert from 'node:assert/strict';
import {destinationOf} from './config.mjs';
import {deadlineFor} from './deadline.mjs';
import {executableA2A} from './standalone.mjs';
export {CONSULT_MEDIA_TYPE, A2A_PROTOCOL_VERSION} from './contract.mjs';
import {CONSULT_MEDIA_TYPE} from './contract.mjs';
const execute=promisify(execFile);
const MAX_RESPONSE=4*1024*1024;
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const hash=value=>createHash('sha256').update(canonical(value)).digest();
const parse=text=>{try{return JSON.parse(text);}catch{return {};}};
function remoteError(payload,status){
 const body=payload?.error;const info=body?.data?.find?.(r=>r?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo'&&r.domain==='a2a-protocol.org');
 const metadata=info?.metadata||{};
 const failure=parse(metadata.failure||'{}')||{};
 const diagnostic=metadata.diagnostic?parse(metadata.diagnostic):failure.preflight;
 const rejected=metadata.outcome==='not_started'||failure.outcome==='not_started'||diagnostic?.ok===false||body?.data?.outcome==='not_started';
 return Object.assign(new Error(typeof body==='string'?body:body?.message||'The consultation request did not complete.'),{
   code:metadata.consultCode||body?.data?.reason||'consult_transport_error',status,metadata,
   outcome:rejected?'not_started':'unknown',retryAllowed:false,
   details:{...failure,...(diagnostic?{preflight:diagnostic}:{})},
 });
}
async function bounded(response){const text=await response.text();if(Buffer.byteLength(text)>MAX_RESPONSE)throw Error('The consultation response exceeded the size limit.');return parse(text);}
export async function preflightConsult({url,token,input,signal,fetch:transport=fetch}){
 const response=await transport(new URL('/v1/consult/preflight',destinationOf(url)),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal});const value=await bounded(response);
 if(!response.ok)throw Object.assign(new Error('Preflight could not be completed.'),{code:response.status===401?'authentication_failed':'preflight_unavailable',...(value.ok===false&&value.code?{failure:value}:{})});
 if(value.format!=='zesia.consult.preflight.v1'||typeof value.ok!=='boolean'||value.modelCalls!==0)throw Object.assign(Error('Invalid preflight response.'),{code:'preflight_unavailable'});return value;
}
/** Official CLI owns A2A serialization. An ephemeral local guard owns credentials and one fixed upstream request. */
export async function consultOverA2A({url,token,input,contextId,clientRequestId,requestId,signal,fetch:transport=fetch,onStage=()=>{},cliBinary=process.env.ZESIA_A2A_CLI||executableA2A()||fileURLToPath(new URL('../bin/a2a'+(process.platform==='win32'?'.exe':''),import.meta.url))}){
 if(requestId!==undefined&&!/^zrq-\d{13}-[a-f0-9-]{36}$/.test(requestId))throw Error('Invalid recoverable request ID.');
 const origin=destinationOf(url);assert.ok(typeof token==='string'&&token&&!/[\s\x00-\x1f\x7f]/u.test(token),'Configure a valid Zesia token.');
 if(clientRequestId!==undefined&&(typeof clientRequestId!=='string'||!clientRequestId||clientRequestId.length>200))throw Error('Invalid client request ID.');
 const message={messageId:clientRequestId||randomUUID(),role:'ROLE_USER',...(contextId?{contextId}:{}),parts:[{data:input,mediaType:CONSULT_MEDIA_TYPE}]};
 const expected=hash(message);const temporary=await mkdtemp(join(tmpdir(),'zesia-a2a-'));const nonce=randomUUID();let attempts=0,upstream,upstreamStatus;
 let deadline;
 const server=createServer(async(request,response)=>{
  try{
   if(request.method!=='POST'||request.url!=='/a2a'||request.headers.authorization!==`Bearer ${nonce}`){response.writeHead(403);response.end('{}');return;}
   let size=0;const chunks=[];for await(const chunk of request){size+=chunk.length;if(size>160*1024)throw Error('CLI request exceeded the input limit.');chunks.push(chunk);}
   const body=JSON.parse(Buffer.concat(chunks).toString());
   if(body.method!=='SendMessage'||!timingSafeEqual(hash(body.params?.message),expected)||attempts!==0){response.writeHead(409);response.end('{}');return;}
   attempts++;onStage('cloud_consultation');
   const remote=await transport(origin+'/a2a',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','a2a-version':'1.0',...(requestId?{'x-zesia-request-id':requestId}:{})},body:JSON.stringify(body),redirect:'error',signal:deadline.signal});
   upstreamStatus=remote.status;upstream=await bounded(remote);
   response.writeHead(remote.status,{'content-type':'application/json'});response.end(JSON.stringify(upstream));
  }catch{response.writeHead(502,{'content-type':'application/json'});response.end(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32603,message:'The fixed consultation endpoint did not return a usable response.'}}));}
 });
 try{
  deadline=deadlineFor(signal);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const endpoint='http://127.0.0.1:'+server.address().port+'/a2a';
  await writeFile(join(temporary,'request.json'),JSON.stringify({message,configuration:{acceptedOutputModes:[CONSULT_MEDIA_TYPE]}}),{mode:0o600});
  // Only a disposable loopback nonce reaches the CLI. The real token never enters CLI args, files or environment.
  await writeFile(join(temporary,'config.json'),JSON.stringify({auth:`Bearer ${nonce}`,'credential-helper':[],'plugins-enabled':false}),{mode:0o600});
  const allowed=new Set(['PATH','Path','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','SSL_CERT_FILE','SSL_CERT_DIR']);
  const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.has(k)));
  let result;
  try{result=await execute(cliBinary,['send','--endpoint',endpoint,'--transport','jsonrpc','--request-payload',join(temporary,'request.json'),'--config',join(temporary,'config.json'),'--a2a-version','1.0','--timeout','60s','--output','json'],{cwd:temporary,env,signal:deadline.signal,maxBuffer:6*1024*1024,timeout:65000,windowsHide:true});}
  catch(error){if(upstream?.error)throw remoteError(upstream,upstreamStatus);throw Object.assign(new Error(attempts?'Consultation outcome is unknown. Do not retry automatically.':'The bundled A2A CLI could not start.'),{outcome:attempts?'unknown':'not_started',retryAllowed:false,cause:error.code});}
  if(upstream?.error)throw remoteError(upstream,upstreamStatus);
  const reply=parse(result.stdout).message;const data=reply?.parts?.find(p=>p.mediaType===CONSULT_MEDIA_TYPE&&p.data)?.data;
  if(!data||data.format!=='zesia.consult.v0'||typeof data.advice!=='string')throw Object.assign(Error('Expected a structured consultation message.'),{outcome:attempts?'unknown':'not_started',retryAllowed:false});
  if(contextId&&reply.contextId!==contextId)throw Error('The consultation response lost its context continuity.');
  return {...data,a2a:{...data.a2a,contextId:reply.contextId,messageId:reply.messageId}};
 }finally{deadline?.dispose();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});}
}

export async function recoverConsult({url,token,requestId,signal,fetch:transport=fetch}) {
 if(!/^zrq-\d{13}-[a-f0-9-]{36}$/.test(requestId||''))throw Error('Invalid recoverable request ID.');
 const response=await transport(destinationOf(url)+'/v1/consult/requests/'+requestId,{headers:{authorization:'Bearer '+token},redirect:'error',signal});
 const value=await bounded(response);
 if(!response.ok)throw Object.assign(Error(response.status===404?'No saved result is available yet.':'The saved consultation could not be read.'),{status:response.status,retryAllowed:false});
 if(value.requestId!==requestId||typeof value.state!=='string')throw Error('Invalid saved consultation response.');
 return value;
}
