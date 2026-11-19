import { spawnSync } from 'node:child_process';
import { readFile, realpath, access } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { hosts, skillHosts } from './guide.mjs';

function invoke(command, args, capture = false) {
  const child = spawnSync(command, args, { encoding: 'utf8', stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) throw Error('Host installation command failed. The guide was not opened.');
  return capture ? child.stdout : undefined;
}
async function registeredDsh(dsh, profile) {
  const listing = invoke(dsh, ['plugin', '--profile', profile, 'list', '--depth', '0'], true);
  const dependency = listing.split(/\r?\n/u).find(line => line.includes('@zesia/dsh-plugin@'));
  if (!dependency) return null;
  const target = dependency.match(/@zesia\/dsh-plugin@link:(.+?)\s*$/u)?.[1];
  const directory = listing.match(/^dsh-profile-\S+ (.+?) \(PRIVATE\)\s*$/mu)?.[1];
  if (!target || !directory) throw Error('Review the existing DSH registration before changing it.');
  return realpath(resolve(directory, target));
}
export async function installHost({ host, directory, profile, dsh = 'dsh', project, upgrade, node = process.execPath }) {
  if (!Object.hasOwn(hosts, host)) throw Error('Choose a supported host.');
  if (host === 'dsh' && !['desktop', 'web'].includes(profile)) throw Error('Choose the active DSH profile.');
  if (host !== 'dsh' && (profile || dsh !== 'dsh')) throw Error('DSH options require the native DSH host.');
  if (!skillHosts.has(host) && (upgrade || project)) throw Error('These options require a standalone Skill host.');
  const root = await realpath(resolve(directory));
  const metadata = file => readFile(join(root, file), 'utf8').then(JSON.parse);
  if (skillHosts.has(host)) {
    const adapter = await metadata('host.json');
    if (adapter.id !== host || adapter.format !== 'zesia.host-adapter.v1') throw Error('The archive belongs to another host.');
    const binary = join(root, 'scripts', process.platform === 'win32' ? 'zesia.exe' : 'zesia');
    const installed = JSON.parse(invoke(binary, ['install', ...(project ? ['--project', resolve(project)] : []),
      ...(upgrade ? ['--upgrade'] : [])], true));
    if (!installed.ok || !installed.destination) throw Error('Installation did not return a destination.');
    return installed;
  }
  if (host === 'dsh') {
    if ((await metadata('package.json')).name !== '@zesia/dsh-plugin') throw Error('Expected a DSH plugin.');
    const existing = await registeredDsh(dsh, profile);
    if (existing && existing !== root &&
        (dirname(dirname(existing)) !== dirname(dirname(root)) || basename(existing) !== 'zesia-dsh' ||
         !/^\d+\.\d+\.\d+$/u.test(basename(dirname(existing)))))
      throw Error('An existing DSH plugin points to another source. Review it before installing.');
    invoke(node, [join(root, 'lib/install-a2a.mjs')]);
    if (existing !== root) {
      invoke(dsh, ['plugin', '--profile', profile, 'add', root, '--offline', '--ignore-scripts']);
      if (await registeredDsh(dsh, profile) !== root) throw Error('DSH has not registered the verified package.');
    }
  } else {
    if (host === 'claude-code') {
      if ((await metadata('.claude-plugin/plugin.json')).name !== 'zesia-consult') throw Error('Expected the Zesia Claude Code plugin.');
    } else await access(join(root, 'SKILL.md'));
    invoke(node, [join(root, 'scripts/install-a2a.mjs')]);
  }
  return { ok: true, destination: root, host };
}
