import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {page, style, client, logo} from './surface.mjs';

const equal = (a,b) => typeof a==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const errorValue = error => ({ok:false,message:error.message,retryAllowed:false});
export async function startReview({runtime,draftId,idleMs=5*60*1000,lifetimeMs=15*60*1000,onClose=()=>{}}) {
  // Read only the already-prepared draft; never load arbitrary paths or credentials for the page.
  await runtime.inspect(draftId);
  const capability=randomBytes(32).toString('base64url');
  let origin, busy=false, closed=false, lastActivity=Date.now();
  const started=Date.now();
  function reply(res,status,value,type='application/json; charset=utf-8') {
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer',
      'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
    res.end(type.startsWith('application/json')?JSON.stringify(value):value);
  }
  async function body(req) {
    if(req.headers['content-type']!=='application/json')throw Error('Expected application/json.');
    let bytes=0,parts=[];for await(const part of req){bytes+=part.length;if(bytes>2048)throw Error('Request body exceeds 2 KiB.');parts.push(part);}
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  }
  const server=createServer(async(req,res)=>{
    try {
      if(closed || req.headers.host!==new URL(origin).host)return reply(res,403,{ok:false,message:'Invalid local session host.'});
      if(req.headers.origin && req.headers.origin!==origin)return reply(res,403,{ok:false,message:'Cross-origin access refused.'});
      if(req.method==='GET' && ['/','/app.js','/style.css','/logo.svg'].includes(req.url)) {
        const resources={'/':[page,'text/html; charset=utf-8'],'/app.js':[client,'text/javascript; charset=utf-8'],'/style.css':[style,'text/css; charset=utf-8'],'/logo.svg':[logo,'image/svg+xml']};
        return reply(res,200,...resources[req.url]);
      }
      if(!equal(req.headers.authorization,'Bearer '+capability))return reply(res,403,{ok:false,message:'This local session is not authorized.'});
      lastActivity=Date.now();
      if(req.method==='GET' && req.url==='/api/view') {
        const view=await runtime.inspect(draftId);
        return reply(res,200,{...view,requestInProgress:busy});
      }
      if(req.method!=='POST'||!['/api/send','/api/cancel'].includes(req.url))return reply(res,404,{ok:false,message:'Unknown session operation.'});
      if(req.headers.origin!==origin)return reply(res,403,{ok:false,message:'A same-origin browser action is required.'});
      const input=await body(req);
      if(Object.keys(input).some(key=>key!=='approvedHash') || typeof input.approvedHash!=='string')return reply(res,400,{ok:false,message:'Only the reviewed hash is accepted.'});
      if(busy)return reply(res,409,{ok:false,message:'A request is already in progress. Read its result; do not resend.'});
      busy=true;
      try {
      const view=await runtime.inspect(draftId);
      if(view.approvedHash!==input.approvedHash)return reply(res,409,{ok:false,message:'The reviewed materials changed. Nothing was sent.'});
      if(view.status!=='prepared')return reply(res,409,{ok:false,message:'This draft is already used or cancelled. Read its result.'});
      if(Date.now()>Date.parse(view.expiresAt))return reply(res,410,{ok:false,message:'This draft expired. Ask your agent to prepare a new review.'});
      if(req.url==='/api/cancel')return reply(res,200,await runtime.cancel(draftId,input.approvedHash));
        // The page cannot supply a packet, service URL, trial token or agent-authored approval.
        // A same-origin explicit click approves exactly this immutable stored draft.
        return reply(res,200,await runtime.send(draftId,input.approvedHash,'Confirmed in the local ZESIA review window.'));
      }finally{busy=false;}
    }catch(error){if(!res.headersSent)reply(res,400,errorValue(error));else res.end();}
  });
  server.requestTimeout=10000;server.headersTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  function close(){if(closed)return;closed=true;clearInterval(timer);server.close();server.closeIdleConnections();onClose();}
  const timer=setInterval(()=>{if(!busy && (Date.now()-lastActivity>idleMs || Date.now()-started>lifetimeMs))close();},Math.min(1000,idleMs,lifetimeMs));
  return {url:origin+'/#key='+capability,origin,close};
}

export function openReviewBrowser(url) {
  const platform=process.platform;
  const command=platform==='darwin'?'open':platform==='win32'?'rundll32.exe':'xdg-open';
  const args=platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
  return new Promise(resolve=>{
    const child=spawn(command,args,{stdio:'ignore',windowsHide:true});
    const timer=setTimeout(()=>{child.unref();resolve(false);},5000);timer.unref?.();
    child.once('error',()=>{clearTimeout(timer);resolve(false);});child.once('exit',code=>{clearTimeout(timer);resolve(code===0);});
  });
}
