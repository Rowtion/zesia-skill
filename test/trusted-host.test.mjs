import assert from 'node:assert/strict';
import { createHash, verify, createPublicKey } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGroupWorkflow } from '../runtime/collab-room.mjs';
import { trustedHostIdentity } from '../runtime/trusted-host.mjs';
import { createWorkspaceStore, workspaceGroupResult } from '../runtime/workspace.mjs';

const trustedDestination = 'https://staging.example.test';
const verification = { path: '/verified/host', executableSha256: '1'.repeat(64), label: 'Codex' };
const packet = { requester: 'Codex', project: 'Synthetic summary', brief: 'Reconcile approved rows.' };

test('the key is stable for an observed installation and exact destination', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zesia-host-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const identity = (origin = trustedDestination, installation = verification) =>
    trustedHostIdentity(origin, { directory, observe: async () => installation });
  const first = await identity();
  assert.deepEqual((await identity()).host, first.host);
  assert.notEqual((await identity('https://another.example.test')).host.keyFingerprint, first.host.keyFingerprint);
  assert.notEqual((await identity(trustedDestination, { ...verification, executableSha256: '2'.repeat(64) })).host.keyFingerprint,
    first.host.keyFingerprint);
  assert.equal(await trustedHostIdentity(trustedDestination, { directory, observe: async () => undefined }), undefined);
});

test('only an enrolled verified host sends a new draft and an objective diagnosis returns without replay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'zesia-host-group-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createWorkspaceStore(join(directory, 'workspace'));
  const trustedHost = await trustedHostIdentity(trustedDestination, {
    directory: join(directory, 'keys'), observe: async () => verification,
  });
  const configuration = async () => ({ url: trustedDestination, token: 'synthetic-key' });
  const requests = [];
  let enrolled = false;
  let admission;
  const diagnosis = {
    kind: 'objective_blocker', checked: 'Checked the input header.', constraint: 'A numeric column is required.',
    finding: 'The supplied header has no numeric column.', nextStep: 'Provide the numeric column.', evidence: [], checks: [],
  };
  const fetchRequest = async (url, options) => {
    const resource = new URL(url).pathname.split('/').at(-1);
    requests.push(resource);
    if (resource === 'trusted-proof') {
      const data = JSON.parse(options.body);
      assert.equal('packet' in data, false);
      assert.deepEqual(data.host, trustedHost.host);
      const groupId = new URL(url).pathname.split('/').at(-2);
      const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
      const hash = createHash('sha256').update(JSON.stringify(canonical(['zesia.room.trusted-consult.v1', groupId, data.scope]))).digest('hex');
      const publicKey = createPublicKey({ key: Buffer.from(data.host.publicKeySpki, 'base64url'), type: 'spki', format: 'der' });
      assert.equal(verify('sha256', Buffer.from(hash), { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(data.signature, 'base64url')), true);
      return enrolled ? Response.json({ proof: 'p'.repeat(60) }) : Response.json({}, { status: 403 });
    }
    if (resource === 'admission') {
      admission = JSON.parse(options.body).admission;
      return Response.json({ roomId: new URL(url).pathname.split('/').at(-2) });
    }
    if (resource === 'session') {
      return Response.json({
        room: { roomId: new URL(url).pathname.split('/').at(-2), lifecycle: { state: 'blocked' } },
        admissionBinding: { requestId: admission.requestId, keyFingerprint: admission.identity.keyFingerprint },
        result: { receiptId: 'blocked_verified', diagnosis },
      });
    }
    if (resource === 'events') return Response.json({ events: [], hasMore: false });
    assert.fail('Unexpected simulated request');
  };
  const unverified = createGroupWorkflow({ store, configuration, fetchRequest });
  assert.equal(await unverified.admitTrusted(await unverified.stage(packet)), undefined);
  assert.deepEqual(requests, []);
  const group = createGroupWorkflow({ store, configuration, fetchRequest, trustedHost });
  assert.equal(await group.admitTrusted(await group.stage(packet)), undefined);
  assert.deepEqual(requests, ['trusted-proof']);

  enrolled = true;
  const roomId = await group.stage(packet);
  assert.match((await group.admitTrusted(roomId)).url, /\/consult\?room=/u);
  assert.equal(await group.admitTrusted(roomId), undefined);
  await group.sync();
  assert.deepEqual(await workspaceGroupResult(store, roomId), {
    ok: true, roomId, status: 'blocked', receiptId: 'blocked_verified', diagnosis, retryAllowed: false,
  });

  enrolled = false;
  assert.equal(await group.admitTrusted(await group.stage(packet)), undefined);
  assert.equal(requests.filter(item => item === 'admission').length, 1);
});
