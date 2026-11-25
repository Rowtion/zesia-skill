import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { destinationOf } from './config.mjs';
import { attachmentPayload } from './evidence.mjs';
import { stripAttachments, validatePacket } from './workflow.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const id = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const hash = /^[a-f0-9]{64}$/u;
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
};
const digest = value => sha(JSON.stringify(stable(value)));
const iso = value => new Date(value).toISOString();
const SIGN_OPTIONS = { dsaEncoding: 'ieee-p1363' };
const maxArtifacts = 128;
const maxOutputBytes = 2 * 1024 * 1024;
const driverProtocol = 'zesia.driver.v1';
const driverOperations = new Set(['join', 'sync', 'exec', 'consult', 'submit_verify']);

// The room contract digests the exact canonical, validated packet. Keep
// whitespace-sensitive quotes as entered and trim only fields trimmed by the contract.
function groupPacket(source) {
  const packet = structuredClone(source);
  packet.context ??= {};
  validatePacket(packet, packet.requester);
  for (const key of ['requester', 'project', 'brief']) packet[key] = packet[key].trim();
  for (const key of ['goal', 'originalReply']) {
    if (packet.context[key]) packet.context[key] = packet.context[key].trim();
  }
  for (const key of ['facts', 'assumptions', 'userFeedback', 'constraints', 'previousAdvice']) {
    if (packet.context[key]) packet.context[key] = packet.context[key].map(item => item.trim());
  }
  for (const [list, keys] of Object.entries({
    attempts: ['action', 'outcome'], statements: ['id', 'text', 'sourceRef'],
    materials: ['id', 'content'], attachments: ['id', 'filename', 'description', 'mediaType', 'data'],
  })) {
    for (const item of packet.context[list] ?? []) {
      for (const key of keys) {
        if (typeof item[key] === 'string') item[key] = item[key].trim();
      }
    }
  }
  if (!packet.requester || packet.requester.length > 120 || packet.context.continuation
    || Buffer.byteLength(JSON.stringify(stripAttachments(packet))) > 128 * 1024) {
    throw Error('Use a new, bounded Consult packet to create a group.');
  }
  return packet;
}

function prepareFiles(packet) {
  const files = [
    ...(packet.context.materials ?? []).map(item => ({
      id: item.id, kind: 'inline_text', name: item.id, mediaType: 'text/plain',
      bytes: Buffer.from(item.content), text: item.content,
    })),
    ...(packet.context.attachments ?? []).map(item => ({
      id: item.id, kind: 'attachment', name: (item.filename || item.id).slice(0, 160), mediaType: item.mediaType,
      bytes: Buffer.from(attachmentPayload(item).base64, 'base64'),
    })),
  ];
  if (files.some(file => !id.test(file.id)) || new Set(files.map(file => file.id)).size !== files.length) {
    throw Error('Group materials require unique artifact IDs.');
  }
  return files;
}

function filenameFor(response, ref) {
  const encoded = /^attachment; filename\*=UTF-8''(.+)$/iu.exec(response.headers.get('content-disposition') ?? '')?.[1];
  const name = encoded ? decodeURIComponent(encoded) : ref.filename || ref.artifactId;
  return /[\/\\\u0000-\u001f\u007f]/u.test(name) || name === '.' || name === '..' ? ref.artifactId : name;
}

async function boundedBytes(response, expected) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expected) throw Error('Cloud artifact exceeds its sealed length.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export function createGroupWorkflow({ store, configuration, fetchRequest = fetch, now = Date.now, trustedHost } = {}) {
  const active = new Map();

  async function send(group, path, options = {}, { timeoutMs = 15_000, allowRoomError = false } = {}) {
    const config = await configuration();
    if (destinationOf(config.url) !== group.origin || !config.token) throw Error('Restore the approved destination and account.');
    const response = await fetchRequest(group.admission.destination.url.replace(/\/admission$/u, '/' + path), {
      ...options, headers: { authorization: 'Bearer ' + config.token, ...options.headers },
      redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok && !allowRoomError && !(path === 'session' && [404, 410].includes(response.status))) {
      throw Error('The cloud room did not confirm this operation.');
    }
    return response;
  }

  async function stage(input, { workspaceMode } = {}) {
    if (workspaceMode !== undefined && !['byo_agent', 'platform_managed'].includes(workspaceMode)) {
      throw Error('Unknown workspace mode.');
    }
    const packet = groupPacket(input);
    const origin = destinationOf((await configuration()).url);
    const requestId = 'zrq-' + now() + '-' + randomUUID();
    const roomId = 'room_' + digest(['zesia-room-v1', requestId]).slice(0, 48);
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = key.publicKey.export({ type: 'spki', format: 'der' });
    const files = prepareFiles(packet);
    const admission = {
      format: 'zesia.collab-room.admission.v1', stage: 'admission',
      draftId: 'draft-' + randomUUID(), requestId, expiresAt: iso(now() + 15 * 60_000),
      destination: { key: 'zesia', url: origin + '/v1/rooms/' + roomId + '/admission' },
      goal: { title: packet.project, line: (packet.context.goal || packet.brief).slice(0, 240).trim() },
      identity: { proposedParticipantId: 'local-agent', agentLabel: packet.requester, projectLabel: packet.project,
        keyAlgorithm: 'ECDSA_P256_SHA256', publicKeySpki: publicKey.toString('base64url'), keyFingerprint: sha(publicKey) },
      manifest: files.map(file => ({
        materialId: file.id, name: file.name, kind: file.kind, mediaType: file.mediaType, bytes: file.bytes.length, sha256: sha(file.bytes),
      })),
      packetSha256: digest(packet), maxRounds: 3, maxMicros: 5_000_000,
      ...(workspaceMode !== undefined && { workspaceMode }),
    };
    admission.approvalHash = digest(admission);
    const group = { roomId, packet, files, origin, admission, key: key.privateKey, status: 'prepared' };
    await store.save({ id: roomId, kind: 'draft', groupDraft: true, title: admission.goal.title, packet, status: 'prepared',
      updatedAt: iso(now()), expiresAt: admission.expiresAt });
    active.set(roomId, group);
    return roomId;
  }

  const groupUrl = group => group.origin + '/consult?room=' + group.roomId;
  const signFor = (group, value) => sign('sha256', Buffer.from(digest(value)), { key: group.key, ...SIGN_OPTIONS }).toString('base64url');

  async function driverOperation(roomId, operation, payload) {
    const group = active.get(roomId);
    if (group?.admission.workspaceMode !== 'byo_agent' || group.status !== 'active') {
      throw Error('Open and approve a BYO-Agent draft before using the driver.');
    }
    if (!driverOperations.has(operation) || !payload || Array.isArray(payload) || typeof payload !== 'object'
      || typeof payload.commandId !== 'string' || !id.test(payload.commandId)
      || (payload.scopeHash !== undefined && (typeof payload.scopeHash !== 'string' || !hash.test(payload.scopeHash)))) {
      throw Error('Use a supported driver operation with a stable command ID and approved scope.');
    }
    if (operation === 'submit_verify' && payload.kind === 'handback') {
      const saved = await store.readDriverDelivery(roomId, payload.deliveryId);
      return finishDriver(group, saved.sealed);
    }
    if (operation === 'submit_verify' && !['submit', 'status'].includes(payload.kind)) {
      throw Error('Use submit_verify to submit a runbook, check its status, or resume local handback.');
    }
    const result = await requestDriver(group, operation, payload);
    if (operation === 'submit_verify' && result.state === 'passed' && result.delivery) {
      const sealed = result.delivery;
      validateDelivery(group, sealed);
      await store.saveDriverDelivery(roomId, sealed, async output => {
        const { manifest, manifestSha256 } = sealed;
        const downloaded = await requestDriver(group, 'submit_verify', {
          kind: 'download', commandId: 'download_' + digest([manifest.deliveryId, output.artifactId]).slice(0, 48),
          scopeHash: manifest.scopeHash, deliveryId: manifest.deliveryId, requestId: manifest.requestId,
          manifestSha256, artifactId: output.artifactId, objectVersion: output.objectVersion,
        });
        if (!downloaded.ok || digest(downloaded.artifact) !== digest(output) || typeof downloaded.base64 !== 'string') {
          throw Error('The verified output could not be downloaded. Check the original submission status.');
        }
        return Buffer.from(downloaded.base64, 'base64');
      });
      return finishDriver(group, sealed);
    }
    if (operation === 'sync' && result.capabilities?.some(item => item.state === 'awaiting_approval')) {
      return { ...result, workspaceUrl: groupUrl(group),
        message: 'A capability call is waiting for human confirmation. After the decision, use the same call ID and parameters.' };
    }
    return result;
  }

  async function requestDriver(group, operation, payload) {
    let scopeHash = payload.scopeHash;
    if (!scopeHash) {
      const session = await (await send(group, 'session')).json();
      if (session.room?.roomId !== group.roomId || session.admissionBinding?.requestId !== group.admission.requestId
        || session.admissionBinding?.keyFingerprint !== group.admission.identity.keyFingerprint) {
        throw Error('Unexpected cloud room identity.');
      }
      if (session.room.stage !== 'workspace_swarm' || !hash.test(session.room.approvedScopeHash ?? '')) {
        return { ok: false, operationId: payload.commandId, outcome: 'not_started', code: 'room_workspace_approval_required' };
      }
      scopeHash = session.room.approvedScopeHash;
    }
    const path = 'driver/' + operation;
    const body = { ...payload, protocol: driverProtocol, scopeHash };
    const signature = signFor(group, ['zesia.room.caller-command.v1', group.roomId, path, body]);
    const unknown = { ok: false, operationId: payload.commandId, outcome: 'unknown', code: 'room_driver_transport_unknown' };
    let response, result;
    try {
      response = await send(group, path, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-zesia-room-signature': signature },
        body: JSON.stringify(body),
      }, { timeoutMs: 90_000, allowRoomError: true });
      result = JSON.parse((await boundedBytes(response, 3 * 1024 * 1024)).toString('utf8'));
    } catch { return unknown; }
    if (!response.ok) return { ...(response.status >= 500 ? unknown : { ...unknown, outcome: 'not_started' }),
      code: typeof result?.code === 'string' && id.test(result.code) ? result.code : unknown.code, status: response.status };
    return result?.ok === true ? result : unknown;
  }

  function validateDelivery(group, sealed) {
    const { manifest, manifestSha256, localReceiptSha256 } = sealed ?? {};
    if (manifest?.format !== 'zesia.driver.delivery.v1' || manifest.roomId !== group.roomId
      || manifest.requestId !== group.admission.requestId || !hash.test(manifest.scopeHash) || !id.test(manifest.deliveryId)
      || !Array.isArray(manifest.outputs) || !manifest.outputs.length || manifest.outputs.length > 8
      || new Set(manifest.outputs.map(item => item.path)).size !== manifest.outputs.length
      || !/^sha256:[a-f0-9]{64}$/u.test(manifest.proof?.image) || !Array.isArray(manifest.proof?.inputs)
      || !Array.isArray(manifest.proof?.cmd) || !Array.isArray(manifest.proof?.assertions)
      || !manifest.proof.assertions.length || manifest.proof.assertions.some(item => item.passed !== true)
      || digest(manifest) !== manifestSha256) throw Error('The delivery manifest failed verification.');
    const receipt = {
      format: 'zesia.driver.local-receipt.v1', deliveryId: manifest.deliveryId, manifestSha256,
      outputs: manifest.outputs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
    };
    if (digest(receipt) !== localReceiptSha256) throw Error('The local receipt digest does not match the delivery.');
  }

  async function finishDriver(group, sealed) {
    validateDelivery(group, sealed);
    const { manifest, manifestSha256, localReceiptSha256 } = sealed;
    const { deliveryId, requestId, scopeHash, outputs, proof } = manifest;
    const binding = { deliveryId, requestId, scopeHash, manifestSha256, localReceiptSha256,
      publicKeySpki: group.admission.identity.publicKeySpki };
    const ask = kind => requestDriver(group, 'submit_verify', { ...binding, kind, commandId: kind + '_' + digest(deliveryId).slice(0, 48) });
    let retirement = await ask('retirement');
    if (retirement.state === 'awaiting_ack') retirement = await ask('ack');
    for (let check = 0; check < 8 && retirement.state === 'cleaning'; check++) {
      await pause(250);
      retirement = await ask('retirement');
    }
    if (retirement.state !== 'purged') {
      return { ok: true, state: 'handback_pending', deliveryId,
        message: 'The files are saved locally. Resume handback with this delivery ID to recover cloud cleanup confirmation.' };
    }
    if (retirement.deliveryId !== deliveryId || retirement.requestId !== requestId || retirement.scopeHash !== scopeHash
      || retirement.manifestSha256 !== manifestSha256 || retirement.localReceiptSha256 !== localReceiptSha256
      || !Number.isFinite(Date.parse(retirement.cloudPurgedAt)) || !Number.isFinite(Date.parse(retirement.acknowledgedAt))
      || Date.parse(retirement.cloudPurgedAt) < Date.parse(retirement.acknowledgedAt)) {
      throw Error('The cloud cleanup receipt does not match the local delivery.');
    }
    const cloudPurgedAt = retirement.cloudPurgedAt;
    const attestation = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: outputs.map(({ path, sha256 }) => ({ name: path, digest: { sha256 } })),
      predicateType: 'https://zesia.dev/attestations/clean-room/v1',
      predicate: { ...proof, deliveryId, scopeHash, manifestSha256, localReceiptSha256, cloudPurgedAt,
        outputs: outputs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })) },
    };
    const text = 'Clean-Room replay and semantic review passed. The verified files were saved locally and the cloud copy was cleared.';
    const summary = ['# Verified delivery', '', text, '', ...attestation.subject.map(item => '- ' + item.name
      + ' · SHA-256 ' + item.digest.sha256), '', 'Cloud cleanup confirmed at ' + cloudPurgedAt, ''].join('\n');
    const driverProof = await store.saveDriverProof(group.roomId, deliveryId,
      Buffer.from(JSON.stringify(stable(attestation), null, 2) + '\n'), Buffer.from(summary));
    await store.save({ id: group.roomId, kind: 'group', title: group.admission.goal.title, status: 'completed',
      updatedAt: iso(now()), result: { receiptId: deliveryId, text }, driverProof, cloudCopy: { state: 'purged', cloudPurgedAt } });
    await store.removeDriverRecovery(group.roomId);
    return { ok: true, state: 'completed', deliveryId, cloudPurgedAt, ...driverProof };
  }

  async function resumeDriver(roomId) {
    const recovery = await store.readDriverRecovery(roomId);
    const origin = destinationOf((await configuration()).url);
    const { requestId, identity, title, privateKey } = recovery;
    if (recovery.origin !== origin || roomId !== 'room_' + digest(['zesia-room-v1', requestId]).slice(0, 48)) {
      throw Error('Restore the approved destination and account.');
    }
    const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64url'), type: 'pkcs8', format: 'der' });
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
    if (publicKey.toString('base64url') !== identity.publicKeySpki || sha(publicKey) !== identity.keyFingerprint) {
      throw Error('The local driver recovery key does not match the approved room.');
    }
    active.set(roomId, { roomId, origin, key, status: 'active', admission: {
      requestId, identity, workspaceMode: 'byo_agent', goal: { title },
      destination: { key: 'zesia', url: origin + '/v1/rooms/' + roomId + '/admission' },
    } });
    return { groupId: roomId, status: 'active', url: groupUrl(active.get(roomId)) };
  }

  async function decision({ id: roomId, approvalHash, approved, proof }) {
    const group = active.get(roomId);
    if (!group || group.admission.approvalHash !== approvalHash || Date.parse(group.admission.expiresAt) <= now()
      || typeof approved !== 'boolean') throw Error('The exact group draft is no longer available.');
    if (group.status !== 'prepared') throw Error('The decision has already been recorded.');
    if (!approved) {
      await store.remove('draft', roomId);
      active.delete(roomId);
      return { cancelled: true };
    }
    if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{40,8192}$/u.test(proof)) throw Error('A human approval proof is required.');
    group.status = 'confirming';
    await store.save({ id: roomId, kind: 'group', title: group.admission.goal.title,
      status: 'confirming', updatedAt: iso(now()), url: groupUrl(group) });
    if (group.admission.workspaceMode === 'byo_agent') {
      await store.saveDriverRecovery(roomId, {
        origin: group.origin, requestId: group.admission.requestId, title: group.admission.goal.title, identity: group.admission.identity,
        privateKey: group.key.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
      });
    }
    await store.remove('draft', roomId);
    const signature = signFor(group, ['zesia.room.caller-admission.v1', roomId, approvalHash]);
    const response = await send(group, 'admission', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ admission: group.admission, packet: group.packet, signature, proof }),
    });
    const admitted = await response.json();
    if (admitted.roomId !== roomId) throw Error('Unexpected cloud room identity.');
    group.status = 'active';
    await store.save({ id: roomId, kind: 'group', title: group.admission.goal.title,
      status: 'active', updatedAt: iso(now()), url: groupUrl(group) });
    return { url: groupUrl(group) };
  }

  async function admitTrusted(roomId) {
    const group = active.get(roomId);
    if (!trustedHost || group?.status !== 'prepared' || group.origin !== trustedHost.origin) return undefined;
    const admission = group.admission;
    const scope = {
      purpose: 'admission', subjectId: admission.draftId, requestId: admission.requestId,
      scopeHash: admission.approvalHash, keyFingerprint: admission.identity.keyFingerprint,
      destination: admission.destination, decision: 'approved', expiresAt: admission.expiresAt,
    };
    let proof;
    try {
      const response = await send(group, 'trusted-proof', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: trustedHost.host, scope,
          signature: trustedHost.sign(digest(['zesia.room.trusted-consult.v1', roomId, scope])) }),
      });
      proof = (await response.json()).proof;
    } catch { return undefined; }
    try {
      return await decision({ id: roomId, approvalHash: admission.approvalHash, approved: true, proof });
    } catch {
      // The request may have reached the cloud. Keep the original room and
      // observe it, without making another submission or opening manual Send.
      return group.status === 'confirming' ? { url: groupUrl(group), confirming: true } : undefined;
    }
  }

  async function archive(group) {
    const response = await send(group, 'session');
    const session = await response.json();
    if (!response.ok) {
      if (response.status === 410 && session.code === 'room_cloud_copy_cleaning') return;
      if (response.status !== 404 || session.code !== 'room_cloud_copy_purged') {
        throw Error('The cloud room did not confirm this operation.');
      }
      const saved = await store.read('group', group.roomId);
      if (['completed', 'blocked'].includes(saved.status) && saved.result?.receiptId && saved.snapshot?.room?.roomId === group.roomId) {
        await store.save({ ...saved, updatedAt: iso(now()), cloudCopy: { ...saved.cloudCopy, state: 'purged' } });
        active.delete(group.roomId);
      }
      return;
    }
    if (session.room?.roomId !== group.roomId || session.admissionBinding?.requestId !== group.admission.requestId
      || session.admissionBinding?.keyFingerprint !== group.admission.identity.keyFingerprint) throw Error('Unexpected cloud room identity.');
    group.status = 'active';
    if (group.awaitingRetirement || group.admission.workspaceMode === 'byo_agent') return;
    if (!session.result?.receiptId || !id.test(session.result.receiptId)) return;
    const diagnosis = session.result.diagnosis;
    if (diagnosis && (session.room.lifecycle?.state !== 'blocked'
      || !['objective_blocker', 'verification_incomplete'].includes(diagnosis.kind)
      || !['checked', 'constraint', 'finding', 'nextStep'].every(key => typeof diagnosis[key] === 'string' && diagnosis[key].length <= 800)
      || !Array.isArray(diagnosis.evidence) || !Array.isArray(diagnosis.checks))) throw Error('Invalid workspace diagnostic.');
    const refs = session.result.artifacts ?? [];
    if (!Array.isArray(refs) || refs.length > maxArtifacts) throw Error('Invalid cloud artifacts.');
    const artifacts = [];
    for (const ref of refs) {
      if (!id.test(ref.artifactId) || !ref.objectVersion || !hash.test(ref.sha256)
        || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > maxOutputBytes) throw Error('Invalid cloud artifact reference.');
      const url = 'artifact?' + new URLSearchParams({ id: ref.artifactId, version: ref.objectVersion });
      const response = await send(group, url);
      const bytes = await boundedBytes(response, ref.bytes);
      await store.saveArtifact(group.roomId, ref, bytes);
      artifacts.push({ ...ref, filename: filenameFor(response, ref) });
    }
    const events = [];
    let since = 0;
    for (;;) {
      const page = await (await send(group, 'events?' + new URLSearchParams({ since, limit: 100 }))).json();
      if (!Array.isArray(page.events)) throw Error('Invalid cloud audit page.');
      events.push(...page.events);
      if (!page.hasMore) break;
      if (!Number.isSafeInteger(page.nextSince) || page.nextSince <= since || events.length > 3000) throw Error('Cloud audit did not advance.');
      since = page.nextSince;
    }
    const { csrf: _csrf, admissionBinding: _binding, ...snapshot } = session;
    const saved = {
      id: group.roomId, kind: 'group', title: group.admission.goal.title, status: diagnosis ? 'blocked' : 'completed',
      updatedAt: iso(now()), url: groupUrl(group), result: session.result, snapshot, events, artifacts, packet: group.packet,
    };
    await store.save(saved);
    if (session.cloudCopy) {
      const value = { receiptId: session.result.receiptId };
      const signature = signFor(group, ['zesia.room.caller-command.v1', group.roomId, 'handback', value]);
      const ack = await (await send(group, 'handback', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-zesia-room-signature': signature },
        body: JSON.stringify(value),
      })).json();
      await store.save({ ...saved, cloudCopy: { expiresAt: ack.expiresAt, acknowledgedAt: ack.acknowledgedAt } });
      if (ack.acknowledgedAt && ack.expiresAt === ack.acknowledgedAt) {
        group.awaitingRetirement = true;
        return;
      }
    }
    active.delete(group.roomId);
  }

  return {
    stage, decision, admitTrusted, driverOperation, resumeDriver,
    list: () => Array.from(active.values(), group => ({
      id: group.roomId, kind: group.status === 'prepared' ? 'draft' : 'group', title: group.admission.goal.title,
      status: group.status, groupDraft: group.status === 'prepared', updatedAt: group.admission.expiresAt,
      ...(group.status === 'active' && { url: groupUrl(group) }),
    })),
    preview(roomId) {
      const group = active.get(roomId);
      if (!group || group.status !== 'prepared') return null;
      return {
        stage: 'admission', admission: group.admission,
        materials: group.files.map(file => ({
          id: file.id, name: file.name, ...(file.text !== undefined ? { text: file.text } : { downloadable: true }),
        })),
      };
    },
    attachment(roomId, artifactId) {
      const group = active.get(roomId);
      const file = group?.status === 'prepared' && group.files.find(item => item.id === artifactId && item.kind === 'attachment');
      if (!file) throw Error('The draft attachment is unavailable.');
      return { ...file, filename: file.name };
    },
    async sync() {
      for (const group of active.values()) {
        if (!['active', 'confirming'].includes(group.status) || group.syncing) continue;
        group.syncing = true;
        try { await archive(group); }
        catch {
          // Unknown admission or handback retains the original scope. Only poll.
          if (Date.parse(group.admission.expiresAt) + 26 * 3_600_000 <= now()) active.delete(group.roomId);
        }
        finally { group.syncing = false; }
      }
    },
  };
}
