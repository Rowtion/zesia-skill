import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {createPortable} from './runtime.mjs';
import {startReview,openReviewBrowser} from './review/server.mjs';
import {launchReview} from './review/launch.mjs';
const [command,id,hash,confirmationFile]=process.argv.slice(2);
const runtime=createPortable();
try {
  let value;
  if(command==='prepare')value=await runtime.prepare(JSON.parse(await readFile(id,'utf8')));
  else if(command==='send')value=await runtime.send(id,hash,await readFile(confirmationFile,'utf8'));
  else if(command==='result')value=await runtime.result(id);
  else if(command==='followup')value=await runtime.followup(id,JSON.parse(await readFile(hash,'utf8')));
  else if(command==='review'){
    if(hash && hash!=='--no-open')throw Error('Use review <draftId> [--no-open].');
    value=await launchReview(fileURLToPath(import.meta.url),id,{openBrowser:hash!=='--no-open'});
  }
  else if(command==='serve-review'){
    const session=await startReview({runtime,draftId:id});
    process.once('SIGTERM',session.close);process.once('SIGINT',session.close);
    const opened=hash!=='--no-open' && await openReviewBrowser(session.url);
    value={ok:true,status:'awaiting_browser_review',draftId:id,url:session.url,browserOpened:opened,
      hint:'Review and confirm in this local window. Read result or wait to retrieve the outcome; do not send this draft from chat.'};
    if(process.send)process.send(value);else console.log(JSON.stringify(value));
  }
  else if(command==='wait'){
    const seconds=hash===undefined?60:Number(hash);
    if(!Number.isFinite(seconds)||seconds<1||seconds>120)throw Error('Use wait <draftId> [seconds], between 1 and 120.');
    const until=Date.now()+seconds*1000;
    while(true){value=await runtime.result(id);if(value.status==='completed'||value.code==='cancelled'||value.retryAllowed===false||value.outcome||Date.now()>=until)break;await pause(500);}
    if(value.code==='result_unavailable')value={ok:true,status:value.status,draftId:id,pending:true,hint:'The local result is not ready. Use result later; do not send or prepare a duplicate.'};
  }
  else if(command==='--help')value={commands:['prepare <packet.json>','review <draftId> [--no-open]','wait <draftId> [seconds:1-120]','result <draftId>','followup <draftId> <answers.json>','send <draftId> <approvedHash> <confirmation.txt> (chat-only fallback)'],note:'Preparation is local. Use review for a read-only local browser window. Only its explicit confirmation sends materials. Node.js >=20; no administrator access.'};
  else throw Error('Unknown command. Run with --help.');
  if(command!=='serve-review')console.log(JSON.stringify(value,null,2));
  if(value.ok===false)process.exitCode=1;
}catch(error){const value={ok:false,message:error.message,retryAllowed:false};if(process.send)process.send(value);else console.log(JSON.stringify(value));process.exitCode=1;}
