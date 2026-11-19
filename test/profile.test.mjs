import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createPortable } from '../runtime.mjs';
import {
  MAX_PROFILE_BYTES,
  MAX_PROFILE_ITEMS,
  MAX_PROFILE_TEXT_CHARS,
  readProfile,
  removeProfileItem,
  setProfileItem,
} from '../runtime/profile.mjs';
import { startOnlineReview } from '../review/online.mjs';

const execute = promisify(execFile);
const CLI_PATH = new URL('../cli.mjs', import.meta.url).pathname;

test('profile enforces <= 10 items, text <= 200 chars, <= 4 KB, required non-empty sourceQuote, and in-place overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-profile-bounds-'));
  const profilePath = join(dir, 'profile.json');
  let clock = 1_763_472_000_000;
  const now = () => {
    clock += 1000;
    return clock;
  };
  try {
    const initial = await readProfile(profilePath);
    assert.deepEqual(initial, { version: 1, updatedAt: null, items: [] });

    await assert.rejects(
      setProfileItem({ id: 'p1', text: 'Prefer minimal code', sourceQuote: '' }, { path: profilePath, now }),
      /sourceQuote/
    );
    await assert.rejects(
      setProfileItem({ id: 'p1', text: 'Prefer minimal code', sourceQuote: '   \n\t  ' }, { path: profilePath, now }),
      /sourceQuote/
    );
    await assert.rejects(
      setProfileItem(
        { id: 'p1', text: 'Prefer minimal code', sourceQuote: 'Keep it small', origin: 'agent_inference' },
        { path: profilePath, now }
      ),
      /user_statement/
    );
    await assert.rejects(
      setProfileItem(
        { id: 'p1', text: 'x'.repeat(MAX_PROFILE_TEXT_CHARS + 1), sourceQuote: 'Keep it concise' },
        { path: profilePath, now }
      ),
      /200 characters/
    );

    for (let i = 1; i <= MAX_PROFILE_ITEMS; i++) {
      const saved = await setProfileItem(
        { id: `p${i}`, text: `Rule ${i}`, sourceQuote: `User rule ${i}` },
        { path: profilePath, now }
      );
      assert.equal(saved.action, 'created');
      assert.equal(saved.count, i);
    }

    assert.equal((await stat(profilePath)).mode & 0o777, 0o600);

    await assert.rejects(
      setProfileItem({ id: 'p11', text: 'Rule 11', sourceQuote: 'User rule 11' }, { path: profilePath, now }),
      /at most 10|already has 10/
    );

    // Updating an existing ID in-place succeeds even when already at 10 items.
    const updated = await setProfileItem(
      { id: 'p1', text: 'One interface per feature', sourceQuote: '只留一个接口、一份实现' },
      { path: profilePath, now }
    );
    assert.equal(updated.action, 'updated');
    assert.equal(updated.count, 10);

    // Total serialized file size must remain <= 4096 bytes even when each item fits <= 2000 quote chars.
    await assert.rejects(
      setProfileItem(
        { id: 'p2', text: 'Long rule with giant quote', sourceQuote: 'q'.repeat(2001) },
        { path: profilePath, now }
      ),
      /sourceQuote/
    );
    await setProfileItem({ id: 'p2', text: 'Rule 2', sourceQuote: 'q'.repeat(1800) }, { path: profilePath, now });
    await assert.rejects(
      setProfileItem({ id: 'p3', text: 'Rule 3', sourceQuote: 'r'.repeat(1800) }, { path: profilePath, now }),
      /4 KB/
    );

    const removed = await removeProfileItem('p10', { path: profilePath, now });
    assert.equal(removed.action, 'removed');
    assert.equal(removed.count, 9);

    const after = await readProfile(profilePath);
    assert.equal(after.items.length, 9);
    assert.equal(after.items[0].text, 'One interface per feature');
    assert.ok(Buffer.byteLength(await readFile(profilePath, 'utf8'), 'utf8') <= MAX_PROFILE_BYTES);

    // Reject symlinks to protect against reading/writing arbitrary files.
    const linked = join(dir, 'linked-profile.json');
    await symlink(profilePath, linked);
    await assert.rejects(readProfile(linked), /regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zesia profile CLI exports deterministic Markdown, sets in-place, and removes items', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-profile-cli-'));
  const config = join(dir, 'agent.json');
  const profile = join(dir, 'profile.json');
  const env = { ...process.env, ZESIA_CONFIG: config, ZESIA_PROFILE: profile, ZESIA_STATE_DIR: join(dir, 'state') };
  try {
    await writeFile(config, JSON.stringify({ url: 'https://api.zesia.dev' }));

    const emptyMd = (await execute(process.execPath, [CLI_PATH, 'profile'], { env })).stdout;
    assert.equal(emptyMd, '# Zesia Profile (0/10)\n\n_No preferences recorded._\n');

    const created = JSON.parse(
      (await execute(process.execPath, [CLI_PATH, 'profile', 'set', 'p1', 'Prefer single source of truth', '--quote', '只留一份实现'], { env })).stdout
    );
    assert.equal(created.ok, true);
    assert.equal(created.action, 'created');
    assert.equal(created.count, 1);

    const overwritten = JSON.parse(
      (await execute(process.execPath, [CLI_PATH, 'profile', 'set', 'p1', 'Keep one interface per feature', '--quote', '用户能指认的一件事，只留一个接口'], { env })).stdout
    );
    assert.equal(overwritten.ok, true);
    assert.equal(overwritten.action, 'updated');
    assert.equal(overwritten.count, 1);

    const md1 = (await execute(process.execPath, [CLI_PATH, 'profile'], { env })).stdout;
    const md2 = (await execute(process.execPath, [CLI_PATH, 'profile', 'export'], { env })).stdout;
    assert.equal(md1, md2);
    assert.equal(
      md1,
      '# Zesia Profile (1/10)\n\n- **p1**: Keep one interface per feature\n  > "用户能指认的一件事，只留一个接口"\n'
    );

    const removed = JSON.parse((await execute(process.execPath, [CLI_PATH, 'profile', 'rm', 'p1'], { env })).stdout);
    assert.equal(removed.ok, true);
    assert.equal(removed.action, 'removed');
    assert.equal(removed.count, 0);

    await assert.rejects(
      execute(process.execPath, [CLI_PATH, 'profile', 'set', 'p1', 'No quote', '--quote', '   '], { env }),
      err => {
        const parsed = JSON.parse(err.stdout);
        assert.equal(parsed.ok, false);
        assert.match(parsed.message, /sourceQuote/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('prepare injects profile into context.statements covered by approvedHash without overwriting explicit entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-profile-prepare-'));
  const profilePath = join(dir, 'profile.json');
  const config = join(dir, 'agent.json');
  const packetFile = join(dir, 'packet.json');
  const env = { ...process.env, ZESIA_CONFIG: config, ZESIA_PROFILE: profilePath, ZESIA_STATE_DIR: dir };
  try {
    await writeFile(config, JSON.stringify({ url: 'https://api.zesia.dev' }));
    await setProfileItem(
      { id: 'p1', text: 'Keep one interface', sourceQuote: '只留一个接口' },
      { path: profilePath }
    );
    await setProfileItem(
      { id: 'p2', text: 'No hidden fallback parser', sourceQuote: '拒绝防御性兜底解析' },
      { path: profilePath }
    );

    const packet = {
      requester: 'Codex',
      project: 'profile-inject-test',
      brief: 'Review API design.',
      context: {
        statements: [
          {
            id: 'profile:p1',
            kind: 'constraint',
            origin: 'user_statement',
            text: 'Explicit packet override for p1',
            sourceRef: 'zesia:profile:p1',
            sourceQuote: 'Explicit quote',
          },
          {
            id: 'u1',
            kind: 'fact',
            origin: 'observation',
            text: 'Current handler has one route',
            sourceRef: 'routes.mjs:10',
            sourceQuote: '',
          },
        ],
      },
    };
    await writeFile(packetFile, JSON.stringify(packet));

    const prepared = JSON.parse((await execute(process.execPath, [CLI_PATH, 'prepare', packetFile], { env })).stdout);
    assert.equal(prepared.ok, true);

    const stored = JSON.parse(await readFile(join(dir, `${prepared.draftId}.json`), 'utf8'));
    assert.equal(stored.packet.context.statements.length, 3);
    assert.equal(stored.packet.context.statements[0].text, 'Explicit packet override for p1');
    assert.deepEqual(stored.packet.context.statements[2], {
      id: 'profile:p2',
      kind: 'constraint',
      origin: 'user_statement',
      text: 'No hidden fallback parser',
      sourceRef: 'zesia:profile:p2',
      sourceQuote: '拒绝防御性兜底解析',
    });

    // Enforce <= 16 statements cap when explicit statements + profile exceed 16.
    const fullStatements = Array.from({ length: 16 }, (_, idx) => ({
      id: `u${idx}`,
      kind: 'constraint',
      origin: 'user_statement',
      text: `Statement ${idx}`,
      sourceRef: `msg:${idx}`,
      sourceQuote: `Quote ${idx}`,
    }));
    await writeFile(
      packetFile,
      JSON.stringify({ requester: 'Codex', project: 'overflow', brief: 'Check 16 cap.', context: { statements: fullStatements } })
    );
    await assert.rejects(
      execute(process.execPath, [CLI_PATH, 'prepare', packetFile], { env }),
      err => {
        const parsed = JSON.parse(err.stdout);
        assert.equal(parsed.ok, false);
        assert.match(parsed.message, /at most 16/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('independent CLI workers preserve different Profile slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-profile-concurrent-'));
  const path = join(dir, 'profile.json');
  const env = { ...process.env, ZESIA_PROFILE: path, ZESIA_STATE_DIR: join(dir, 'state') };
  try {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
    await Promise.all(ids.map(id => execute(process.execPath, [
      CLI_PATH, 'profile', 'set', id, 'Preserve ' + id, '--quote', 'Keep rule ' + id,
    ], { env })));
    assert.deepEqual((await readProfile(path)).items.map(item => item.id).sort(), ids);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bridge /bridge/v1/view exposes injected statements & profile and POST /bridge/v1/profile distills user statements safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-profile-bridge-'));
  const profilePath = join(dir, 'profile.json');
  await setProfileItem(
    { id: 'p1', text: 'Keep Consult free', sourceQuote: 'Keep Consult free to users permanently' },
    { path: profilePath }
  );

  let inferenceCalls = 0;
  const runtime = createPortable({
    stateDir: dir,
    profilePath,
    consult: async () => { inferenceCalls++; throw new Error('Unexpected consultation'); },
    configuration: async () => ({ url: 'https://api.zesia.dev', token: 'synthetic-bridge-token-123456789012345' }),
  });

  const prepared = await runtime.prepare({
    requester: 'Codex',
    project: 'bridge-profile-test',
    brief: 'Review architecture.',
    context: {
      statements: [
        {
          id: 'u2',
          kind: 'constraint',
          origin: 'user_statement',
          text: 'Never mutate approvedHash on profile save',
          sourceRef: 'chat:12',
          sourceQuote: '不绕过审阅窗的显式批准边界',
        },
        {
          id: 'a1',
          kind: 'assumption',
          origin: 'agent_inference',
          text: 'Agent inferred assumption',
          sourceRef: 'agent:guess',
          sourceQuote: '',
        },
      ],
    },
  });

  const session = await startOnlineReview({ runtime, draftId: prepared.draftId });
  const params = new URLSearchParams(new URL(session.url).hash.slice(1));
  const origin = `http://127.0.0.1:${params.get('port')}`;
  const headers = {
    origin: 'https://zesia.dev',
    authorization: `Bearer ${params.get('key')}`,
    'content-type': 'application/json',
  };

  try {
    const viewRes = await fetch(`${origin}/bridge/v1/view`, { headers });
    assert.equal(viewRes.status, 200);
    const viewData = await viewRes.json();
    assert.equal(viewData.approvedHash, prepared.approvedHash);
    assert.equal(viewData.profile.items.length, 1);
    assert.equal(viewData.packet.context.statements.length, 3);
    assert.equal(viewData.packet.context.statements[2].sourceRef, 'zesia:profile:p1');

    assert.equal(viewData.profileWriteVersion, 1);
    const save = (payload) => fetch(`${origin}/bridge/v1/profile`, {
      method: 'POST', headers, body: JSON.stringify(payload),
    });
    const request = { protocolVersion: 1, id: 'p2', expectedUpdatedAt: null, statementId: 'u2' };
    for (const payload of [
      { ...request, statementId: 'different-draft-statement' },
      { ...request, statementId: 'a1' },
      { ...request, statementId: 'profile:p1' },
      { ...request, text: 'A caller-supplied substitute' },
      { ...request, sourceQuote: 'A caller-supplied substitute' },
      { protocolVersion: 1, id: 'p2' },
    ]) assert.equal((await save(payload)).status, 400);
    assert.equal((await readProfile(profilePath)).items.length, 1);

    const saveRes = await save(request);
    assert.equal(saveRes.status, 200);
    const afterSave = await saveRes.json();
    assert.equal(afterSave.approvedHash, prepared.approvedHash);
    assert.equal(afterSave.profile.items.length, 2);
    assert.equal(afterSave.profile.items[1].id, 'p2');

    const storedProfile = await readProfile(profilePath);
    assert.equal(storedProfile.items.length, 2);
    assert.equal(storedProfile.items[1].sourceQuote, '不绕过审阅窗的显式批准边界');
    assert.equal((await save(request)).status, 400, 'a previously empty slot cannot be overwritten silently');
    const replaced = await save({ ...request, expectedUpdatedAt: storedProfile.items[1].updatedAt });
    assert.equal(replaced.status, 200);
    assert.equal((await save({ ...request, expectedUpdatedAt: storedProfile.items[1].updatedAt })).status, 400);
    assert.equal(inferenceCalls, 0);
  } finally {
    session.close();
    await rm(dir, { recursive: true, force: true });
  }
});
