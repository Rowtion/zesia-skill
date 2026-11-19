import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';

export const ONLINE_PROTOCOL=1;
export const ONLINE_ORIGINS=Object.freeze(['https://zesia.dev','https://zesia-public-staging.cprindex.workers.dev']);
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const approvalKeys=['approvedHash','destination','draftId','protocolVersion','requestId'];
const configureKeys=['destination','protocolVersion','token'];
const profileKeys=['expectedUpdatedAt','id','protocolVersion','statementId'];
export async function startOnlineReview({runtime,draftId,onlineOrigin='https://zesia.dev',idleMs=24*60*60_000,lifetimeMs=24*60*60_000,onClose=()=>{},onGuideView}){
 if(!ONLINE_ORIGINS.includes(onlineOrigin))throw Error('The online review origin is not supported.');
 const initial=await runtime.inspect(draftId);
 if(!initial.requestId)throw Error('This older draft cannot use online review. Prepare and review a new draft.');
 const capability=randomBytes(32).toString('base64url');
 let host,busy=false,closed=false,lastActivity=Date.now(),lastError=null;
 const started=Date.now();
 function reply(res,status,value){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','pragma':'no-cache','referrer-policy':'no-referrer','x-content-type-options':'nosniff','access-control-allow-origin':onlineOrigin,'vary':'Origin'});
  res.end(JSON.stringify(value));
 }
 async function body(req){
  if(req.headers['content-type']!=='application/json')throw Error('Expected application/json.');
  const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>8192)throw Error('The payload exceeds 8 KiB.');chunks.push(part);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }
 async function view(compact=false){
  const recovered=busy?null:await runtime.recover?.(draftId).catch(()=>{});
  const data=await runtime.inspect(draftId,{compact});
  // Surface the cloud observation without changing the durable local checkpoint.
  const requestInProgress=busy||(data.status==='unknown'&&recovered?.recoveryState==='running');
  return {...data,compactStatus:true,protocolVersion:ONLINE_PROTOCOL,requestInProgress,
   ...(!compact&&typeof runtime.setProfile==='function'&&data.profile?{profileWriteVersion:1}:{}),...(lastError?{bridgeError:lastError}:{}),resultRetentionSeconds:86400};
 }
 const server=createServer(async(req,res)=>{
  try{
   if(closed||req.headers.host!==host||req.headers.origin!==onlineOrigin)return reply(res,403,{ok:false,message:'This review connection is not authorized.'});
   if(req.method==='OPTIONS'){
    const headers=String(req.headers['access-control-request-headers']||'').toLowerCase().split(',').map(v=>v.trim()).filter(Boolean);
    if(!['GET','POST'].includes(req.headers['access-control-request-method'])||headers.some(v=>!['authorization','content-type'].includes(v)))return reply(res,403,{ok:false,message:'This bridge operation is not allowed.'});
    res.setHeader('access-control-allow-methods','GET, POST');res.setHeader('access-control-allow-headers','Authorization, Content-Type');
    res.setHeader('access-control-max-age','0');
    if(req.headers['access-control-request-private-network']==='true')res.setHeader('access-control-allow-private-network','true');
    return reply(res,204,null);
   }
   if(!equal(req.headers.authorization,'Bearer '+capability))return reply(res,403,{ok:false,message:'This review session has expired or is not authorized.'});
   if(Date.now()-lastActivity>idleMs||(!busy&&Date.now()-started>lifetimeMs))return reply(res,410,{ok:false,message:'This review connection expired (24h limit). Reopen it from your agent.'});
   lastActivity=Date.now();
   if(req.method==='GET'&&req.url==='/bridge/v1/status?compact=1')return reply(res,200,await view(true));
   if(req.method==='GET'&&['/bridge/v1/view','/bridge/v1/status'].includes(req.url)){
    const current=await view();
    if(req.url==='/bridge/v1/view'&&current.status==='onboarding')await onGuideView?.();
    return reply(res,200,current);
   }
   if(initial.status==='onboarding'&&req.method==='POST'&&req.url!=='/bridge/v1/configure')
    return reply(res,404,{ok:false,message:'Only sign-in is available in the installation guide.'});
   if(req.method!=='POST'||!['/bridge/v1/approve','/bridge/v1/cancel','/bridge/v1/configure','/bridge/v1/profile','/bridge/v1/stop-follow-up'].includes(req.url))return reply(res,404,{ok:false,message:'Unknown bridge operation.'});
   const input=await body(req);
   if(req.url==='/bridge/v1/profile'){
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==profileKeys.join(',')
      ||typeof input.statementId!=='string'||!input.statementId||input.statementId.length>100
      ||(input.expectedUpdatedAt!==null&&typeof input.expectedUpdatedAt!=='string'))
      return reply(res,400,{ok:false,message:'Select a statement and a Profile slot from this review.'});
    if(input.protocolVersion!==ONLINE_PROTOCOL)return reply(res,400,{ok:false,message:'Unsupported bridge protocol version.'});
    if(typeof runtime.setProfile!=='function')return reply(res,501,{ok:false,message:'Profile updates are not supported by this runtime.'});
    const current=await runtime.inspect(draftId);
    if(busy||!['prepared','completed'].includes(current.status)||
      (current.status==='prepared'&&Date.now()>Date.parse(current.expiresAt)))
      return reply(res,409,{ok:false,message:'Open a current review or completed result to save a constraint.'});
    const statement=current.packet?.context?.statements?.find(item=>item.id===input.statementId);
    if(statement?.kind!=='constraint'||statement.origin!=='user_statement'||
      statement.sourceRef.startsWith('zesia:profile:')||!statement.sourceQuote.trim())
      return reply(res,400,{ok:false,message:'Choose a constraint with the original user quote in this review.'});
    await runtime.setProfile({
      id:input.id,text:statement.text,sourceQuote:statement.sourceQuote,origin:statement.origin,
      expectedUpdatedAt:input.expectedUpdatedAt,
    });
    return reply(res,200,await view());
   }
   if(req.url==='/bridge/v1/configure'){
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==configureKeys.join(','))return reply(res,400,{ok:false,message:'Invalid configuration payload.'});
    if(input.protocolVersion!==ONLINE_PROTOCOL)return reply(res,400,{ok:false,message:'Unsupported bridge protocol version.'});
    if(typeof runtime.configure!=='function')return reply(res,501,{ok:false,message:'Bridge configuration is not supported.'});
    const current=await runtime.inspect(draftId);
    let targetDestination;
    try{targetDestination=new URL(input.destination).origin;}catch{return reply(res,400,{ok:false,message:'Invalid configuration destination.'});}
    if(targetDestination!==current.destination)return reply(res,409,{ok:false,message:'Activation destination does not match the prepared request.'});
    await runtime.configure({destination:targetDestination,token:input.token,draftId});
    lastError=null;
    return reply(res,200,await view());
   }
   if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!==approvalKeys.join(','))return reply(res,400,{ok:false,message:'Only the exact reviewed approval is accepted.'});
   const current=await runtime.inspect(draftId);
   if(input.protocolVersion!==ONLINE_PROTOCOL||input.draftId!==draftId||input.requestId!==current.requestId||input.approvedHash!==current.approvedHash||input.destination!==current.destination)return reply(res,409,{ok:false,message:'The reviewed request changed. Nothing new was sent.'});
   if(req.url==='/bridge/v1/stop-follow-up'){
    if(typeof runtime.stopFollowUp!=='function')return reply(res,501,{ok:false,message:'Stopping further rounds is not supported by this runtime.'});
    if(!current.followUpState?.canStop&&!current.followUpState?.stopped)
     return reply(res,409,{ok:false,message:'There are no further rounds to stop in this review.'});
    const followUpState=await runtime.stopFollowUp(draftId);
    return reply(res,200,{ok:true,followUpState});
   }
   if(busy)return reply(res,202,{ok:true,status:'sending',requestId:current.requestId,requestInProgress:true});
   if(current.status!=='prepared')return reply(res,200,await view());
   if(req.url==='/bridge/v1/approve'&&current.followUpState?.stopped)
    return reply(res,409,{ok:false,message:'Further rounds are stopped. This draft was not sent.'});
   if(Date.now()>Date.parse(current.expiresAt))return reply(res,410,{ok:false,message:'These materials expired. Ask your agent to prepare a new review.'});
   if(req.url==='/bridge/v1/cancel')return reply(res,200,await runtime.cancel(draftId,input.approvedHash));
   busy=true;lastError=null;
   // A short acknowledgement separates accepting the click from completing cloud
   // inference. Closing the page never cancels or repeats this execution.
   Promise.resolve().then(()=>runtime.send(draftId,input.approvedHash,'Approved in the ZESIA online review window.')).catch(error=>{lastError=error.message;}).finally(()=>{busy=false;lastActivity=Date.now();});
   return reply(res,202,{ok:true,status:'sending',requestId:current.requestId,requestInProgress:true});
  }catch(error){if(!res.headersSent)reply(res,400,{ok:false,message:error.message,retryAllowed:false});else res.end();}
 });
 server.requestTimeout=10000;server.headersTimeout=5000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 host='127.0.0.1:'+server.address().port;
 function close(){if(closed)return;closed=true;clearInterval(timer);server.close();server.closeAllConnections();onClose();}
 const timer=setInterval(()=>{if(!busy&&(Date.now()-lastActivity>idleMs||Date.now()-started>lifetimeMs))close();},Math.min(1000,idleMs,lifetimeMs));
 const fragment=new URLSearchParams({v:String(ONLINE_PROTOCOL),port:String(server.address().port),key:capability});
 return {url:onlineOrigin+'/consult#'+fragment.toString(),origin:onlineOrigin,port:server.address().port,close};
}

export function openOnlineBrowser(url){
 const command=process.platform==='darwin'?'open':process.platform==='win32'?'rundll32.exe':'xdg-open';
 const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
 return new Promise(resolve=>{const child=spawn(command,args,{stdio:'ignore',windowsHide:true});const timer=setTimeout(()=>{child.unref();resolve(false);},5000);timer.unref?.();child.once('error',()=>{clearTimeout(timer);resolve(false);});child.once('exit',code=>{clearTimeout(timer);resolve(code===0);});});
}
