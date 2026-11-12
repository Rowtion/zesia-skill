/** Compose caller cancellation and a bounded deadline on every supported Node 20. */
export function deadlineFor(parent, milliseconds=60000) {
  if(parent!==undefined && !(parent instanceof AbortSignal))throw new TypeError('Invalid consultation abort signal.');
  const controller=new AbortController();
  const cancel=()=>controller.abort(parent.reason);
  let timer;
  if(parent?.aborted)cancel();
  else {
    parent?.addEventListener('abort',cancel,{once:true});
    timer=setTimeout(()=>controller.abort(new DOMException('Consultation deadline exceeded.','TimeoutError')),milliseconds);
    timer.unref?.();
  }
  return {signal:controller.signal,dispose(){clearTimeout(timer);parent?.removeEventListener('abort',cancel);}};
}
