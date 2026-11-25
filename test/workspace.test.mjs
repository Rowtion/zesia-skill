import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPortable } from '../runtime.mjs';
import { createWorkspaceStore, workspaceGroupResult } from '../runtime/workspace.mjs';
import { createGroupWorkflow } from '../runtime/collab-room.mjs';
import { startWorkspaceReview } from '../review/workspace.mjs';

const origin = 'https://zesia-consult-staging.cprindex.workers.dev';
const configuration = async () => ({ url: origin, token: 'offline-test-credential' });
const packet = { requester: 'Local Agent', project: 'Inventory audit', brief: 'Reconcile the supplied counts.', context: {
  materials: [{ id: 'counts', content: 'Synthetic fixture' }],
} };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => sha(JSON.stringify(stable(value)));

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'workspace-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createWorkspaceStore(directory) };
}

for (const mode of ['the recovery window', 'immediate cleanup', 'a lost cleanup acknowledgement']) test('Group verifies local handback with ' + mode, async t => {
  const { directory, store } = await workspace(t);
  const bytes = Buffer.from('{"total":3}');
  const ref = { artifactId: 'summary', objectVersion: 'version-1', sha256: sha(bytes), bytes: bytes.length, mediaType: 'application/json' };
  const paths = [];
  let admission;
  let correctArtifact = false;
  let cleaning = false;
  let purged = false;
  const acknowledgedAt = '2026-11-24T05:00:00.000Z';
  const group = createGroupWorkflow({ store, configuration, async fetchRequest(url, options) {
    const current = new URL(url);
    assert.equal(current.origin, origin);
    assert.equal(options.redirect, 'error');
    const [, roomId, action] = /\/rooms\/([^/]+)\/([^/]+)$/.exec(current.pathname);
    paths.push(action);
    switch (action) {
      case 'admission': {
        const body = JSON.parse(options.body);
        admission = body.admission;
        assert.equal(body.signature.length, 86);
        return Response.json({ roomId }, { status: 202 });
      }
      case 'session': return purged ? Response.json({ code: 'room_cloud_copy_purged' }, { status: 404 })
        : cleaning ? Response.json({ code: 'room_cloud_copy_cleaning' }, { status: 410 }) : Response.json({
        room: { roomId }, admissionBinding: { requestId: admission.requestId, keyFingerprint: admission.identity.keyFingerprint },
        result: { receiptId: 'archive', text: 'Done', artifacts: [ref] }, cloudCopy: {},
      });
      case 'artifact': {
        assert.equal(current.searchParams.get('version'), ref.objectVersion);
        return new Response(correctArtifact ? bytes : Buffer.alloc(bytes.length), {
          headers: { 'content-disposition': "attachment; filename*=UTF-8''summary.json" },
        });
      }
      case 'events': return Response.json({ events: [{ seq: 1, type: 'archive.verified' }], hasMore: false });
      case 'handback': {
        assert.equal(JSON.parse(options.body).receiptId, 'archive');
        assert.equal(options.headers['x-zesia-room-signature'].length, 86);
        assert.deepEqual((await store.readArtifact(roomId, 'summary')).bytes, bytes);
        assert.deepEqual((await store.read('group', roomId)).events, [{ seq: 1, type: 'archive.verified' }]);
        if (mode === 'the recovery window') return Response.json({ expiresAt: '2026-11-24T06:00:00.000Z', acknowledgedAt });
        cleaning = true;
        if (mode === 'a lost cleanup acknowledgement') throw Error('Synthetic lost acknowledgement');
        return Response.json({ expiresAt: acknowledgedAt, acknowledgedAt });
      }
      default: assert.fail('Unexpected operation');
    }
  } });
  const roomId = await group.stage(packet);
  const preview = group.preview(roomId);
  assert.equal((await workspaceGroupResult(store, roomId)).status, 'pending');
  assert.deepEqual(paths, []);
  assert.equal(preview.materials[0].text, packet.context.materials[0].content);
  const staged = JSON.parse(await readFile(join(directory, 'workspace-v1', 'draft', roomId + '.json'), 'utf8'));
  assert.equal(staged.packet.brief, packet.brief);
  assert.equal(staged.key, undefined);
  await assert.rejects(group.decision({ id: roomId, approved: true, approvalHash: preview.admission.approvalHash }));
  await group.decision({ id: roomId, approved: true, approvalHash: preview.admission.approvalHash, proof: randomBytes(40).toString('base64url') });
  await group.sync();
  assert.equal(paths.includes('handback'), false);
  correctArtifact = true;
  await group.sync();
  const saved = await store.read('group', roomId);
  assert.equal(saved.artifacts[0].filename, 'summary.json');
  assert.equal(saved.cloudCopy?.acknowledgedAt, mode === 'a lost cleanup acknowledgement' ? undefined : acknowledgedAt);
  if (mode !== 'the recovery window') {
    await group.sync();
    assert.equal((await store.read('group', roomId)).cloudCopy?.state, undefined);
    purged = true;
    await group.sync();
    assert.equal((await store.read('group', roomId)).cloudCopy.state, 'purged');
  }
  assert.equal(paths.filter(action => action === 'admission').length, 1);
  assert.equal(paths.filter(action => action === 'handback').length, 1);
  assert.equal(group.list().length, 0);
  assert.equal((await store.list()).length, 1);
  const handback = await workspaceGroupResult(store, roomId);
  assert.equal(handback.receiptId, 'archive');
  assert.equal(handback.artifacts[0].bytes, bytes.length);
  assert.deepEqual(await readFile(handback.artifacts[0].path), bytes);
  assert.equal(paths.filter(action => action === 'session').length, mode === 'the recovery window' ? 2 : 4);
});

test('the BYO driver signs a fixed operation for the approved room and never repeats an unknown send', async t => {
  const { store } = await workspace(t);
  const scopeHash = 'a'.repeat(64);
  const writes = [];
  let signer;
  let admission;
  let approved = false;
  let markAdmission, finishAdmission;
  const entered = new Promise(resolve => { markAdmission = resolve; });
  const admissionResponse = new Promise(resolve => { finishAdmission = resolve; });
  const group = createGroupWorkflow({ store, configuration, async fetchRequest(url, options) {
    const target = new URL(url);
    assert.equal(target.origin, origin);
    const [, roomId, path] = /\/rooms\/([^/]+)\/(.+)$/u.exec(target.pathname);
    if (path === 'session') return Response.json({
      room: { roomId, stage: approved ? 'workspace_swarm' : 'direct_consult', approvedScopeHash: scopeHash },
      admissionBinding: { requestId: admission.requestId, keyFingerprint: admission.identity.keyFingerprint },
    });
    const value = JSON.parse(options.body);
    if (path === 'admission') {
      assert.equal(value.admission.workspaceMode, 'byo_agent');
      admission = value.admission;
      signer = createPublicKey({ key: Buffer.from(value.admission.identity.publicKeySpki, 'base64url'), type: 'spki', format: 'der' });
      markAdmission();
      await admissionResponse;
      throw Error('Synthetic loss after the admission was sent.');
    }
    writes.push({ path, id: value.commandId });
    const body = { commandId: value.commandId, protocol: value.protocol, scopeHash: value.scopeHash };
    assert.equal(value.protocol, 'zesia.driver.v1');
    const signed = sha(JSON.stringify(['zesia.room.caller-command.v1', roomId, path, body]));
    assert.equal(verify('sha256', Buffer.from(signed), { key: signer, dsaEncoding: 'ieee-p1363' },
      Buffer.from(options.headers['x-zesia-room-signature'], 'base64url')), true);
    if (path === 'driver/exec') throw Error('Transport disconnected after sending');
    if (path === 'driver/consult') return Response.json({ ok: false, code: 'request_budget_exceeded' }, { status: 429 });
    return Response.json({ ok: true, scopeHash });
  } });
  const roomId = await group.stage(packet, { workspaceMode: 'byo_agent' });
  const data = { scopeHash, commandId: 'join-test' };
  await assert.rejects(group.driverOperation(roomId, 'join', data), /approve/u);
  assert.deepEqual(writes, []);
  const { admission: preview } = group.preview(roomId);
  await assert.rejects(store.readDriverRecovery(roomId), { code: 'ENOENT' });
  const admissionAttempt = group.decision({ id: roomId, approved: true, approvalHash: preview.approvalHash,
    proof: randomBytes(40).toString('base64url') });
  await entered;
  await assert.rejects(store.readDriverRecovery(roomId), { code: 'ENOENT' });
  finishAdmission();
  await assert.rejects(admissionAttempt, /disconnected|loss after the admission|confirmed/u);
  await assert.rejects(store.readDriverRecovery(roomId), { code: 'ENOENT' });
  await group.sync();
  assert.equal((await group.driverOperation(roomId, 'join', { commandId: data.commandId })).code, 'room_workspace_approval_required');
  assert.equal((await store.readDriverRecovery(roomId)).requestId, admission.requestId);
  approved = true;
  assert.equal((await group.driverOperation(roomId, 'join', { commandId: data.commandId })).scopeHash, scopeHash);
  await assert.rejects(group.driverOperation(roomId, 'tools/list_changed', data), /supported driver operation/u);
  const lost = await group.driverOperation(roomId, 'exec', { ...data, commandId: 'write-test' });
  assert.equal(lost.outcome, 'unknown');
  assert.equal(lost.operationId, 'write-test');
  const refused = await group.driverOperation(roomId, 'consult', { ...data, commandId: 'consult-test' });
  assert.equal(refused.code, 'request_budget_exceeded');
  assert.deepEqual(writes, [{ path: 'driver/join', id: 'join-test' }, { path: 'driver/exec', id: 'write-test' },
    { path: 'driver/consult', id: 'consult-test' }]);
});

test('clean expires private BYO recovery state while retaining the local group', async t => {
  const { directory, store } = await workspace(t);
  const now = Date.now();
  const roomId = character => 'room_' + character.repeat(48);
  const recovery = time => ({ requestId: 'zrq-' + time + '-' + 'a'.repeat(40) });
  await store.save({ id: roomId('a'), kind: 'group', status: 'active', updatedAt: new Date(now).toISOString() });
  await store.saveDriverRecovery(roomId('a'), recovery(now - 49 * 60 * 60 * 1000));
  await store.saveDriverRecovery(roomId('b'), recovery(now));
  await store.saveDriverRecovery(roomId('c'), recovery(now - 49 * 60 * 60 * 1000));
  await assert.rejects(store.readDriverRecovery(roomId('c'), now), /expired/u);
  await assert.rejects(store.readDriverRecovery(roomId('c'), now), { code: 'ENOENT' });
  const runtime = createPortable({ workspaceDir: directory, stateDir: join(directory, 'consult'), now: () => now });
  assert.deepEqual((await runtime.clean()).driverRecovery, [roomId('a')]);
  assert.equal((await store.readDriverRecovery(roomId('a'), now - 2 * 60 * 60 * 1000)).requestId, recovery(now - 49 * 60 * 60 * 1000).requestId);
  assert.deepEqual((await runtime.clean({ apply: true })).driverRecovery, [roomId('a')]);
  assert.equal((await store.read('group', roomId('a'))).status, 'active');
  assert.deepEqual((await runtime.clean({ all: true, apply: true })).driverRecovery, [roomId('b')]);
  await assert.rejects(store.readDriverRecovery(roomId('b'), now), { code: 'ENOENT' });
});

for (const expired of [false, true]) test(expired
  ? 'BYO handback retains local files when the cloud expires before ACK'
  : 'BYO handback validates bytes, survives a lost ACK, and publishes a deterministic proof', async t => {
  const { directory, store } = await workspace(t);
  const scopeHash = 'a'.repeat(64);
  const text = Buffer.from('{"rows":3}');
  const output = { artifactId: 'summary_json', path: 'output/summary.json', objectVersion: 'verified-version',
    sha256: sha(text), bytes: text.length, mediaType: 'application/json' };
  const deliveryId = 'delivery_fixture';
  const cloudPurgedAt = '2026-11-25T00:00:01.000Z';
  const acknowledgedAt = '2026-11-25T00:00:00.000Z';
  let signer, sealed, roomId;
  let corrupt = true;
  let duplicate = true;
  let acknowledged = false;
  let retired = false;
  let sends = 0;
  let downloads = 0;
  async function fetchRequest(url, options) {
    const [, id, path] = /\/rooms\/([^/]+)\/(.+)$/u.exec(new URL(url).pathname);
    const value = JSON.parse(options.body);
    if (path === 'admission') {
      const { requestId, identity } = value.admission;
      signer = createPublicKey({ key: Buffer.from(identity.publicKeySpki, 'base64url'), type: 'spki', format: 'der' });
      const manifest = { format: 'zesia.driver.delivery.v1', roomId: id, requestId, scopeHash, submissionId: 'submit-runbook',
        deliveryId, outputs: [output], proof: { inputs: [{ kind: 'material', path: 'input/orders', sha256: 'b'.repeat(64) }],
          cmd: [['python3', 'input/main.py']], image: 'sha256:' + 'c'.repeat(64),
          assertions: [{ assertionId: 'rows', passed: true }], semanticReview: { inputDigest: 'd'.repeat(64), verdictSha256: 'e'.repeat(64) } } };
      const manifestSha256 = digest(manifest);
      sealed = { manifest, manifestSha256, localReceiptSha256: digest({
        format: 'zesia.driver.local-receipt.v1', deliveryId, manifestSha256,
        outputs: [{ path: output.path, sha256: output.sha256, bytes: output.bytes }],
      }) };
      return Response.json({ roomId: id }, { status: 202 });
    }
    assert.equal(path, 'driver/submit_verify');
    assert.equal(verify('sha256', Buffer.from(digest(['zesia.room.caller-command.v1', roomId, path, value])),
      { key: signer, dsaEncoding: 'ieee-p1363' }, Buffer.from(options.headers['x-zesia-room-signature'], 'base64url')), true);
    if (['submit', 'status'].includes(value.kind)) {
      const manifest = duplicate
        ? { ...sealed.manifest, outputs: [output, { ...output, path: 'output/second.json' }] }
        : sealed.manifest;
      const manifestSha256 = digest(manifest);
      const localReceiptSha256 = digest({
        format: 'zesia.driver.local-receipt.v1', deliveryId, manifestSha256,
        outputs: manifest.outputs.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      });
      return Response.json({ ok: true, state: 'passed', delivery: { manifest, manifestSha256, localReceiptSha256 } });
    }
    if (value.kind === 'download') {
      downloads++;
      return Response.json({ ok: true, artifact: output, base64: (corrupt ? Buffer.alloc(text.length) : text).toString('base64') });
    }
    assert.equal(value.localReceiptSha256, sealed.localReceiptSha256);
    const { artifacts } = await store.readDriverDelivery(roomId, deliveryId);
    assert.deepEqual(await readFile(artifacts[0].path), text);
    const receipt = { ok: true, deliveryId, scopeHash, requestId: sealed.manifest.requestId,
      manifestSha256: sealed.manifestSha256, localReceiptSha256: sealed.localReceiptSha256 };
    if (value.kind === 'ack') {
      sends++;
      acknowledged = !expired;
      throw Error('Synthetic loss during ACK.');
    }
    assert.equal(value.kind, 'retirement');
    if (retired) return Response.json({ ...receipt, state: 'expired', cloudPurgedAt });
    return Response.json(acknowledged ? { ...receipt, state: 'purged', acknowledgedAt, cloudPurgedAt }
      : { ...receipt, state: 'awaiting_ack' });
  }
  const group = createGroupWorkflow({ store, configuration, fetchRequest });
  roomId = await group.stage(packet, { workspaceMode: 'byo_agent' });
  const { admission } = group.preview(roomId);
  await group.decision({ id: roomId, approved: true, approvalHash: admission.approvalHash, proof: randomBytes(40).toString('base64url') });
  const body = { scopeHash, kind: 'submit', commandId: 'submit-runbook', runbook: { version: 1 } };
  await assert.rejects(group.driverOperation(roomId, 'submit_verify', body), /delivery manifest failed verification/u);
  assert.equal(downloads, 0);
  duplicate = false;
  await assert.rejects(group.driverOperation(roomId, 'submit_verify', body), /failed verification/u);
  assert.equal(sends, 0);
  await assert.rejects(store.readDriverDelivery(roomId, deliveryId), { code: 'ENOENT' });
  corrupt = false;
  const pending = await group.driverOperation(roomId, 'submit_verify', {
    scopeHash, kind: 'status', submissionId: body.commandId, commandId: 'status-runbook',
  });
  assert.equal(pending.state, 'handback_pending');
  const restarted = createGroupWorkflow({ store, configuration, fetchRequest });
  await restarted.resumeDriver(roomId);
  const finish = () => restarted.driverOperation(roomId, 'submit_verify', { kind: 'handback', commandId: 'resume-room', deliveryId });
  retired = expired;
  const completed = await finish();
  assert.equal(completed.state, expired ? 'expired' : 'completed');
  const final = await workspaceGroupResult(store, roomId);
  assert.equal(final.cloudPurgedAt, cloudPurgedAt);
  assert.equal(final.artifacts[0].path.startsWith(directory + '/'), true);
  assert.deepEqual(await readFile(final.artifacts[0].path), text);
  assert.equal(sends, 1);
  assert.equal(downloads, 2);
  await assert.rejects(store.readDriverRecovery(roomId), { code: 'ENOENT' });
  if (expired) {
    assert.equal(final.status, 'expired');
    assert.equal(final.attestationPath, undefined);
    return;
  }
  const proof = await readFile(final.attestationPath);
  const attestation = JSON.parse(proof);
  assert.equal(attestation._type, 'https://in-toto.io/Statement/v1');
  assert.deepEqual(attestation.subject, [{ name: 'output/summary.json', digest: { sha256: output.sha256 } }]);
  assert.equal(attestation.predicate.localReceiptSha256, sealed.localReceiptSha256);
  assert.equal(attestation.predicate.cloudPurgedAt, cloudPurgedAt);
  assert.match(await readFile(final.summaryPath, 'utf8'), /Cloud cleanup confirmed/u);
  assert.deepEqual(await finish(), completed);
  assert.deepEqual(await readFile(final.attestationPath), proof);
  assert.equal(sends, 1);
  assert.equal(downloads, 2);
});

test('Workspace bridge scopes reads to loopback origin and capability', async t => {
  const { directory, store } = await workspace(t);
  await store.save({ id: 'room_a', kind: 'group', status: 'completed', title: 'Group', updatedAt: new Date().toISOString() });
  await symlink(join(directory, 'workspace-v1', 'group', 'room_a.json'), join(directory, 'workspace-v1', 'group', 'linked.json'));
  assert.equal((await store.list()).length, 1);
  await assert.rejects(store.read('group', 'linked'));
  await assert.rejects(store.read('group', '../test'));

  const review = await startWorkspaceReview({ runtime: { list: async () => ({ records: [] }) }, store, origin, configuration });
  t.after(() => review.close());
  const fragment = new URLSearchParams(new URL(review.url).hash.slice(1));
  const local = 'http://127.0.0.1:' + fragment.get('port') + '/bridge/v1/workspace';
  const authorization = 'Bearer ' + fragment.get('key');
  assert.equal((await fetch(local, { headers: { origin } })).status, 403);
  assert.equal((await fetch(local, { headers: { origin: 'https://example.invalid', authorization } })).status, 403);
  const response = await fetch(local, { headers: { origin, authorization } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessions[0].id, 'room_a');
});
