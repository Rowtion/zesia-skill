import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';

import { runtimePlatforms } from '../scripts/native-platforms.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[0-9a-f]{64}$/;
const megabyte = 1024 * 1024;

function validateLock(lock, platform) {
  const pin = lock?.assets?.[platform];
  if (lock?.format !== 'zesia.agent-plugin.runtime.v1' || !/^\d+\.\d+\.\d+$/.test(lock.version) ||
      !/^[0-9a-f]{40}$/.test(lock.sourceSha) || !runtimePlatforms.includes(platform) ||
      !pin || !hashPattern.test(pin.sha256) || !hashPattern.test(pin.manifestSha256) ||
      !Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 80 * megabyte) {
    throw Error('No valid ZESIA Runtime pin for ' + platform + '.');
  }
  return pin;
}

async function download(version, platform, fetcher) {
  const file = 'zesia-runtime-' + version + '-' + platform + '.zip';
  let url = new URL('https://github.com/Rowtion/zesia-skill/releases/download/v' + version + '/' + file);
  const signal = AbortSignal.timeout(120000);
  const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (url.protocol !== 'https:' || !hosts.has(url.host) || url.username || url.password) {
      throw Error('Unexpected Runtime download destination.');
    }
    const response = await fetcher(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw Error('Missing Runtime download redirect.');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw Error('Could not download the pinned ZESIA Runtime. HTTP ' + response.status);
    return response;
  }
  throw Error('Too many Runtime download redirects.');
}

function expectedFiles(platform) {
  const suffix = platform.startsWith('win32-') ? '.exe' : '';
  return [
    'scripts/zesia' + suffix, 'bin/a2a' + suffix, 'bin/A2A-CLI-LICENSE', 'bin/installed.json',
    'licenses/BUN-LICENSE.md', 'licenses/ZESIA-LICENSE', 'NATIVE-NOTICES.md', 'zesia-cli.bundle.mjs',
  ];
}

function decodeRuntime(bytes, lock, platform, pin) {
  if (digest(bytes) !== pin.manifestSha256) throw Error('Runtime manifest checksum mismatch.');
  const manifest = JSON.parse(Buffer.from(bytes).toString('utf8'));
  const files = expectedFiles(platform);
  if (manifest.format !== 'zesia.native-runtime.v1' || manifest.version !== lock.version ||
      manifest.sourceSha !== lock.sourceSha || manifest.platform !== platform || manifest.dirty !== false ||
      !Array.isArray(manifest.files) || manifest.files.length !== files.length ||
      !files.every(path => manifest.files.some(row => row.path === path && hashPattern.test(row.sha256) &&
        Number.isSafeInteger(row.bytes) && row.bytes >= 0))) {
    throw Error('Runtime manifest does not match the selected release.');
  }
  return manifest;
}

function verifyFile(data, row) {
  if (!data || data.length !== row.bytes || digest(data) !== row.sha256) throw Error('Runtime file checksum mismatch: ' + row.path);
}

async function verifyInstalled(directory, lock, platform, pin) {
  const root = await lstat(directory).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!root) return false;
  if (!root.isDirectory() || root.isSymbolicLink()) throw Error('Unsafe existing Runtime directory.');
  const metadata = join(directory, 'runtime.json');
  if (!(await lstat(metadata)).isFile()) throw Error('Unsafe existing Runtime manifest.');
  const manifest = decodeRuntime(await readFile(metadata), lock, platform, pin);
  for (const sub of ['scripts', 'bin', 'licenses']) {
    if (!(await lstat(join(directory, sub))).isDirectory()) throw Error('Unsafe existing Runtime subdirectory.');
  }
  for (const row of manifest.files) {
    const file = join(directory, row.path);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size !== row.bytes) throw Error('Unsafe or incomplete installed Runtime: ' + row.path);
    verifyFile(await readFile(file), row);
  }
  return true;
}

async function readArchive(response, length) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > length) throw Error('Runtime archive exceeds its pinned size.');
    chunks.push(chunk);
  }
  if (bytes !== length) throw Error('Runtime archive size mismatch.');
  return Buffer.concat(chunks, bytes);
}

export async function installPluginRuntime({
  skillDirectory, home = homedir(), platform = process.platform + '-' + process.arch, fetcher = fetch,
}) {
  const lock = JSON.parse(await readFile(join(skillDirectory, 'assets', 'runtime-lock.json'), 'utf8'));
  if (!(await lstat(join(skillDirectory, 'SKILL.md'))).isFile()) throw Error('Expected the installed ZESIA Skill directory.');
  const pin = validateLock(lock, platform);
  const base = join(home, '.local', 'share', 'zesia', 'runtime', lock.version);
  const destination = join(base, platform);
  const executable = join(destination, expectedFiles(platform)[0]);
  const result = { ok: true, destination, executable, runtimeVersion: lock.version };
  if (await verifyInstalled(destination, lock, platform, pin)) return { ...result, reused: true };

  const archive = await readArchive(await download(lock.version, platform, fetcher), pin.bytes);
  if (digest(archive) !== pin.sha256) throw Error('Runtime archive checksum mismatch.');
  const files = new Set(['runtime.json', ...expectedFiles(platform)]);
  const seen = new Set();
  let unpackedSize = 0;
  const unpacked = unzipSync(archive, { filter: entry => {
    if (seen.has(entry.name)) throw Error('Duplicate Runtime archive entry.');
    seen.add(entry.name);
    if (['scripts/', 'bin/', 'licenses/'].includes(entry.name) && entry.originalSize === 0) return false;
    unpackedSize += entry.originalSize;
    if (!files.has(entry.name) || unpackedSize > 200 * megabyte) throw Error('Unexpected Runtime archive entry.');
    return true;
  } });
  if (Object.keys(unpacked).length !== files.size) throw Error('Incomplete Runtime archive.');
  const manifest = decodeRuntime(unpacked['runtime.json'], lock, platform, pin);
  for (const row of manifest.files) verifyFile(unpacked[row.path], row);

  await mkdir(base, { recursive: true, mode: 0o700 });
  const staged = await mkdtemp(join(base, '.setup-'));
  try {
    for (const [name, data] of Object.entries(unpacked)) {
      const target = join(staged, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const mode = name === expectedFiles(platform)[0] || name === expectedFiles(platform)[1] ? 0o700 : 0o600;
      await writeFile(target, data, { mode, flag: 'wx' });
    }
    try {
      await rename(staged, destination);
      return { ...result, reused: false };
    } catch (error) {
      if (await verifyInstalled(destination, lock, platform, pin)) return { ...result, reused: true };
      throw error;
    }
  } finally {
    await rm(staged, { recursive: true, force: true });
  }
}
