import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, readFile, readlink, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const names = new Map([
  ['codex', 'Codex'], ['claude', 'Claude Code'], ['dsh', 'DeepSeek Harness'], ['opencode', 'OpenCode'],
  ['gemini', 'Gemini CLI'], ['antigravity', 'Antigravity'], ['workbuddy', 'WorkBuddy'],
]);
const sha = value => createHash('sha256').update(value).digest('hex');
const systemEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' };

async function readProcess(pid) {
  if (process.platform === 'linux') {
    const proc = '/proc/' + pid;
    const status = await readFile(proc + '/status', 'utf8');
    return { uid: Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]), parent: Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1]),
      path: await readlink(proc + '/exe'), image: proc + '/exe' };
  }
  if (process.platform !== 'darwin') return undefined;
  const options = { env: systemEnv, timeout: 2000, maxBuffer: 512 * 1024 };
  const { stdout } = await execute('/bin/ps', ['-o', 'ppid=,uid=,comm=', '-p', String(pid)], options);
  const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(stdout);
  if (!row) return undefined;
  const [, parent, uid, path] = row;
  if (!names.has(basename(path).toLowerCase())) return { uid: Number(uid), parent: Number(parent), path };
  const files = await execute('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], options);
  const canonical = await realpath(path);
  if (!files.stdout.split('\n').some(line => line === 'n' + canonical || line === 'n' + path)) return undefined;
  return { uid: Number(uid), parent: Number(parent), path, image: canonical };
}

export async function observeTrustedHost() {
  let pid = process.ppid;
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  for (let depth = 0; pid > 1 && depth < 12; depth++) {
    const observed = await readProcess(pid).catch(() => undefined);
    if (!observed || observed.uid !== uid) return undefined;
    const label = names.get(basename(observed.path).toLowerCase());
    if (label) {
      if (!observed.image || !isAbsolute(observed.path)) return undefined;
      try {
        const path = await realpath(observed.path);
        const before = await stat(observed.image, { bigint: true });
        if (!before.isFile() || (before.mode & 0o111n) === 0n) return undefined;
        const image = createHash('sha256');
        for await (const chunk of createReadStream(observed.image)) image.update(chunk);
        const after = await stat(path, { bigint: true });
        const current = await readProcess(pid);
        if (current?.path !== observed.path || current.uid !== uid || current.parent !== observed.parent
          || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) return undefined;
        return { label, path, executableSha256: image.digest('hex') };
      } catch { return undefined; }
    }
    pid = observed.parent;
  }
}

export async function trustedHostIdentity(origin, {
  observe = observeTrustedHost, directory = join(homedir(), '.local', 'state', 'zesia', 'trusted-consult'),
} = {}) {
  if (!origin.startsWith('https://') || new URL(origin).origin !== origin) return undefined;
  const installation = await observe();
  if (!installation) return undefined;
  const uid = process.getuid?.();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await lstat(directory);
  if (!root.isDirectory() || root.uid !== uid || (root.mode & 0o077) !== 0) return undefined;
  const name = sha(JSON.stringify([installation.path, installation.executableSha256, origin]));
  const path = join(directory, name + '.pem');
  async function read() {
    const meta = await lstat(path);
    if (!meta.isFile() || meta.uid !== uid || (meta.mode & 0o077) !== 0 || meta.size > 4096) throw Error('Unsafe trusted host key.');
    return createPrivateKey(await readFile(path));
  }
  let key;
  try {
    key = await read();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const temporary = path + '.' + randomUUID();
    await writeFile(temporary, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    try { await link(temporary, path); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    finally { await unlink(temporary); }
    key = await read();
  }
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  return {
    host: { publicKeySpki: publicKey.toString('base64url'), keyFingerprint: sha(publicKey) },
    installation, origin,
    sign: value => sign('sha256', Buffer.from(value), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
  };
}
