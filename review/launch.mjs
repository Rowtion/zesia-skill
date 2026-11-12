import {fork} from 'node:child_process';

export function launchReview(entry,draftId,{openBrowser=true,env=process.env}={}) {
  return new Promise((resolve,reject)=>{
    const child=fork(entry,['serve-review',draftId,...(!openBrowser?['--no-open']:[])],{env,detached:true,stdio:['ignore','ignore','ignore','ipc']});
    let settled=false;
    const timer=setTimeout(()=>finish(Error('The local review did not start. Nothing was sent.')),10000);
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);if(child.connected)child.disconnect();if(error){child.kill();reject(error);}else{child.unref();resolve(value);}}
    child.once('error',finish);child.once('exit',()=>finish(Error('The local review stopped before starting. Nothing was sent.')));
    child.once('message',value=>{if(value?.ok)finish(null,value);else finish(Error(value?.message||'The local review could not start.'));});
  });
}
