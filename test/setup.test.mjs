import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHost } from '../setup/install.mjs';
import { hosts, paths, startGuide } from '../setup/guide.mjs';
import { installClaudeStartup } from '../setup/claude-startup.mjs';
import { installOpenCodeStartup } from '../setup/opencode-startup.mjs';
import jsonc from 'jsonc-parser';

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
test('foreground startup reopens one pending guide after a failed browser launch', async t => {
  const { env } = await fixture(t);
  const host = 'claude-code';
  const opts = { host, env, locale: 'en' };
  const first = await startGuide({ ...opts, openBrowser: async () => false });
  t.after(first.close);
  assert.equal(first.state, 'link');
  await assert.rejects(access(paths(host, env).marker), { code: 'ENOENT' });

  let retries = 0;
  const retry = () => startGuide({ ...opts, reopenPending: true, openBrowser: async url => {
    assert.equal(url, first.url);
    retries++;
    return true;
  } });
  const restarted = await Promise.all([retry(), retry()]);
  assert.deepEqual(restarted.map(guide => guide.state).sort(), ['opened', 'pending']);
  assert.ok(restarted.every(guide => guide.url === first.url));
  assert.equal(retries, 1);
  await assert.rejects(access(paths(host, env).marker), { code: 'ENOENT' });

  assert.equal((await request(first.url)).status, 200);
  assert.equal((await retry()).state, 'seen');
  assert.equal(retries, 1);
});
test('Claude Code setup preserves existing hooks and installs one reusable startup handler', async t => {
  const { dir } = await fixture(t);
  const directory = join(dir, "Plugin with spaces and '$");
  const hooks = join(directory, 'hooks');
  await mkdir(hooks, { recursive: true });
  const path = join(hooks, 'hooks.json');
  const existing = {
    modules: ['./register.tsx'],
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'own-startup', args: [] }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'own-end', args: [] }] }],
    },
  };
  await writeFile(path, JSON.stringify(existing));
  const entry = join(dir, 'setup fixture.mjs');
  await writeFile(entry, '// Verified Setup fixture');
  const opts = { directory, entry, interpreter: process.execPath, locale: 'zh' };
  await installClaudeStartup(opts);
  await installClaudeStartup(opts);
  const config = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(config.modules, existing.modules);
  assert.deepEqual(config.hooks.SessionEnd, existing.hooks.SessionEnd);
  assert.deepEqual(config.hooks.SessionStart[0], existing.hooks.SessionStart[0]);
  assert.equal(config.hooks.SessionStart.length, 2);
  const [handler] = config.hooks.SessionStart[1].hooks;
  assert.equal(handler.command, process.execPath);
  assert.deepEqual(handler.args.slice(1), ['foreground-guide', 'claude-code', '--locale', 'zh']);
  const installed = handler.args[0].replace('${CLAUDE_PLUGIN_ROOT}', directory);
  assert.equal(await readFile(installed, 'utf8'), '// Verified Setup fixture');
  await writeFile(installed, '// Changed script');
  await assert.rejects(installClaudeStartup(opts), /guide file was changed/);
  assert.equal(await readFile(installed, 'utf8'), '// Changed script');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
});
test('Claude Code setup leaves unrecognized hook settings intact', async t => {
  const { dir } = await fixture(t);
  const folder = join(dir, 'hooks');
  await mkdir(folder);
  const path = join(folder, 'hooks.json');
  const raw = '{"hooks":{"SessionStart":"unrecognized"}}';
  await writeFile(path, raw);
  await assert.rejects(installClaudeStartup({ directory: dir, locale: 'en' }), /Review the existing Claude Code hook settings/);
  assert.equal(await readFile(path, 'utf8'), raw);
});
test('OpenCode setup preserves commented settings and refreshes only its managed TUI entry', async t => {
  const { dir } = await fixture(t);
  const scope = join(dir, 'Configuration with spaces', '.opencode');
  const directory = join(scope, 'skills', 'zesia-consult');
  await mkdir(directory, { recursive: true });
  const json = join(scope, 'tui.json');
  const jsoncPath = join(scope, 'tui.jsonc');
  await writeFile(json, '{"theme":"custom"}\n');
  await writeFile(jsoncPath, '{\n  // Retain this comment.\n  "tui": {"plugin": ["./own.js"],},\n}\n');
  const entry = join(dir, 'fixture-setup.mjs');
  await writeFile(entry, '// bundled setup fixture');
  const opts = { directory, entry, interpreter: process.execPath, locale: 'zh' };
  await installOpenCodeStartup(opts);
  const installed = await readFile(jsoncPath, 'utf8');
  assert.match(installed, /Retain this comment/u);
  const parse = source => jsonc.parse(source, [], { allowTrailingComma: true });
  const plugins = parse(installed).tui.plugin;
  assert.equal(plugins.length, 2);
  assert.equal(plugins[0], './own.js');
  assert.match(plugins[1], /^\.\/\.zesia-first-use-[a-f0-9]{64}\/tui\.mjs$/u);
  assert.match(await readFile(join(scope, plugins[1]), 'utf8'), /'serve-guide', 'opencode', '--locale', "zh", '--reopen-pending'/u);
  await installOpenCodeStartup(opts);
  assert.equal(await readFile(jsoncPath, 'utf8'), installed);
  assert.equal(await readFile(json, 'utf8'), '{"theme":"custom"}\n');
  await writeFile(entry, '// new bundled setup fixture');
  await installOpenCodeStartup(opts);
  const upgraded = parse(await readFile(jsoncPath, 'utf8')).tui.plugin;
  assert.equal(upgraded.length, 2);
  assert.equal(upgraded[0], plugins[0]);
  assert.notEqual(upgraded[1], plugins[1]);
});
test('OpenCode setup preserves unreadable TUI configuration', async t => {
  const { dir } = await fixture(t);
  const directory = join(dir, 'skills', 'zesia-consult');
  await mkdir(directory, { recursive: true });
  const settings = join(dir, 'tui.json');
  const original = '{"plugin":"invalid"}';
  await writeFile(settings, original);
  await assert.rejects(installOpenCodeStartup({ directory, locale: 'en' }), /Review the existing OpenCode TUI plugin list/u);
  assert.equal(await readFile(settings, 'utf8'), original);
});
test('packaged native Setup installs the Claude guide launcher with no system Node', { skip: !process.env.ZESIA_TEST_SETUP_NATIVE }, async t => {
  const { dir, env } = await fixture(t);
  const plugin = join(dir, 'Plugin with spaces');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await mkdir(join(plugin, 'scripts'));
  await writeFile(join(plugin, '.claude-plugin/plugin.json'), '{"name":"zesia-consult"}');
  await writeFile(join(plugin, 'scripts/install-a2a.mjs'), '// Synthetic preverified transport');
  const packageDir = resolve('dist/setup/zesia-setup-1.0.3-' + process.platform + '-' + process.arch);
  const node = join(packageDir, process.platform === 'win32' ? 'node.exe' : 'node');
  const entry = join(packageDir, 'zesia-setup.mjs');
  const options = { env: { ...process.env, ...env, PATH: '' }, encoding: 'utf8', timeout: 30000 };
  const raw = execFileSync(node, [entry, 'claude-code', plugin, '--no-open'], options);
  const setup = JSON.parse(raw);
  assert.deepEqual(setup.foregroundGuide, { state: 'installed' });
  assert.equal(setup.onboarding.state, 'link');
  const state = JSON.parse(await readFile(paths('claude-code', env).pending));
  t.after(() => { try { process.kill(state.pid); } catch {} });
  const hooks = JSON.parse(await readFile(join(plugin, 'hooks/hooks.json')));
  const handler = hooks.hooks.SessionStart[0].hooks[0];
  const actual = name => name.replace('${CLAUDE_PLUGIN_ROOT}', setup.destination);
  const installed = actual(handler.command);
  assert.match(installed, /node\.exe$/u);
  assert.equal(execFileSync(installed, handler.args.map(actual), {
    ...options, env: { ...options.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
  }), '');
  await assert.rejects(access(paths('claude-code', env).marker), { code: 'ENOENT' });
  const view = await (await request(setup.onboarding.url)).json();
  assert.equal(view.packet.requester, 'Claude Code');
});
test('shipped CLI finishes provisioning before opening; bridge survives installer exit', async t => {
  const { dir, env } = await fixture(t);
  const node = process.execPath, native = process.env.ZESIA_TEST_SETUP_NATIVE;
  const platform = process.platform + '-' + process.arch;
  const packageDir = resolve('dist/setup/zesia-setup-1.0.3-' + platform);
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


for (const [host, folder, name] of [
  ['opencode', '.opencode', 'zesia-consult.md'],
  ['gemini-cli', '.gemini', 'zesia-consult.toml'],
]) {
  test(host + ' setup installs its verified command and preserves existing commands', { skip: process.platform === 'win32' }, async t => {
    const { dir } = await fixture(t);
    const root = await realpath(dir);
    const bundle = join(root, 'bundle');
    const project = join(root, 'project');
    const scope = join(project, folder);
    const destination = join(scope, 'skills', 'zesia-consult');
    await mkdir(join(bundle, 'scripts'), { recursive: true });
    await mkdir(join(destination, 'commands'), { recursive: true });
    await writeFile(join(bundle, 'host.json'), JSON.stringify({ id: host, format: 'zesia.host-adapter.v1' }));
    const installed = JSON.stringify({ ok: true, destination });
    await writeFile(join(bundle, 'scripts', 'zesia'), "#!/bin/sh\nprintf '%s\\n' '" + installed + "'\n", { mode: 0o700 });
    const install = () => installHost({ host, directory: bundle, project });
    assert.equal((await install()).directCommand, 'unavailable');
    await writeFile(join(destination, 'commands', name), 'verified command');
    assert.equal((await install()).directCommand, 'installed');
    const commands = join(scope, 'commands');
    const target = join(commands, name);
    assert.equal(await readFile(target, 'utf8'), 'verified command');
    await writeFile(target, 'user command');
    assert.equal((await install()).directCommand, 'preserved');
    assert.equal(await readFile(target, 'utf8'), 'user command');
    await rm(commands, { recursive: true });
    const unrelated = join(root, 'unrelated');
    await mkdir(unrelated);
    await symlink(unrelated, commands, 'dir');
    assert.equal((await install()).directCommand, 'preserved');
    await assert.rejects(access(join(unrelated, name)), { code: 'ENOENT' });
  });
}
