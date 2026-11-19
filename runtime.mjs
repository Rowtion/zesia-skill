import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, writeFile, unlink, link, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stripAttachments, validatePacket } from './runtime/workflow.mjs';
import { captureEvidence, mergeEvidence, captureAttachments, mergeAttachments } from './runtime/evidence.mjs';
import { readConfig, saveConfig, destinationOf } from './runtime/config.mjs';
import { consultOverA2A, recoverConsult, ackConsult } from './runtime/a2a.mjs';
import {
  defaultProfilePath,
  formatProfileMarkdown,
  injectProfileStatements,
  readProfile,
  removeProfileItem,
  setProfileItem,
} from './runtime/profile.mjs';
import { runtimeVersion } from './runtime/standalone.mjs';
import { CONSULT_RESULT_V2, consultFollowUpRequests } from './runtime/contract.mjs';

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
  if (Buffer.byteLength(JSON.stringify(stripAttachments(packet))) > 128 * 1024) throw new Error('The packet exceeds 128 KiB. Nothing was sent.');
}
const DEFAULT_STATE_DIR = () => process.env.ZESIA_STATE_DIR || join(homedir(), '.local/state/zesia/consult');
export function createPortable({
  stateDir = DEFAULT_STATE_DIR(),
  profilePath,
  configuration = () => readConfig(portableEnvironment(), { requireToken: false }),
  saveConfiguration = values => saveConfig(values, portableEnvironment()),
  streaming = process.env.ZESIA_CONSULT_STREAMING === 'enabled',
  consult = consultOverA2A, recover = recoverConsult, ack = ackConsult, now = Date.now,
} = {}) {
  const previews = new Map();
  const resolvedProfilePath = profilePath || defaultProfilePath(process.env, stateDir !== DEFAULT_STATE_DIR() ? stateDir : null);
  const path = id => {
    if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('Invalid draft ID.');
    return join(stateDir, id+'.json');
  };
  // Publish a terminal checkpoint atomically. A late failure in another process
  // must never replace an opinion already recovered from the same cloud request.
  const read = async id => {
    try{return JSON.parse(await readFile(path(id)+'.completed','utf8'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    return JSON.parse(await readFile(path(id),'utf8'));
  };
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
    record.status='completed';
    const checkpoint=path(record.id)+'.completed',temp=checkpoint+'.'+randomUUID()+'.tmp';
    try{
      await writeFile(temp,JSON.stringify(record),{mode:0o600,flag:'wx'});
      try{await link(temp,checkpoint);}catch(error){if(error.code!=='EEXIST')throw error;}
    }finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
    const completed=await read(record.id);await store(completed);return present(completed);
  }
  const recoveries=new Map();let lastRecovery=new Map();
  async function recoverResult(id) {
    const record=await read(id);
    if(record.status!=='unknown'||!record.requestId)return present(record,true);
    if(recoveries.has(id))return recoveries.get(id);
    const previous=lastRecovery.get(id);
    if(previous&&now()-previous.at<2000)return previous.value;
    lastRecovery.set(id,{at:now(),value:{ok:true,status:'running',pending:true,draftId:id,requestId:record.requestId,recoveryState:'checking',retryAllowed:false}});
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
      const value=run.state==='running'
        ?{ok:true,status:'running',pending:true,draftId:id,requestId:record.requestId,recoveryState:run.state,retryAllowed:false,hint:'The same request is still running. Continue read-only polling; do not resend.'}
        :{...present(latest,true),recoveryState:run.state};
      lastRecovery.set(id,{at:now(),value});return value;
    })().catch(error=>{lastRecovery.delete(id);throw error;}).finally(()=>recoveries.delete(id));
    recoveries.set(id,pending);return pending;
  }
  function present(record, cached = false) {
    if (!record.result) return { ok: false, status: record.status, code: record.status === 'unknown' ? 'outcome_unknown' : 'result_unavailable', hint: 'Do not resend an unknown outcome.' };
    const r = record.result;
    const raw = record.rawResult;
    if (raw?.resultSchemaVersion === CONSULT_RESULT_V2) {
      return {
        ...r, resultSchemaVersion: CONSULT_RESULT_V2, nextAction: raw.nextAction ?? null,
        followUp: { ...r.followUp, requests: consultFollowUpRequests(raw) },
        draftId: record.id, cached,
      };
    }
    return { ...r, draftId: record.id, cached };
  }
  function stopMarker(record) {
    const contextId = record.continuation?.contextId || record.rawResult?.a2a?.contextId;
    if (!contextId) return null;
    return join(stateDir, 'stopped-' + hash([record.destination, contextId]));
  }
  async function followUpState(record) {
    const marker = stopMarker(record);
    const stopped = marker ? await lstat(marker).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }) : false;
    const round = record.continuation?.round || 1;
    const canStop = !stopped && Boolean(marker) && record.status === 'completed' && round < 3
      && consultFollowUpRequests(record.rawResult).length > 0;
    return { stopped, round, maxRounds: 3, canStop };
  }
  async function stage(packet, continuation = null, expectedDestination = null) {
    check(packet);
    const config = await configuration();
    if (expectedDestination && destinationOf(config.url) !== expectedDestination)
      throw new Error('The consultation destination changed. Start a separate consultation to use it.');
    const record = { id: randomUUID(), requestId: 'zrq-'+now()+'-'+randomUUID(), status: 'prepared', packet: structuredClone(packet), hash: hash(packet),
      destination: destinationOf(config.url), expiresAt: now()+15*60*1000, continuation };
    await store(record);
    return { ok: true, status: 'awaiting_confirmation', draftId: record.id, requestId: record.requestId, approvedHash: record.hash,
      destination: record.destination, packet: record.packet, expiresAt: new Date(record.expiresAt).toISOString(), networkCalls: 0 };
  }
  return {
    async prepare(inputPacket) {
      if (inputPacket?.context?.continuation) throw new Error('Use followup with an actual prior result.');
      const packet = structuredClone(inputPacket || {});
      if (!packet.context || typeof packet.context !== 'object') packet.context = {};
      if (Array.isArray(packet.evidenceFiles) && packet.evidenceFiles.length) {
        const captured = await captureEvidence(packet.evidenceFiles);
        if (captured.length) packet.context.materials = mergeEvidence(packet.context.materials || [], captured);
      }
      delete packet.evidenceFiles;
      if (Array.isArray(packet.attachmentFiles) && packet.attachmentFiles.length) {
        const capturedAtts = await captureAttachments(packet.attachmentFiles);
        if (capturedAtts.length) packet.context.attachments = mergeAttachments(packet.context.attachments || [], capturedAtts);
      }
      delete packet.attachmentFiles;
      const profile = await readProfile(resolvedProfilePath);
      if (profile.items.length > 0 && (packet.context.statements === undefined || Array.isArray(packet.context.statements))) {
        const merged = injectProfileStatements(packet.context.statements || [], profile);
        if (merged.length) packet.context.statements = merged;
      }
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
      try {
        if (record.continuation && (await followUpState(record)).stopped) {
          record.status = 'cancelled';
          record.result = { ok: false, status: 'cancelled', code: 'cancelled',
            message: 'Further rounds are stopped. This draft was not sent.', outcome: 'not_started', retryAllowed: false };
          await store(record);
          return present(record);
        }
        record.approval={hash:record.hash,requestId:record.requestId,destination:record.destination,confirmation:confirmation.trim(),at:now()};
        record.status = 'unknown'; await store(record);
        const response = await consult({ url: config.url, token: config.token, input: record.packet,
          contextId: record.continuation?.contextId, requestId: record.requestId,
          correlation: { requester: record.packet?.requester, hostVersion: record.packet?.hostVersion, runtimeVersion: runtimeVersion || undefined, parentRequestId: record.continuation?.previousRequestId || undefined },
          signal: AbortSignal.timeout(60000),
          ...(streaming ? { onPreview: text => previews.set(id,text) } : {}),
        });
        // Keep the full result locally. Return work-relevant fields once, without
        // echoing the submitted packet, routing probabilities or provider traces.
        return await acceptResponse(record,response);
      } catch (error) {
        const latest=await read(id);if(latest.status==='completed')return present(latest,true);
        record.status = error.outcome === 'not_started' ? 'failed' : 'unknown';
        const reauthRequired = record.status === 'failed'
          && (error.status === 401 || error.code === 'unauthorized' || error.code === 'authentication_failed');
        record.reauthRequired = reauthRequired;
        record.result = { ok: false, code: error.code || 'consultation_unavailable', message: error.message,
          stage: error.details?.stage || 'consultation', outcome: record.status === 'failed' ? 'not_started' : 'unknown', retryAllowed: false,
          ...(reauthRequired ? { reauthRequired: true } : {}),
          ...(error.details ? { details: error.details } : {}) };
        await store(record);
        if (reauthRequired) {
          await unlink(path(id) + '.send').catch(err => { if (err.code !== 'ENOENT') throw err; });
        }
        return present(record);
      } finally { previews.delete(id); }
    },
    async configure({ destination, token, draftId }) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new Error('Invalid activation token.');
      const url = destinationOf(destination);
      if (process.env.ZESIA_URL && destinationOf(process.env.ZESIA_URL) !== url) throw new Error('The configured destination does not match ZESIA_URL.');
      await saveConfiguration({ url, token });
      if (draftId) {
        let claim = null;
        try {
          claim = await open(path(draftId) + '.send', 'wx', 0o600);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
        if (claim) {
          try {
            const record = await read(draftId);
            if (record.status === 'failed' && record.reauthRequired && now() <= record.expiresAt) {
              record.status = 'prepared';
              delete record.reauthRequired;
              delete record.result;
              await store(record);
            }
          } finally {
            await claim.close();
            await unlink(path(draftId) + '.send').catch(err => { if (err.code !== 'ENOENT') throw err; });
          }
        }
      }
      return { ok: true, configured: true, destination: url };
    },
    async inspect(id, { compact = false } = {}) {
      const record = await read(id);
      const config = await configuration().catch(() => null);
      const configured = Boolean(config?.token);
      const reauthRequired = Boolean(record.reauthRequired);
      const rounds = await followUpState(record);
      const preview = previews.get(id);
      const progress = streaming ? {
        streamPreviewVersion: 1,
        ...(record.status==='unknown' && preview ? { streamPreview: preview } : {}),
      } : {};
      if(compact)return {status:record.status,...progress,configured,reauthRequired,agentReceivedAt:await receivedAt(id),followUpState:rounds,
        ...(record.result?.ok===false?{result:{message:record.result.message}}:{})};
      const profile=await readProfile(resolvedProfilePath).catch(()=>null);
      return {ok:true,draftId:record.id,requestId:record.requestId,status:record.status,...progress,configured,reauthRequired,approvedHash:record.hash,
        destination:record.destination,packet:structuredClone(record.packet),profile,followUpState:rounds,
        ...(profile ? {} : {profileError:'The local Profile could not be read. Inspect it with zesia profile.'}),
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
    async stopFollowUp(id) {
      const record = await read(id);
      const current = await followUpState(record);
      if (current.stopped) return current;
      if (!current.canStop) throw Error('There are no further rounds to stop in this review.');
      await writeFile(stopMarker(record), '', { flag: 'wx', mode: 0o600 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      return followUpState(record);
    },
    recover: recoverResult,
    async result(id,{markReceived=false}={}) {
      const recovered=await recoverResult(id).catch(()=>null);
      const record=await read(id);
      if(markReceived&&record.status==='completed'){
        let firstReceipt=false;
        try{await writeFile(path(id)+'.received',JSON.stringify({at:now()}),{flag:'wx',mode:0o600});firstReceipt=true;}catch(error){if(error.code!=='EEXIST')throw error;}
        if(firstReceipt&&record.requestId){
          const config=await configuration().catch(()=>null);
          if(config?.url&&config?.token)await ack({url:config.url,token:config.token,requestId:record.requestId,signal:AbortSignal.timeout(5000)}).catch(()=>false);
        }
      }
      return {...(record.status!=='completed'&&recovered?.pending?recovered:present(record,true)),agentReceivedAt:await receivedAt(id),followUpState:await followUpState(record)};
    },
    async diagnose(id) {
      const record = await read(id);
      return {
        ok: true,
        format: 'zesia.consult.diagnostic.v1',
        draftId: record.id,
        requestId: record.requestId || null,
        consultId: record.rawResult?.consultId || record.result?.consultId || null,
        contextId: record.rawResult?.a2a?.contextId || record.continuation?.contextId || null,
        destination: record.destination || null,
        requester: record.packet?.requester || null,
        status: record.status,
        outcome: record.result?.outcome || (record.status === 'completed' ? 'completed' : null),
        code: record.result?.code || null,
        stage: record.result?.stage || null,
        round: record.continuation?.round || 1,
        reauthRequired: Boolean(record.reauthRequired),
        createdAt: record.createdAt || null,
        approvedAt: record.approval?.at || null,
        completedAt: record.completedAt || null,
        agentReceivedAt: await receivedAt(id),
      };
    },
    async followup(id, answers) {
      const parent = await read(id), r = parent.rawResult;
      if (parent.status !== 'completed' || !r?.consultId || !r.a2a?.contextId) throw new Error('No completed consultation exists for this draft.');
      const round = parent.continuation?.round || 1;
      if (round >= 3) throw new Error('The three-round limit was reached.');
      if ((await followUpState(parent)).stopped) throw new Error('Further rounds were stopped by the user.');
      const requests = consultFollowUpRequests(r);
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
      try {
        if ((await followUpState(parent)).stopped) throw new Error('Further rounds were stopped by the user.');
        return await stage(packet, { contextId: r.a2a.contextId, previousRequestId: parent.requestId, round: round+1 }, parent.destination);
      }
      catch (error) { await unlink(path(id)+'.followup'); throw error; }
    },
    async list({ retentionDays = 7 } = {}) {
      const items = await inspectRecords({ retentionDays, all: false });
      return { ok: true, format: 'zesia.consult.inventory.v1', retentionDaysDefault: retentionDays, count: items.length, records: items };
    },
    async clean({ apply = false, retentionDays = 7, all = false } = {}) {
      if (!Number.isFinite(retentionDays) || retentionDays < 0) throw new Error('retentionDays must be a non-negative number.');
      const items = await inspectRecords({ retentionDays, all });
      let deleted = 0, redacted = 0, protectedCount = 0, alreadyRedacted = 0;
      for (const item of items) {
        if (item.action === 'delete') {
          if (apply) {
            await unlink(path(item.draftId)).catch(err => { if (err.code !== 'ENOENT') throw err; });
            await unlink(path(item.draftId) + '.received').catch(err => { if (err.code !== 'ENOENT') throw err; });
          }
          deleted++;
        } else if (item.action === 'redact') {
          if (apply) {
            const raw = JSON.parse(await readFile(path(item.draftId), 'utf8'));
            await store({
              id: raw.id,
              requestId: raw.requestId || null,
              status: raw.status,
              destination: raw.destination || null,
              expiresAt: raw.expiresAt || null,
              redactedAt: now(),
            });
          }
          redacted++;
        } else if (item.action === 'already_redacted') {
          alreadyRedacted++;
        } else {
          protectedCount++;
        }
      }
      return {
        ok: true,
        format: 'zesia.consult.clean.v1',
        dryRun: !apply,
        retentionDays,
        summary: { total: items.length, deleted, redacted, protected: protectedCount, alreadyRedacted },
        items,
      };
    },
    profile: () => readProfile(resolvedProfilePath),
    profileMarkdown: async () => formatProfileMarkdown(await readProfile(resolvedProfilePath)),
    setProfile: input => setProfileItem(input, { path: resolvedProfilePath, now }),
    removeProfile: itemId => removeProfileItem(itemId, { path: resolvedProfilePath, now }),
  };

  async function inspectRecords({ retentionDays = 7, all = false } = {}) {
    let dirStat;
    try { dirStat = await lstat(stateDir); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('State directory must be a regular directory.');
    const entries = await readdir(stateDir);
    const records = [];
    for (const entry of entries.sort()) {
      const m = /^([0-9a-f-]{36})\.json$/.exec(entry);
      if (!m) continue;
      const draftId = m[1];
      const filePath = path(draftId);
      const st = await lstat(filePath).catch(() => null);
      if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
        records.push({ draftId, requestId: null, status: 'unsafe', expired: false, protected: true, protectedReason: 'unsafe_link', hasMaterials: false, bytes: st?.size || 0, action: 'skip' });
        continue;
      }
      let raw;
      try { raw = JSON.parse(await readFile(filePath, 'utf8')); } catch {
        records.push({ draftId, requestId: null, status: 'corrupt', expired: false, protected: true, protectedReason: 'unreadable_record', hasMaterials: false, bytes: st.size, action: 'skip' });
        continue;
      }
      const hasSendClaim = Boolean(await lstat(filePath + '.send').catch(() => null));
      const expired = typeof raw.expiresAt === 'number' && now() > raw.expiresAt;
      const createdApprox = typeof raw.expiresAt === 'number' ? raw.expiresAt - 15 * 60 * 1000 : (raw.approval?.at || st.mtimeMs);
      const ageMs = Math.max(0, now() - createdApprox);
      const hasMaterials = Boolean(raw.packet || raw.rawResult || raw.result);
      let isProtected = false, protectedReason = null, action = 'skip';
      if (raw.status === 'unknown') {
        isProtected = true; protectedReason = 'unknown_outcome';
      } else if (hasSendClaim && raw.status === 'prepared') {
        isProtected = true; protectedReason = 'active_send_claim';
      } else if (raw.status === 'prepared' && !hasSendClaim) {
        if (expired || all) { action = 'delete'; }
        else { isProtected = true; protectedReason = 'active_draft'; }
      } else if (['completed', 'failed', 'cancelled'].includes(raw.status)) {
        if (raw.redactedAt && !hasMaterials) {
          action = 'already_redacted';
        } else if (all || ageMs >= retentionDays * 86400_000) {
          action = 'redact';
        } else {
          isProtected = true; protectedReason = 'within_retention_window';
        }
      } else {
        isProtected = true; protectedReason = 'unrecognized_status';
      }
      records.push({
        draftId,
        requestId: raw.requestId || null,
        status: raw.status,
        expired,
        protected: isProtected,
        protectedReason,
        hasMaterials,
        bytes: st.size,
        action,
      });
    }
    return records;
  }
}
