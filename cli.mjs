import {readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {createPortable} from './runtime.mjs';
import {startReview,openReviewBrowser} from './review/server.mjs';
import {launchReview} from './review/launch.mjs';
import {startOnlineReview,openOnlineBrowser} from './review/online.mjs';
import {launchOnlineReview} from './review/online-launch.mjs';
import {standalone,runtimeVersion} from './runtime/standalone.mjs';
import {dirname,resolve} from 'node:path';
const [command,id,hash,confirmationFile]=process.argv.slice(2);
const runtime=createPortable();
try {
  let value;
  if(command==='prepare')value=await runtime.prepare(JSON.parse(await readFile(id,'utf8')));
  else if(command==='send')value=await runtime.send(id,hash,await readFile(confirmationFile,'utf8'));
  else if(command==='result')value=await runtime.result(id,{markReceived:true});
  else if(command==='followup')value=await runtime.followup(id,JSON.parse(await readFile(hash,'utf8')));
  else if(command==='review'){
    if(hash && hash!=='--no-open')throw Error('Use review <draftId> [--no-open].');
    value=await launchOnlineReview(fileURLToPath(import.meta.url),id,{openBrowser:hash!=='--no-open'});
  }
  else if(command==='configure'){
    process.env.ZESIA_CONFIG=process.env.ZESIA_CONFIG||((await import('./runtime.mjs')).portableEnvironment()).ZESIA_CONFIG;
    process.argv.splice(2,1);await import('./scripts/configure-shared.mjs');
  }
  else if(command==='install'){
    const {install}=await import('./adapters/install.mjs');
    const source=resolve(dirname(standalone?process.execPath:fileURLToPath(import.meta.url)),'..');
    const host=JSON.parse(await readFile(resolve(source,'host.json'),'utf8'));
    if(standalone&&runtimeVersion&&host.runtimeVersion!==runtimeVersion)throw Error('The adapter requires a different immutable Runtime version.');
    let seed;try{await access(resolve(source,'bin'));seed=resolve(source,'bin');}catch{}
    value={ok:true,...await install({project:id||process.cwd(),source,host,cliSeedDirectory:seed,upgrade:hash==='--upgrade'})};
  }
  else if(command==='serve-online-review'){
    const session=await startOnlineReview({runtime,draftId:id,onlineOrigin:process.env.ZESIA_UI_ORIGIN||'https://zesia.dev'});
    process.once('SIGTERM',session.close);process.once('SIGINT',session.close);
    const opened=hash!=='--no-open'&&await openOnlineBrowser(session.url);
    value={ok:true,status:'awaiting_online_review',bridgePid:process.pid,draftId:id,url:session.url,browserOpened:opened,
      hint:'Review in the ZESIA online window. Materials remain local until approval. Use wait or result to receive the outcome; do not send from chat.'};
    if(process.send)process.send(value);else console.log(JSON.stringify(value));
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
    const seconds=hash===undefined?600:Number(hash);
    if(!Number.isFinite(seconds)||seconds<1||seconds>900)throw Error('Use wait <draftId> [seconds], between 1 and 900.');
    const until=Date.now()+seconds*1000;
    while(true){value=await runtime.result(id,{markReceived:true});if(value.status==='completed'||value.code==='cancelled'||value.retryAllowed===false||value.outcome||Date.now()>=until)break;await pause(500);}
    if(value.code==='result_unavailable')value={ok:true,status:value.status,draftId:id,pending:true,hint:'The local result is not ready. Use result later; do not send or prepare a duplicate.'};
  }
  else if(command==='--help')value={commands:['configure [--token-file <file>]','install <project> [--upgrade]','prepare <packet.json>','review <draftId> [--no-open]','wait <draftId> [seconds:1-900]','result <draftId>','followup <draftId> <answers.json>','send <draftId> <approvedHash> <confirmation.txt> (legacy explicit-confirmation interface)'],note:'Preparation is local. Use review for the shared zesia.dev window. Only its approval sends materials. Use the standalone executable when Node is unavailable; no administrator access.'};
  else throw Error('Unknown command. Run with --help.');
  if(['prepare','followup'].includes(command)&&value){delete value.packet;value.hint='Materials are prepared locally. Open review, then wait for the result. Do not paste or send the packet from chat.';}
  if(value!==undefined&&!['serve-review','serve-online-review'].includes(command))console.log(JSON.stringify(value,null,2));
  if(value?.ok===false)process.exitCode=1;
}catch(error){const value={ok:false,message:error.message,retryAllowed:false};if(process.send)process.send(value);else console.log(JSON.stringify(value));process.exitCode=1;}
