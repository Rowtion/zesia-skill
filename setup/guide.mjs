import { randomUUID } from 'node:crypto';
import { access, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { startOnlineReview, openOnlineBrowser } from '../review/online.mjs';
import { readConfig, saveConfig, DEFAULT_SERVICE_URL } from '../runtime/config.mjs';

export const hosts = Object.freeze({
  codex: 'Codex', opencode: 'OpenCode', 'gemini-cli': 'Gemini CLI',
  antigravity: 'Gemini Antigravity', workbuddy: 'WorkBuddy',
  'claude-code': 'Claude Code', dsh: 'DeepSeek Harness', 'dsh-project': 'DeepSeek Harness', portable: 'Your agent',
});
export const skillHosts = new Set(['codex', 'opencode', 'gemini-cli', 'antigravity', 'workbuddy']);
const lifetime = 15 * 60_000;

export function paths(host, env = process.env) {
  if (!Object.hasOwn(hosts, host)) throw Error('Unknown installation host.');
  const file = host === 'claude-code' || host === 'dsh' ? host : 'agent';
  const config = env.ZESIA_CONFIG || join(homedir(), '.config', 'zesia', file + '.json');
  const marker = config + (host === 'dsh' ? '' : '.' + host) + '.onboarding-complete';
  return { config, marker, pending: marker + '.pending' };
}
async function exists(path) {
  try { await access(path); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function active(record, origin) {
  try {
    const url = new URL(record.url);
    if (!Number.isSafeInteger(record.pid) || record.pid < 1 || record.until <= Date.now() ||
        url.origin !== origin || url.pathname !== '/consult' || !url.hash) return false;
    process.kill(record.pid, 0);
    return true;
  } catch { return false; }
}
export async function startGuide({ host, locale, env = process.env, openBrowser = openOnlineBrowser,
  origin = 'https://zesia.dev' }) {
  const { config, marker, pending } = paths(host, env);
  if (await exists(marker)) return { state: 'seen' };
  const configEnv = { ...env, ZESIA_CONFIG: config };
  const settings = () => readConfig(configEnv, { requireToken: false });
  const id = randomUUID();
  let saving = false;
  const runtime = {
    async inspect() {
      const current = await settings();
      return { ok: true, draftId: id, requestId: id, status: 'onboarding', guideLocale: locale,
        configured: Boolean(current.token), destination: current.url, packet: { requester: hosts[host] } };
    },
    async configure({ destination, token }) {
      if (saving) throw Error('Sign-in is already in progress.');
      saving = true;
      try {
        const current = await settings();
        if (current.token || current.url !== DEFAULT_SERVICE_URL || destination !== DEFAULT_SERVICE_URL)
          throw Error('Existing configuration was preserved.');
        if (typeof token !== 'string' || !token || /[\s\x00-\x1f\x7f]/u.test(token))
          throw Error('Invalid activation token.');
        await saveConfig({ token, url: destination }, configEnv);
      } finally { saving = false; }
    },
  };
  await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
  async function acknowledge() {
    try { await writeFile(marker, '', { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  let owner = false;
  async function release() {
    if (!owner) return;
    try {
      const current = JSON.parse(await readFile(pending, 'utf8'));
      if (current.id === id) await unlink(pending);
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const bridge = await startOnlineReview({ runtime, draftId: id, onlineOrigin: origin, idleMs: lifetime,
    lifetimeMs: lifetime, onGuideView: acknowledge, onClose: () => { void release().catch(() => {}); } });
  const temp = pending + '.' + id;
  try {
    const record = { id, url: bridge.url, pid: process.pid, until: Date.now() + lifetime };
    await writeFile(temp, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    for (;;) {
      if (await exists(marker)) { bridge.close(); return { state: 'seen' }; }
      try { await link(temp, pending); owner = true; break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      let previous;
      try { previous = JSON.parse(await readFile(pending, 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (active(previous, origin)) { bridge.close(); return { state: 'pending', url: previous.url }; }
      try { await unlink(pending); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const opened = await openBrowser(bridge.url);
    return { state: opened ? 'opened' : 'link', url: bridge.url, close: bridge.close };
  } catch (e) { bridge.close(); throw e; }
  finally { await unlink(temp).catch(() => {}); }
}
