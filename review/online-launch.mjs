import {spawn} from 'node:child_process';
import {standalone} from '../runtime/standalone.mjs';
export function launchOnlineReview(entry,draftId,{openBrowser=true,env=process.env}={}){
 return new Promise((resolve,reject)=>{
  const args=[...(standalone?[]:[entry]),'serve-online-review',draftId,...(!openBrowser?['--no-open']:[])];
  const child=spawn(process.execPath,args,{env,detached:true,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  let settled=false;
  const timer=setTimeout(()=>finish(Error('The local bridge did not start. Nothing was sent.')),10000);
  function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);if(child.connected)child.disconnect();if(error){child.kill();reject(error);}else{child.unref();resolve(value);}}
  child.once('error',finish);child.once('exit',()=>finish(Error('The local bridge stopped before starting. Nothing was sent.')));
  child.once('message',value=>value?.ok?finish(null,value):finish(Error(value?.message||'The local bridge could not start.')));
 });
}
