import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { consultOverA2A, preflightConsult } from './a2a.mjs';
import { destinationOf, readConfig, REQUESTER } from './config.mjs';
import { captureEvidence, mergeEvidence, projectRoot, scanPacket } from './evidence.mjs';

const DRAFT_TTL = 15 * 60 * 1000;
const CONSULT_TTL = 60 * 60 * 1000;
const MAX_ROUNDS = 3;
const MAX_RECORDS = 20;
const MAX_MATERIALS = 8;
const MAX_PREVIOUS_ADVICE = 12;
const PACKET_KEYS = new Set(['requester', 'project', 'brief', 'context']);
const CONTEXT_KEYS = new Set([
  'goal', 'originalReply', 'facts', 'assumptions', 'attempts', 'userFeedback',
  'constraints', 'statements', 'materials', 'previousAdvice', 'continuation',
]);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// Key-order independent so a model re-emitting the same packet in a different
// order still matches the hash the user reviewed.
const digest = value => createHash('sha256').update(stableStringify(value)).digest('hex');

function baseValue() {
  return {
    advice: '',
    primaryExpert: '',
    routeStatus: 'not_sent',
    errorCode: '',
    errorMessage: '',
    retryAllowed: false,
    consultation: {},
    preflight: {},
    error: {},
    status: 'failed',
    draft: {},
    delivery: {},
  };
}

function failure(code, message, extra = {}, extraError = {}) {
  return {
    ...baseValue(),
    ok: false,
    status: 'failed',
    errorCode: code,
    errorMessage: message,
    error: { code, message, retryAllowed: false, stage: 'preparation', outcome: 'not_started', modelCalls: 0, ...extraError },
    ...extra,
  };
}

function boundedString(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function boundedArray(value, name, maxItems) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array of at most ${maxItems} entries.`);
  return value;
}

function validateContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('context must be an object.');
  const unknown = Object.keys(context).find(key => !CONTEXT_KEYS.has(key));
  if (unknown) throw new Error(`context contains an unsupported field: ${unknown}`);
  if (context.goal !== undefined) boundedString(context.goal, 'context.goal', 2000);
  if (context.originalReply !== undefined) boundedString(context.originalReply, 'context.originalReply', 8000);
  for (const key of ['facts', 'assumptions', 'userFeedback', 'constraints']) {
    for (const item of boundedArray(context[key], `context.${key}`, 12)) boundedString(item, `context.${key}[]`, 2000);
  }
  for (const item of boundedArray(context.attempts, 'context.attempts', 12)) {
    boundedString(item?.action, 'context.attempts[].action', 2000);
    boundedString(item?.outcome, 'context.attempts[].outcome', 2000);
  }
  for (const item of boundedArray(context.statements, 'context.statements', 16)) {
    boundedString(item?.id, 'context.statements[].id', 100);
    if (!['fact', 'constraint', 'assumption'].includes(item?.kind)) throw new Error('context.statements[].kind is invalid.');
    if (!['user_statement', 'observation', 'agent_inference'].includes(item?.origin)) throw new Error('context.statements[].origin is invalid.');
    boundedString(item?.text, 'context.statements[].text', 2000);
    boundedString(item?.sourceRef, 'context.statements[].sourceRef', 200);
    if (typeof item?.sourceQuote !== 'string' || item.sourceQuote.length > 2000) throw new Error('context.statements[].sourceQuote must be a string of at most 2000 characters.');
  }
  for (const item of boundedArray(context.materials, 'context.materials', MAX_MATERIALS)) {
    boundedString(item?.id, 'context.materials[].id', 100);
    boundedString(item?.content, 'context.materials[].content', 6000);
  }
  for (const item of boundedArray(context.previousAdvice, 'context.previousAdvice', MAX_PREVIOUS_ADVICE)) {
    // Preserve complete validated advice; server preflight applies the overall
    // 128 KiB input budget to this and the rest of the context together.
    boundedString(item, 'context.previousAdvice[]', 128 * 1024);
  }
}

export function validatePacket(packet, requester = REQUESTER) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('The consultation packet must be an object.');
  const unknown = Object.keys(packet).find(key => !PACKET_KEYS.has(key));
  if (unknown) throw new Error(`The consultation packet contains an unsupported field: ${unknown}`);
  if (packet.requester !== requester) throw new Error(`requester must be "${requester}".`);
  boundedString(packet.project, 'project', 160);
  boundedString(packet.brief, 'brief', 8000);
  validateContext(packet.context);
  // The locator guard cannot inspect materials the agent supplies directly, so
  // every outgoing string is checked for high-confidence credentials.
  scanPacket(packet);
}

function validateAnswers(parent, answers) {
  const requests = parent.result.followUp?.requests || [];
  if (!Array.isArray(answers) || !answers.length || answers.length > 3) throw new Error('Answer one to three actual consultant requests.');
  const seen = new Set();
  return answers.map(answer => {
    const request = requests.find(item => item.id === answer?.requestId);
    if (!request || seen.has(answer.requestId)) throw new Error('Unknown or duplicate follow-up request.');
    seen.add(answer.requestId);
    if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 2000) throw new Error('Provide a bounded answer.');
    if (typeof answer.sourceRef !== 'string' || !answer.sourceRef.trim() || answer.sourceRef.length > 200) throw new Error('Provide a source reference.');
    const quote = typeof answer.sourceQuote === 'string' ? answer.sourceQuote : '';
    if (quote.length > 2000) throw new Error('User quote exceeds 2000 characters.');
    if (request.kind === 'user_decision' && !quote.trim()) {
      // Claude Code does not expose conversation message IDs to a plugin, so the
      // quote cannot be verified against the transcript. Require it anyway and
      // rely on the user reviewing the packet before sending.
      throw new Error('A user decision requires an exact quote from the user; sending confirmation is not a decision.');
    }
    return { requestId: answer.requestId, question: request.question, text: answer.text, sourceRef: answer.sourceRef, sourceQuote: quote };
  });
}

export function createWorkflow({
  readConfiguration = () => readConfig(process.env, { requireToken: false }),
  requestConsult = consultOverA2A,
  preflightRequest = preflightConsult,
  now = Date.now,
  root = projectRoot(),
  requester = REQUESTER,
} = {}) {
  const drafts = new Map();
  const consultRecords = new Map();
  const adoptions = new Map();

  function clean() {
    for (const [id, draft] of drafts) if (draft.status !== 'sending' && now() - (draft.settledAt ?? draft.createdAt) > (draft.result ? CONSULT_TTL : DRAFT_TTL)) drafts.delete(id);
    for (const [id, record] of consultRecords) if (now() - record.createdAt > CONSULT_TTL) consultRecords.delete(id);
  }

  function rememberConsult(result, packet, round) {
    const consultId = result.consultId;
    if (!consultId) return;
    if (consultRecords.size >= MAX_RECORDS) consultRecords.delete(consultRecords.keys().next().value);
    consultRecords.set(consultId, {
      result: structuredClone(result),
      a2a: structuredClone(result.a2a || {}),
      packet: structuredClone(packet),
      round,
      createdAt: now(),
      consumed: false,
    });
    if (adoptions.size >= MAX_RECORDS) adoptions.delete(adoptions.keys().next().value);
    adoptions.set(consultId, { result: structuredClone(result), feedback: null });
  }

  function publicDraft(draft) {
    return {
      id: draft.id,
      hash: draft.hash,
      destination: draft.destination,
      packet: structuredClone(draft.packet),
      expiresAt: new Date(draft.createdAt + DRAFT_TTL).toISOString(),
      note: 'Nothing has been sent to 则灵, including preflight. The user must confirm before zesia_send.',
    };
  }

  async function send(packet, { destination, mode, confirmation = null, continuation = null }) {
    const trace = [];
    let stage = 'configuration';
    const progress = value => {
      stage = value;
      trace.push({ stage, at: new Date(now()).toISOString() });
    };

    try {
      progress('configuration');
      const config = await readConfiguration();
      if (destinationOf(config.url) !== destination) {
        return { ...failure('destination_changed', 'The destination changed after preparation. Prepare a new consultation.'), trace };
      }
      if (!config.token) {
        return { ...failure('configuration_missing', 'Configure the 则灵 trial token first. Nothing was sent.'), trace };
      }

      progress('preflight');
      const preflight = await preflightRequest({ url: config.url, token: config.token, input: packet, signal: AbortSignal.timeout(15_000) });
      if (!preflight.ok) {
        const issue = preflight.issues?.[0] || {};
        return {
          ...failure(issue.code || 'consult_input_rejected', issue.message || 'The server rejected this input.', {
            preflight,
          }, { ...issue, stage: 'preflight', hint: issue.hint, modelCalls: 0, contentModified: false }),
          trace,
        };
      }

      progress('cloud_consultation');
      // The server's own budget is 60 s; leave room for network and queueing
      // instead of sharing one 65 s abort across both requests.
      const result = await requestConsult({
        url: config.url,
        token: config.token,
        input: packet,
        contextId: continuation?.contextId,
        signal: AbortSignal.timeout(90_000),
        onStage: progress,
      });
      progress('result_received');
      rememberConsult(result, packet, continuation?.round || 1);

      return {
        ...baseValue(),
        ok: true,
        status: result.decision?.status === 'needs_clarification' ? 'awaiting_input' : 'completed',
        advice: result.advice,
        primaryExpert: result.routing?.selection?.primaryExpert || 'general',
        routeStatus: result.routing?.status || 'unknown',
        consultation: result,
        preflight,
        trace,
        delivery: {
          mode,
          destination,
          payloadSha256: digest(packet),
          approvedAt: mode === 'confirmed' ? new Date(now()).toISOString() : null,
          approvedBy: confirmation,
          packet: structuredClone(packet),
        },
      };
    } catch (error) {
      let structured;
      try {
        structured = error.failure || JSON.parse(error.metadata?.failure || 'null');
      } catch {
        structured = undefined;
      }
      if (structured) {
        return { ...failure(structured.code, structured.message, { preflight: structured.preflight || {} }, { ...structured, stage: structured.stage || stage }), trace };
      }
      const code = error.code || error.metadata?.consultCode || String(error.message || '').match(/consult_[a-z_]+/u)?.[0] || 'consult_failed';
      const used = error.metadata?.inputBytes;
      const limit = error.metadata?.maxInputBytes;
      const notStarted = ['configuration', 'preflight', 'discovery'].includes(stage)
        || (Number.isInteger(error.status) && error.status >= 400 && error.status < 500)
        || /^consult_(input|invalid|unknown|duplicate)/u.test(code);
      const outcome = notStarted ? 'not_started' : 'unknown';
      return {
        ...failure(code, limit
          ? `Server input budget: ${used || 'unknown'} / ${limit} UTF-8 bytes, including system and expert instructions.`
          : error.message || 'The consultation did not complete. Do not retry automatically.',
        {}, { stage, outcome, errorId: randomUUID(), used: used ? Number(used) : null, limit: limit ? Number(limit) : null, unit: limit ? 'utf8_bytes' : null }),
        trace,
      };
    }
  }

  async function stage(packet, { destination, continuation = null }) {
    clean();
    const draft = {
      id: randomUUID(),
      hash: digest(packet),
      destination,
      packet: structuredClone(packet),
      createdAt: now(),
      status: 'prepared',
      result: null,
      continuation,
    };
    drafts.set(draft.id, draft);
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value);
    return { ...baseValue(), ok: true, status: 'awaiting_confirmation', draft: publicDraft(draft) };
  }

  async function prepareConsult(args = {}) {
    clean();
    try {
      if (typeof args.brief !== 'string' || !args.brief.trim()) return failure('consult_invalid_input', 'Provide a non-empty consultation question. Nothing was sent.');
      if (args.brief.length > 8000) return failure('consult_invalid_input', 'Keep the consultation brief under 8,000 characters.');
      const config = await readConfiguration();
      const destination = destinationOf(config.url);
      const context = structuredClone(args.context || {});
      if (context.continuation) return failure('use_followup', 'Use zesia_followup for an existing consultation.');
      const captured = await captureEvidence(args.evidenceFiles, { root });
      if (captured.length) context.materials = mergeEvidence(context.materials || [], captured);
      if ((context.materials || []).length > MAX_MATERIALS) throw new Error('At most eight evidence materials are supported.');
      const packet = {
        requester,
        project: config.project || args.project || basename(root),
        brief: args.brief,
        context,
      };
      validatePacket(packet, requester);
      return await stage(packet, { destination });
    } catch (error) {
      return failure('preparation_failed', String(error?.message || 'Could not prepare the consultation.'));
    }
  }

  async function sendDraft({ draftId, approvedHash, confirmation, packet } = {}) {
    clean();
    const draft = drafts.get(draftId);
    if (!draft) return failure('draft_unavailable', 'This draft expired or the plugin restarted. Prepare it again and review the full packet.');
    if (draft.result) return { ...draft.result, cached: true };
    if (draft.status !== 'prepared') return failure('draft_already_used', 'This draft is already being sent or was cancelled. It will not be sent twice.');
    if (!approvedHash || approvedHash !== draft.hash || digest(draft.packet) !== draft.hash) {
      return failure('preview_changed', 'The confirmed packet did not match the reviewed content. Nothing was sent.');
    }
    // The reviewed packet is already held locally and identified by its hash.
    // Older callers may still echo it; never accept a changed echo. New callers
    // omit it so a model cannot accidentally move or rewrite nested fields.
    if (packet !== undefined && (!packet || typeof packet !== 'object' || Array.isArray(packet) || digest(packet) !== approvedHash)) {
      return failure('preview_changed', 'The packet in the confirmation prompt did not match the reviewed hash. Nothing was sent.');
    }
    // Claude Code cannot prove this quote came from the user. It must still be
    // present so the tool permission prompt shows the user's own confirmation
    // words rather than only an opaque draft id.
    if (typeof confirmation !== 'string' || !confirmation.trim() || confirmation.length > 500) {
      return failure('confirmation_required', 'Ask the user to confirm this exact packet in their own message, then pass their confirmation words. Nothing was sent.');
    }
    draft.status = 'sending';
    try {
      draft.result = await send(structuredClone(draft.packet), {
        destination: draft.destination,
        mode: 'confirmed',
        confirmation: confirmation.trim(),
        continuation: draft.continuation,
      });
    } catch (error) {
      draft.result = failure('send_failed', String(error?.message || 'Sending did not complete.'), {}, { outcome: 'unknown' });
    }
    // A definitely-unsent follow-up (configuration/preflight/HTTP 4xx) may be
    // retried; an unknown outcome may not.
    if (!draft.result.ok && draft.result.error?.outcome === 'not_started' && draft.continuation?.previousConsultId) {
      const parent = consultRecords.get(draft.continuation.previousConsultId);
      if (parent) parent.consumed = false;
    }
    draft.settledAt = now();
    draft.status = 'settled';
    return draft.result;
  }

  function readResult({ draftId } = {}) {
    clean();
    const result = drafts.get(draftId)?.result;
    return result ?? failure('result_unavailable', 'No local result is available for this draft. Do not send another consultation automatically.');
  }

  async function prepareFollowup(args = {}) {
    clean();
    const parent = consultRecords.get(args.consultId);
    if (!parent) return failure('consultation_unavailable', 'This consultation is unavailable, expired, or belongs to another session.');
    if (parent.consumed) return failure('followup_consumed', 'This response already has a follow-up draft or attempt; do not retry.');
    if (parent.round >= MAX_ROUNDS) return failure('round_limit', 'The three-round consultation limit was reached. Report remaining limits.');
    const contextId = parent.a2a?.contextId;
    if (!contextId) return failure('consultation_unavailable', 'The previous response has no A2A contextId; do not invent one.');
    try {
      const answers = validateAnswers(parent, args.answers);
      const packet = structuredClone(parent.packet);
      packet.brief = `继续同一次咨询。结合本轮补充的证据与用户回答更新判断；能给出有条件建议时直接给出，不要重复已回答的问题。原始问题：\n${parent.packet.brief}`;
      if (packet.brief.length > 8000) throw new Error('The continued brief exceeds the input contract; narrow the scope explicitly.');
      packet.context.previousAdvice = [
        ...(packet.context.previousAdvice || []),
        parent.result.decision?.assessment,
        parent.result.decision?.recommendation,
      ].filter(Boolean);
      packet.context.continuation = { previousConsultId: args.consultId, round: parent.round + 1, answers };
      packet.context.materials = [
        ...(packet.context.materials || []),
        ...answers.map(answer => ({
          id: `answer-${parent.round + 1}-${createHash('sha256').update(answer.requestId).digest('hex').slice(0, 16)}`,
          content: `Question: ${answer.question}\nSource: ${answer.sourceRef}\n${answer.text}${answer.sourceQuote ? `\nUser quote: ${answer.sourceQuote}` : ''}`,
        })),
      ];
      if (packet.context.materials.length > MAX_MATERIALS || packet.context.previousAdvice.length > MAX_PREVIOUS_ADVICE) {
        throw new Error('The accumulated evidence exceeds the current contract. Narrow the scope explicitly; nothing was sent.');
      }
      const captured = await captureEvidence(args.evidenceFiles, { root });
      if (captured.length) packet.context.materials = mergeEvidence(packet.context.materials, captured);
      if (packet.context.materials.length > MAX_MATERIALS) throw new Error('At most eight evidence materials are supported. Nothing sent.');
      validatePacket(packet);
      const config = await readConfiguration();
      const destination = destinationOf(config.url);
      parent.consumed = true;
      // The A2A contextId travels with the draft so the next SendMessage reuses it.
      return await stage(packet, { destination, continuation: { contextId, round: parent.round + 1 } });
    } catch (error) {
      return failure('followup_unavailable', String(error?.message || 'Could not prepare the follow-up.'));
    }
  }

  function inspect(consultId) {
    clean();
    const record = consultRecords.get(consultId);
    if (!record) return { ok: false, code: 'consultation_unavailable' };
    return {
      ok: true,
      consultId,
      contextId: record.a2a?.contextId || null,
      round: record.round,
      maxRounds: MAX_ROUNDS,
      consumed: record.consumed,
      followUp: record.result.followUp?.requests || [],
      previousAdvice: record.result.decision?.recommendation
        ? [record.result.decision.recommendation]
        : [],
      attributionLimit: 'This host does not expose conversation message IDs to plugins. User quotes are caller-reported and were not verified against the transcript.',
    };
  }

  function recordFeedback(args = {}) {
    const entry = adoptions.get(args.consultId);
    if (!entry) return { ok: false, code: 'consultation_not_in_this_session' };
    if (entry.feedback) return { ok: true, cached: true, feedback: entry.feedback };
    const expected = ['recommendation', ...(entry.result.decision?.nextSteps || []).map((_, index) => `step:${index}`)];
    const rows = ['accepted', 'declined', 'deferred'].flatMap(key => Array.isArray(args[key]) ? args[key] : []);
    const valid = rows.every(row =>
      row && expected.includes(row.target) &&
      typeof row.reason === 'string' && row.reason.trim() && row.reason.length <= 2000 &&
      typeof row.change === 'string' && row.change.trim() && row.change.length <= 2000);
    if (!valid || rows.length !== expected.length || new Set(rows.map(row => row.target)).size !== expected.length ||
      typeof args.nextStep !== 'string' || !args.nextStep.trim() || args.nextStep.length > 2000) {
      return { ok: false, code: 'adoption_incomplete', expectedTargets: expected };
    }
    entry.feedback = {
      accepted: args.accepted || [],
      declined: args.declined || [],
      deferred: args.deferred || [],
      nextStep: args.nextStep,
      recordedAt: new Date(now()).toISOString(),
      workExecuted: false,
    };
    return { ok: true, feedback: entry.feedback };
  }

  async function settings() {
    try {
      const config = await readConfiguration();
      return {
        ok: true,
        confirmBeforeSend: true,
        destination: destinationOf(config.url),
        changeVia: 'none: this plugin always prepares a draft and requires confirmation',
        note: 'Automatic sending is not supported in this plugin. Every consultation requires zesia_send with the reviewed packet.',
      };
    } catch (error) {
      return { ok: false, code: 'settings_unavailable', message: String(error?.message || 'Could not read settings.') };
    }
  }

  return { prepareConsult, sendDraft, readResult, prepareFollowup, inspect, recordFeedback, settings, clean };
}
