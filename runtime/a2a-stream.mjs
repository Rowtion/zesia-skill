import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { CONSULT_MEDIA_TYPE } from './contract.mjs';

const MAX_PREVIEW = 1200;
const COMPLETE = 'TASK_STATE_COMPLETED';

export async function supportsConsultStreaming(origin, transport, signal) {
  try {
    const response = await transport(origin + '/.well-known/agent-card.json', { redirect: 'error', signal });
    if (!response.ok) return false;
    const card = await response.json();
    return card.capabilities?.streaming === true && card.supportedInterfaces?.some(binding =>
      binding.url === origin + '/a2a' && binding.protocolBinding === 'JSONRPC' && binding.protocolVersion === '1.0');
  } catch { return false; }
}

export async function forwardEventStream(remote, response, maxBytes) {
  let bytes = 0;
  const reader = remote.body.getReader();
  const disconnected = new AbortController();
  const onClose = () => {
    disconnected.abort();
    void reader.cancel().catch(() => {});
  };
  response.once('close', onClose);
  try {
    response.writeHead(remote.status, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    for (;;) {
      const { done, value } = await reader.read();
      if (done || disconnected.signal.aborted) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Error('The consultation stream exceeded the response limit.');
      if (!response.write(value)) await once(response, 'drain', { signal: disconnected.signal });
    }
    response.end();
  } finally {
    response.removeListener('close', onClose);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function observeConsultStream(stdout, { requestId, expectedContext, onPreview }) {
  let bindingContext, result, complete = false, invalid = false, notStarted = false;
  const decoder = new StringDecoder();
  let pending = '';
  function accept(line) {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { invalid = true; return; }
    const parts = event.task?.artifacts || (event.artifactUpdate?.lastChunk ? [event.artifactUpdate.artifact] : []);
    const binding = event.task || event.artifactUpdate || event.statusUpdate;
    if (!binding || (binding.id || binding.taskId) !== requestId ||
      typeof binding.contextId !== 'string' || !binding.contextId ||
      (bindingContext && binding.contextId !== bindingContext) || (expectedContext && binding.contextId !== expectedContext)) {
      invalid = true;
      return;
    }
    bindingContext = binding.contextId;
    const status = event.task?.status || event.statusUpdate?.status;
    if (status?.state === COMPLETE) complete = true;
    if (status?.state === 'TASK_STATE_REJECTED' && event.statusUpdate?.metadata?.zesia?.outcome === 'not_started')
      notStarted = true;
    const preview = event.artifactUpdate?.artifact;
    if (preview?.artifactId === 'recommendation-preview' && !invalid && !complete) {
      const text = preview.parts?.[0]?.text;
      if (typeof text === 'string' && text.length && text.length <= MAX_PREVIEW) onPreview(text);
    }
    const artifact = parts.find(item => item?.artifactId === 'consult-result');
    if (artifact) result = artifact.parts?.find(part => part.mediaType === CONSULT_MEDIA_TYPE)?.data;
  }
  stdout.on('data', chunk => {
    pending += typeof chunk==='string' ? chunk : decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      accept(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  return () => {
    accept(pending + decoder.end());
    if (!invalid && complete && result?.requestId === requestId && result.a2a?.contextId === bindingContext &&
      typeof result.a2a?.messageId === 'string' && result.a2a.messageId.length &&
      result.format === 'zesia.consult.v0' && typeof result.advice === 'string') return result;
    throw Object.assign(Error(notStarted
      ? 'The consultation was rejected before execution.'
      : 'The consultation stream ended without a verified final result. Check the original request.'), {
      outcome: notStarted ? 'not_started' : 'unknown',
      retryAllowed: false,
    });
  };
}
