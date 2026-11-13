import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validatePacket } from './runtime/workflow.mjs';
import { readConfig, destinationOf } from './runtime/config.mjs';
import { consultOverA2A, preflightConsult, recoverConsult } from './runtime/a2a.mjs';

export function portableEnvironment(env = process.env) {
  return { ...env, ZESIA_CONFIG: env.ZESIA_CONFIG || join(homedir(), '.config/zesia/agent.json') };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`;
  return JSON.stringify(value);
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function check(packet) {
  if (typeof packet?.requester !== 'string' || !packet.requester.trim() || packet.requester.length > 160) throw new Error('Provide your actual agent name as requester.');
  validatePacket(packet, packet.requester);
  if (Buffer.byteLength(JSON.stringify(packet)) > 128 * 1024) throw new Error('The packet exceeds 128 KiB. Nothing was sent.');
}
export function createPortable({
  stateDir = process.env.ZESIA_STATE_DIR || join(homedir(), '.local/state/zesia/consult'),
  configuration = () => readConfig(portableEnvironment(), { requireToken: false }),
  preflight = preflightConsult, consult = consultOverA2A, recover = recoverConsult, now = Date.now,
} = {}) {
  const path = id => {
    if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('Invalid draft ID.');
    return join(stateDir, id+'.json');
  };
  const read = async id => JSON.parse(await readFile(path(id), 'utf8'));
  const store = async record => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const file = path(record.id), temp = file+'.'+randomUUID()+'.tmp';
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await rename(temp, file);
  };
  async function receivedAt(id) {try{return JSON.parse(await readFile(path(id)+'.received','utf8')).at;}catch{return null;}}
  async function acceptResponse(record,response) {
    record.rawResult=response;
    record.result={ok:true,status:'completed',requestId:record.requestId,consultId:response.consultId,a2a:response.a2a,
      decision:response.decision,review:response.review,followUp:response.followUp,qualityStatus:response.qualityStatus,
      deliveryKind:response.deliveryKind,expertMatch:response.expertMatch,usage:response.usage,validation:response.validation,budgetAdmission:response.budgetAdmission,
      ...(response.routing?.status?{routing:{status:response.routing.status,selection:response.routing.selection,model:response.routing.model}}:{}),
      advice:response.advice};
    record.status='completed';await store(record);return present(record);
  }
  const recoveries=new Map();let lastRecovery=new Map();
  async function recoverResult(id) {
    const record=await read(id);
    if(record.status!=='unknown'||!record.requestId)return present(record,true);
    if(recoveries.has(id))return recoveries.get(id);
    if(now()-(lastRecovery.get(id)||0)<2000)return present(record,true);
    lastRecovery.set(id,now());
    const pending=(async()=>{
      const config=await configuration();
      if(destinationOf(config.url)!==record.destination||!config.token)throw Error('Restore the approved destination and credential to recover this result.');
      const run=await recover({url:config.url,token:config.token,requestId:record.requestId,signal:AbortSignal.timeout(15000)});
      const latest=await read(id);if(latest.status==='completed')return present(latest,true);
      if(run.state==='completed'){
        if(run.result?.format!=='zesia.consult.v0'||typeof run.result?.advice!=='string'||run.result.requestId!==record.requestId)throw Error('Invalid recovered consultation.');
        return acceptResponse(latest,run.result);
      }
      if(run.state==='expired'||run.state==='rejected'){
        latest.status=run.state==='expired'?'expired':'failed';
        latest.result={ok:false,status:latest.status,code:run.state==='expired'?'result_expired':run.error?.code||'request_rejected',message:run.state==='expired'?'The saved result expired. A new consultation requires a new review.':run.error?.message||'This request was not admitted.',outcome:run.state==='expired'?'expired':'not_started',retryAllowed:false};
        await store(latest);return present(latest,true);
      }
      return {...present(latest,true),recoveryState:run.state};
    })().finally(()=>recoveries.delete(id));
    recoveries.set(id,pending);return pending;
  }
  function present(record, cached = false) {
    if (!record.result) return { ok: false, status: record.status, code: record.status === 'unknown' ? 'outcome_unknown' : 'result_unavailable', hint: 'Do not resend an unknown outcome.' };
    const r = record.result;
    return { ...r, draftId: record.id, cached };
  }
  async function stage(packet, continuation = null) {
    check(packet);
    const config = await configuration();
    const record = { id: randomUUID(), requestId: 'zrq-'+now()+'-'+randomUUID(), status: 'prepared', packet: structuredClone(packet), hash: hash(packet),
      destination: destinationOf(config.url), expiresAt: now()+15*60*1000, continuation };
    await store(record);
    return { ok: true, status: 'awaiting_confirmation', draftId: record.id, requestId: record.requestId, approvedHash: record.hash,
      destination: record.destination, packet: record.packet, expiresAt: new Date(record.expiresAt).toISOString(), networkCalls: 0 };
  }
  return {
    async prepare(packet) {
      if (packet?.context?.continuation) throw new Error('Use followup with an actual prior result.');
      return stage(packet);
    },
    async send(id, approvedHash, confirmation) {
      const record = await read(id);
      if (record.status === 'completed' || record.status === 'failed') return present(record, true);
      if (record.status !== 'prepared') return present(record);
      if (typeof confirmation !== 'string' || !confirmation.trim() || confirmation.length > 500) throw new Error('An explicit user confirmation is required.');
      if (now() > record.expiresAt) throw new Error('This draft expired. Prepare and review again; nothing was sent.');
      if (approvedHash !== record.hash || hash(record.packet) !== record.hash) throw new Error('Reviewed packet hash mismatch. Nothing was sent.');
      check(record.packet);
      const config = await configuration();
      if (destinationOf(config.url) !== record.destination) throw new Error('The destination changed. Prepare and review again.');
      if (!config.token) throw new Error('Configure the Zesia trial token first. Nothing was sent.');
      let claim;
      try { claim = await open(path(id)+'.send', 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return { ok: false, code: 'send_already_claimed', hint: 'Read the local result; do not resend.' }; throw error; }
      await claim.close();
      let stageName = 'preflight';
      try {
        record.approval={hash:record.hash,requestId:record.requestId,destination:record.destination,confirmation:confirmation.trim(),at:now()};
        record.status = 'preflight'; await store(record);
        const pre = await preflight({ url: config.url, token: config.token, input: record.packet, signal: AbortSignal.timeout(15000) });
        if (!pre.ok) throw Object.assign(new Error(pre.hint || pre.message || 'Preflight rejected the packet.'), { code: pre.code || 'preflight_rejected', details: pre });
        stageName = 'consultation'; record.status = 'unknown'; await store(record);
        const response = await consult({ url: config.url, token: config.token, input: record.packet,
          contextId: record.continuation?.contextId, requestId: record.requestId, signal: AbortSignal.timeout(60000) });
        // Keep the full result locally. Return work-relevant fields once, without
        // echoing the submitted packet, routing probabilities or provider traces.
        return await acceptResponse(record,response);
      } catch (error) {
        record.status = stageName === 'preflight' ? 'failed' : 'unknown';
        record.result = { ok: false, code: error.code || 'consultation_unavailable', message: error.message,
          stage: stageName, outcome: stageName === 'preflight' ? 'not_started' : 'unknown', retryAllowed: false,
          ...(error.details ? { details: error.details } : {}) };
        await store(record); return present(record);
      }
    },
    async inspect(id) {
      const record = await read(id);
      return {ok:true,draftId:record.id,requestId:record.requestId,status:record.status,approvedHash:record.hash,
        destination:record.destination,packet:structuredClone(record.packet),
        expiresAt:new Date(record.expiresAt).toISOString(),result:record.result || null,rawResult:record.rawResult||null,agentReceivedAt:await receivedAt(id)};
    },
    async cancel(id, approvedHash) {
      const record=await read(id);
      if(record.status!=='prepared' || approvedHash!==record.hash || hash(record.packet)!==record.hash)throw Error('Only this exact unsent draft can be cancelled.');
      const claim=await open(path(id)+'.send','wx',0o600).catch(error=>{if(error.code==='EEXIST')throw Error('This draft was already claimed; cancellation cannot undo a send.');throw error;});
      await claim.close();
      record.status='cancelled';record.result={ok:false,status:'cancelled',code:'cancelled',message:'Cancelled before sending. Nothing was sent.',outcome:'not_started',retryAllowed:false};
      await store(record);return present(record);
    },
    recover: recoverResult,
    async result(id,{markReceived=false}={}) {
      await recoverResult(id).catch(()=>{});
      const record=await read(id);
      if(markReceived&&record.status==='completed'){
        try{await writeFile(path(id)+'.received',JSON.stringify({at:now()}),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
      }
      return {...present(record,true),agentReceivedAt:await receivedAt(id)};
    },
    async followup(id, answers) {
      const parent = await read(id), r = parent.rawResult;
      if (parent.status !== 'completed' || !r?.consultId || !r.a2a?.contextId) throw new Error('No completed consultation exists for this draft.');
      const round = parent.continuation?.round || 1;
      if (round >= 3) throw new Error('The three-round limit was reached.');
      const requests = r.followUp?.requests || [];
      if (!Array.isArray(answers) || !answers.length || answers.length > 3) throw new Error('Provide one to three answers to actual consultant questions.');
      const seen = new Set();
      const checked = answers.map(answer => {
        const request = requests.find(q => q.id === answer.requestId);
        if (!request || seen.has(request.id)) throw new Error('Unknown or duplicate follow-up question.');
        seen.add(request.id);
        if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 2000 || typeof answer.sourceRef !== 'string' || !answer.sourceRef.trim()) throw new Error('Each answer needs bounded text and an actual source reference.');
        if (request.kind === 'user_decision' && !answer.sourceQuote?.trim()) throw new Error('Ask the user for the decision and quote their answer. Confirmation is not a decision.');
        return { requestId: request.id, question: request.question, text: answer.text, sourceRef: answer.sourceRef, sourceQuote: answer.sourceQuote || '' };
      });
      const packet = structuredClone(parent.packet);
      packet.context.previousAdvice = [...(packet.context.previousAdvice || []), r.decision?.assessment || r.advice, r.decision?.recommendation].filter(Boolean);
      packet.context.continuation = { previousConsultId: r.consultId, round: round+1, answers: checked };
      packet.context.materials = [...(packet.context.materials || []), ...checked.map((a,i) => ({ id: `followup-${round+1}-${i}`, content: `${a.question}\nSource: ${a.sourceRef}\n${a.text}${a.sourceQuote ? '\nUser quote: '+a.sourceQuote : ''}` }))];
      check(packet);
      const claim = await open(path(id)+'.followup', 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('A follow-up already exists for this result. Do not duplicate it.'); throw error; });
      await claim.close();
      try { return await stage(packet, { contextId: r.a2a.contextId, round: round+1 }); }
      catch (error) { await unlink(path(id)+'.followup'); throw error; }
    },
  };
}
