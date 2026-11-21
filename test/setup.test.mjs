import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hosts, paths, startGuide } from '../setup/guide.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'zesia-setup-test-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  return { dir, env: { ZESIA_CONFIG: join(dir, 'config.json') } };
}
function request(url, operation = 'view', body, authorized = true) {
  const link = new URL(url), params = new URLSearchParams(link.hash.slice(1));
  return fetch('http://127.0.0.1:' + params.get('port') + '/bridge/v1/' + operation, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: link.origin, Authorization: 'Bearer ' + (authorized ? params.get('key') : 'invalid'), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}
for (const [host, name] of Object.entries(hosts)) {
  test(host + ' opens only its own first-use tutorial', async t => {
    const { env } = await fixture(t);
    await writeFile(env.ZESIA_CONFIG, JSON.stringify({ token: 'existing-fixture' }));
    let opens = 0;
    const opts = { host, env, locale: 'zh', openBrowser: async () => { opens++; return true; } };
    const both = await Promise.all([startGuide(opts), startGuide(opts)]);
    for (const guide of both) if (guide.close) t.after(guide.close);
    assert.equal(opens, 1); assert.equal(both[0].url, both[1].url);
    const { url } = both[0];
    assert.equal((await request(url, 'view', undefined, false)).status, 403);
    assert.equal((await request(url, 'approve', {})).status, 404);
    await assert.rejects(access(paths(host, env).marker), { code: 'ENOENT' });
    const view = await (await request(url)).json();
    assert.deepEqual(view.packet, { requester: name });
    assert.equal(view.configured, true); assert.equal(view.status, 'onboarding'); assert.equal(view.guideLocale, 'zh');
    assert.ok(!JSON.stringify(view).includes('existing-fixture'));
    assert.equal((await startGuide(opts)).state, 'seen'); assert.equal(opens, 1);
    assert.equal((await request(url, 'configure', { protocolVersion: 1, destination: view.destination, token: 'replacement' })).status, 400);
    assert.equal(JSON.parse(await readFile(env.ZESIA_CONFIG)).token, 'existing-fixture');
  });
}
test('missing credential permits sign-in and fallback link; skill hosts keep separate first-use state', async t => {
  const { env } = await fixture(t);
  const opts = { host: 'codex', env, locale: 'en', openBrowser: async () => false };
  const first = await startGuide(opts); t.after(first.close);
  assert.equal(first.state, 'link');
  assert.equal((await (await request(first.url)).json()).configured, false);
  const reply = await request(first.url, 'configure', { protocolVersion: 1, destination: 'https://api.zesia.dev', token: 'fixture' });
  assert.equal((await reply.json()).configured, true);
  const second = await startGuide({ ...opts, host: 'opencode' }); t.after(second.close);
  assert.equal(second.state, 'link');
});
test('shipped CLI finishes provisioning before opening; bridge survives installer exit', async t => {
  const { dir, env } = await fixture(t);
  const node = process.execPath, native = process.env.ZESIA_TEST_SETUP_NATIVE;
  const platform = process.platform + '-' + process.arch;
  const packageDir = resolve('dist/setup/zesia-setup-1.1.0-' + platform);
  const executable = native ? join(packageDir, process.platform === 'win32' ? 'node.exe' : 'node') : node;
  const prefix = [native ? join(packageDir, 'zesia-setup.mjs') : fileURLToPath(new URL('../setup/cli.mjs', import.meta.url))];
  const run = (...args) => JSON.parse(execFileSync(executable, [...prefix, 'portable', dir, '--no-open', ...args],
    { env: { ...process.env, ...env, ...(native ? { PATH: '' } : {}) }, encoding: 'utf8', timeout: 25000 }).trim().split('\n').at(-1));
  assert.throws(() => run());
  await assert.rejects(access(paths('portable', env).pending), { code: 'ENOENT' });
  await mkdir(join(dir, 'scripts')); await writeFile(join(dir, 'SKILL.md'), 'fixture');
  await writeFile(join(dir, 'scripts/install-a2a.mjs'), 'console.log("transport fixture installed");');
  const result = run('--locale', 'zh');
  assert.equal(result.ok, true); assert.equal(result.onboarding.state, 'link');
  const record = JSON.parse(await readFile(paths('portable', env).pending));
  t.after(() => { try { process.kill(record.pid); } catch {} });
  const view = await (await request(result.onboarding.url)).json();
  assert.equal(view.guideLocale, 'zh'); assert.equal(view.configured, false);
  assert.equal(run().onboarding.state, 'seen');
});
