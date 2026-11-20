import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { missing, stageGuideBundle } from './startup-bundle.mjs';
const pluginRoot = '${CLAUDE_PLUGIN_ROOT}';
const bundleEntry = 'zesia-setup.mjs';

async function readHooks(path) {
  const stat = await missing(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) throw Error('The Claude Code hook file is not a regular file.');
  return readFile(path, 'utf8');
}

function isManaged(handler) {
  if (handler?.type !== 'command' || !Array.isArray(handler.args)) return false;
  const [entry, action, host] = handler.args;
  return action === 'foreground-guide' && host === 'claude-code' &&
    typeof entry === 'string' && entry.startsWith(pluginRoot + '/') &&
    /^\.zesia-first-use-[a-f\d]{64}\/zesia-setup\.mjs$/u.test(entry.slice(pluginRoot.length + 1));
}

export async function installClaudeStartup({ directory, entry, interpreter, privateInterpreter, locale }) {
  const hooksDir = join(directory, 'hooks');
  await mkdir(hooksDir, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(hooksDir)).isDirectory()) throw Error('Unsafe Claude Code hooks directory.');
  const path = join(hooksDir, 'hooks.json');
  const original = await readHooks(path);
  const config = JSON.parse(original ?? '{}');
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
  const hooks = config?.hooks ?? {};
  const startup = hooks.SessionStart ?? [];
  if (!isObject(config) || !isObject(hooks) || !Array.isArray(startup) ||
      startup.some(group => !isObject(group) || !Array.isArray(group.hooks)))
    throw Error('Review the existing Claude Code hook settings before installing the guide.');

  const name = await stageGuideBundle({ directory, entry, interpreter, privateInterpreter });
  const root = pluginRoot + '/' + name;
  const handler = {
    type: 'command',
    command: privateInterpreter ? root + '/node.exe' : interpreter,
    args: [root + '/' + bundleEntry, 'foreground-guide', 'claude-code', '--locale', locale],
    timeout: 3,
  };
  const sessionStart = startup.flatMap(group => {
    const kept = group.hooks.filter(item => !isManaged(item));
    return kept.length === group.hooks.length ? [group] : kept.length ? [{ ...group, hooks: kept }] : [];
  });
  sessionStart.push({ matcher: 'startup', hooks: [handler] });
  const updated = JSON.stringify({ ...config, hooks: { ...hooks, SessionStart: sessionStart } }, null, 2) + '\n';
  if (original === updated) return;
  const staged = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, updated, { flag: 'wx', mode: 0o600 });
    const current = await readHooks(path);
    if (current === updated) return;
    if (current !== original) throw Error('Claude Code hooks changed during setup. Run setup again to retain those edits.');
    await rename(staged, path);
  } finally {
    try { await unlink(staged); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
