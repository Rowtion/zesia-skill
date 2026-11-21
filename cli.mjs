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
  else if(command==='result'){
    if(hash && hash!=='--defer-receipt')throw Error('Use result <draftId> [--defer-receipt].');
    value=await runtime.result(id,{markReceived:hash!=='--defer-receipt'});
  }
  else if(command==='receipt'){
    const result=await runtime.result(id,{markReceived:true});
    if(result.status!=='completed'||!result.agentReceivedAt)throw Error('The result is not ready for a receipt.');
    value={ok:true,draftId:id,agentReceivedAt:result.agentReceivedAt};
  }
  else if(command==='diagnose')value=await runtime.diagnose(id);
  else if(command==='list')value=await runtime.list();
  else if(command==='clean'){
    const args=process.argv.slice(3);
    const apply=args.includes('--apply');
    const all=args.includes('--all');
    const daysIdx=args.indexOf('--days');
    const retentionDays=daysIdx!==-1?Number(args[daysIdx+1]):7;
    value=await runtime.clean({apply,all,retentionDays});
  }
  else if(command==='followup')value=await runtime.followup(id,JSON.parse(await readFile(hash,'utf8')));
  else if(command==='profile'){
    const args=process.argv.slice(3);
    const sub=args[0];
    if(!sub||sub==='export'){
      if(args.length>1)throw Error('Use: zesia profile [export].');
      process.stdout.write(await runtime.profileMarkdown());
    }else if(sub==='set'){
      if(args.length!==5||args[3]!=='--quote')throw Error('Use: zesia profile set <id> "<text>" --quote "<sourceQuote>".');
      value=await runtime.setProfile({id:args[1],text:args[2],sourceQuote:args[4]});
    }else if(sub==='rm'){
      if(args.length!==2||!args[1])throw Error('Use: zesia profile rm <id>.');
      value=await runtime.removeProfile(args[1]);
    }else throw Error('Use: zesia profile [export | set <id> "<text>" --quote "<sourceQuote>" | rm <id>].');
  }
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
    const args=process.argv.slice(3);
    const upgrade=args.includes('--upgrade');
    const projIdx=args.indexOf('--project');
    let project=null;
    if(projIdx!==-1){
      project=args[projIdx+1];
      if(!project||project.startsWith('--'))throw Error('Provide a project directory after --project.');
    }else if(!args.includes('--user')){
      const positional=args.find(arg=>!arg.startsWith('--'));
      if(positional)project=positional;
    }
    value={ok:true,...await install({...(project?{project,scope:'project'}:{scope:'user'}),source,host,cliSeedDirectory:seed,upgrade})};
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
    while(true){value=await runtime.result(id,{markReceived:true});if(value.status==='completed'||value.code==='cancelled'||(!value.pending&&(value.retryAllowed===false||value.outcome))||Date.now()>=until)break;await pause(500);}
    if(value.code==='result_unavailable')value={ok:true,status:value.status,draftId:id,pending:true,hint:'The local result is not ready. Use result later; do not send or prepare a duplicate.'};
  }
  else if(command==='--help')value={commands:['configure [--token-file <file>]','install [--project <dir>] [--upgrade]','profile [export | set <id> "<text>" --quote "<sourceQuote>" | rm <id>]','prepare <packet.json>','review <draftId> [--no-open]','wait <draftId> [seconds:1-900]','result <draftId> [--defer-receipt]','receipt <draftId>','diagnose <draftId>','list','clean [--apply] [--all] [--days <N>]','followup <draftId> <answers.json>','send <draftId> <approvedHash> <confirmation.txt> (legacy explicit-confirmation interface)'],note:'Installation defaults to user scope under $HOME (no administrator access); pass --project <dir> for project scope. Preparation is local. Use review for the shared zesia.dev window. Only its approval sends materials.'};
  else throw Error('Unknown command. Run with --help.');
  if(['prepare','followup'].includes(command)&&value){delete value.packet;value.hint='Materials are prepared locally. Open review, then wait for the result. Do not paste or send the packet from chat.';}
  if(value!==undefined&&!['serve-review','serve-online-review'].includes(command))console.log(JSON.stringify(value,null,2));
  if(value?.ok===false)process.exitCode=1;
}catch(error){const value={ok:false,message:error.message,retryAllowed:false};if(process.send)process.send(value);else console.log(JSON.stringify(value));process.exitCode=1;}
