import { randomUUID } from 'node:crypto';
import { readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { missing, stageGuideBundle } from './startup-bundle.mjs';

const managedModule = /^\.\/\.zesia-first-use-[a-f\d]{64}\/tui\.mjs$/u;

async function readSettings(path) {
  const stat = await missing(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) throw Error('The OpenCode TUI settings file is not a regular file.');
  return readFile(path, 'utf8');
}

function readPluginList(path, original) {
  const errors = [];
  const config = parse(original ?? '{}', errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config))
    throw Error('Review the existing OpenCode TUI settings before installing the guide.');
  const nested = config.tui && Object.hasOwn(config.tui, 'plugin');
  const pluginPath = nested ? ['tui', 'plugin'] : ['plugin'];
  const source = nested ? config.tui : config;
  if (Object.hasOwn(source, 'plugin') && !Array.isArray(source.plugin))
    throw Error('Review the existing OpenCode TUI plugin list before installing the guide.');
  const index = source.plugin?.findIndex(value => typeof value === 'string' && managedModule.test(value)) ?? -1;
  return { path, original, pluginPath, plugin: source.plugin, index };
}

function tuiSource({ interpreter, privateInterpreter, locale }) {
  const command = privateInterpreter ? "fileURLToPath(new URL('./node.exe', import.meta.url))" : JSON.stringify(interpreter);
  return [
    "import { spawn } from 'node:child_process';",
    "import { fileURLToPath } from 'node:url';",
    "export default { id: 'zesia.first-use', async tui() {",
    "  const entry = fileURLToPath(new URL('./zesia-setup.mjs', import.meta.url));",
    "  const child = spawn(" + command + ", [entry, 'serve-guide', 'opencode', '--locale', " + JSON.stringify(locale) + ", '--reopen-pending'],",
    "    { detached: true, stdio: 'ignore', windowsHide: true });",
    "  child.on('error', () => {});",
    "  child.unref();",
    "} };",
    '',
  ].join('\n');
}

export async function installOpenCodeStartup({ directory, entry, interpreter, privateInterpreter, locale }) {
  const scope = await realpath(dirname(dirname(directory)));
  const settings = await Promise.all(['tui.json', 'tui.jsonc'].map(async name => {
    const path = join(scope, name);
    return readPluginList(path, await readSettings(path));
  }));
  const selected = settings.find(setting => setting.index >= 0) ?? settings.findLast(setting => setting.original !== null) ?? settings[0];
  const bundle = await stageGuideBundle({ directory: scope, entry, interpreter, privateInterpreter,
    module: tuiSource({ interpreter, privateInterpreter, locale }) });
  const spec = './' + bundle + '/tui.mjs';
  if (selected.plugin?.[selected.index] === spec) return;

  const original = selected.original ?? '{}\n';
  const path = selected.plugin ? [...selected.pluginPath, selected.index] : selected.pluginPath;
  const edits = modify(original, path, selected.plugin ? spec : [spec], { formattingOptions: { insertSpaces: true, tabSize: 2 } });
  const updated = applyEdits(original, edits);
  const staged = selected.path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(staged, updated, { flag: 'wx', mode: 0o600 });
    const current = await readSettings(selected.path);
    if (current === updated) return;
    if (current !== selected.original) throw Error('OpenCode TUI settings changed during setup. Run setup again to retain those edits.');
    await rename(staged, selected.path);
  } finally {
    try { await unlink(staged); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
