import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { packageAgentPlugin } from '../scripts/package-agent-plugin.mjs';
import { installPluginRuntime } from '../setup/standalone-runtime.mjs';
import { runtimePlatforms } from '../scripts/native-platforms.mjs';

const bytes = (value, pretty = false) => Buffer.from(JSON.stringify(value, null, pretty ? 2 : undefined) + '\n');
const sha = input => createHash('sha256').update(input).digest('hex');
const identity = { version: '0.4.14', sourceSha: '2'.repeat(40) };
const runtimeFiles = [
  'scripts/zesia', 'bin/a2a', 'bin/A2A-CLI-LICENSE', 'bin/installed.json', 'licenses/BUN-LICENSE.md',
  'licenses/ZESIA-LICENSE', 'NATIVE-NOTICES.md', 'zesia-cli.bundle.mjs',
];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-market-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, 'dist');
  await mkdir(dist);
  const archives = {};
  for (const platform of runtimePlatforms) {
    const entries = Object.fromEntries(runtimeFiles.map(name => [
      platform.startsWith('win32-') && ['bin/a2a', 'scripts/zesia'].includes(name) ? name + '.exe' : name,
      Buffer.from('fixture: ' + name),
    ]));
    const manifest = {
      format: 'zesia.native-runtime.v1', ...identity, platform, dirty: false,
      files: Object.entries(entries).map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) })),
    };
    const payload = Buffer.from(zipSync({ ...entries, 'runtime.json': bytes(manifest, true) }));
    const archive = 'zesia-runtime-' + identity.version + '-' + platform + '.zip';
    await writeFile(join(dist, archive + '.json'), bytes({
      ...manifest, archive, bytes: payload.length, sha256: sha(payload),
    }));
    archives[platform] = payload;
  }
  const plugin = await packageAgentPlugin({ dist, ...identity });
  return { plugin, dir, archives, skill: join(plugin.root, 'skills', 'zesia-consult') };
}

test('one standard ZIP matches the Git distribution tree and lists verified Runtime pins', async t => {
  const { plugin } = await fixture(t);
  const zip = unzipSync(await readFile(plugin.archive));
  const paths = Object.keys(zip).sort();
  assert.deepEqual(paths, [
    'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md', 'assets/zesia.svg', 'plugin.json', 'skills/zesia-consult/SKILL.md',
    'skills/zesia-consult/assets/runtime-lock.json', 'skills/zesia-consult/references/packet.md',
    'skills/zesia-consult/references/setup.md',
  ]);
  for (const name of paths) assert.deepEqual(Buffer.from(zip[name]), await readFile(join(plugin.root, name)));
  const manifest = JSON.parse(Buffer.from(zip['plugin.json']));
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.extensions['com.openai'].requires_local_executor, true);
  for (const icon of ['composerIcon', 'logo']) {
    assert.ok(zip[manifest.extensions['com.openai'].interface[icon].slice(2)]);
  }
  const document = Buffer.from(zip['skills/zesia-consult/SKILL.md']).toString();
  assert.match(document, /name: zesia-consult/);
  assert.match(document, /<zesia-runtime> review <draftId>/);
  assert.doesNotMatch(document, /<skill-directory>\/scripts\/zesia/);
});

test('Setup installs the selected platform once, verifies reuse and preserves tampered existing files', async t => {
  const { skill, dir, archives } = await fixture(t);
  const platform = 'darwin-arm64';
  let requests = 0;
  const options = {
    skillDirectory: skill, home: dir, platform,
    fetcher: async (url, opts) => {
      requests++;
      assert.equal(url.host, 'github.com');
      assert.equal(opts.redirect, 'manual');
      return new Response(archives[platform]);
    },
  };
  const installed = await installPluginRuntime(options);
  assert.equal(installed.reused, false);
  assert.equal(await readFile(installed.executable, 'utf8'), 'fixture: scripts/zesia');
  assert.equal((await installPluginRuntime(options)).reused, true);
  await writeFile(installed.executable, 'modified');
  await assert.rejects(installPluginRuntime(options), /incomplete installed Runtime/);
  assert.equal(await readFile(installed.executable, 'utf8'), 'modified');
  assert.equal(requests, 1);
});

test('Setup does not accept unexpected redirect hosts or a mismatched archive hash', async t => {
  const { skill, dir, archives } = await fixture(t);
  const platform = 'win32-x64';
  const options = { skillDirectory: skill, home: dir, platform };
  await assert.rejects(installPluginRuntime({ ...options, fetcher: async () =>
    Response.redirect('https://example.test/runtime.zip') }), /Unexpected Runtime download destination/);
  const tampered = Buffer.from(archives[platform]);
  tampered[0] ^= 1;
  await assert.rejects(installPluginRuntime({ ...options, fetcher: async () =>
    new Response(tampered) }), /checksum mismatch/);
  const installed = await installPluginRuntime({ ...options, fetcher: async () => new Response(archives[platform]) });
  assert.match(installed.executable, /zesia\.exe$/);
});

test('CLI can defer the agent receipt until a host actually hands back the saved result', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-receipt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const draft = 'acf829f0-73a2-48a0-a817-6975631cd442';
  const record = { id: draft, status: 'completed', expiresAt: Date.now() + 60000, result: {
    ok: true, status: 'completed', advice: 'Synthetic opinion',
  } };
  const config = join(dir, 'agent.json');
  await writeFile(config, JSON.stringify({ url: 'https://api.zesia.dev' }));
  await writeFile(join(dir, draft + '.json'), JSON.stringify(record));
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, ['cli.mjs', ...args], {
    env: { ...process.env, ZESIA_CONFIG: config, ZESIA_STATE_DIR: dir },
  }));
  assert.equal(cli('result', draft, '--defer-receipt').agentReceivedAt, null);
  const received = cli('receipt', draft);
  assert.ok(received.agentReceivedAt);
  assert.equal(cli('receipt', draft).agentReceivedAt, received.agentReceivedAt);
  assert.equal(cli('result', draft).advice, 'Synthetic opinion');
});
