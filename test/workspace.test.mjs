import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceStore, workspaceGroupResult } from '../runtime/workspace.mjs';
import { createGroupWorkflow } from '../runtime/collab-room.mjs';
import { startWorkspaceReview } from '../review/workspace.mjs';

const origin = 'https://zesia-consult-staging.cprindex.workers.dev';
const configuration = async () => ({ url: origin, token: 'offline-test-credential' });
const packet = { requester: 'Local Agent', project: 'Inventory audit', brief: 'Reconcile the supplied counts.', context: {
  materials: [{ id: 'counts', content: 'Synthetic fixture' }],
} };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

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
