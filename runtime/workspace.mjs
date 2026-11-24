import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, lstat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const WORKSPACE_FORMAT = 'zesia.workspace.session.v1';
export const defaultWorkspaceDir = () => process.env.ZESIA_WORKSPACE_DIR || join(homedir(), '.zesia');
const kinds = new Set(['draft', 'consult', 'group']);
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const sha = /^[a-f0-9]{64}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function directory(path, create = false) {
  if (create) {
    await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Workspace directory is unsafe.');
  return path;
}

async function readBounded(path, max) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw Error('Workspace file is unsafe.');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size) throw Error('Workspace file changed during read.');
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path, data) {
  const temp = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(temp, path);
    if (process.platform !== 'win32') {
      const parent = await open(dirname(path), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally {
    await handle.close().catch(() => {});
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function createWorkspaceStore(root = defaultWorkspaceDir()) {
  async function base(create) {
    await directory(root, create);
    return directory(join(root, 'workspace-v1'), create);
  }
  async function records(kind, create) {
    if (!kinds.has(kind)) throw Error('Unknown workspace session kind.');
    return directory(join(await base(create), kind), create);
  }
  function checkedId(value) {
    if (!id.test(value ?? '')) throw Error('Invalid workspace session ID.');
    return value;
  }
  async function record(kind, sessionId) {
    const path = join(await records(kind), checkedId(sessionId) + '.json');
    const value = JSON.parse((await readBounded(path, 24 * 1024 * 1024)).toString('utf8'));
    if (value.format !== WORKSPACE_FORMAT || value.id !== sessionId || value.kind !== kind) throw Error('Invalid workspace session.');
    return value;
  }
  return {
    async save(value) {
      const path = join(await records(value.kind, true), checkedId(value.id) + '.json');
      await writeAtomic(path, JSON.stringify({ ...value, format: WORKSPACE_FORMAT }));
    },
    async remove(kind, sessionId) {
      try { await unlink(join(await records(kind), checkedId(sessionId) + '.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    read: record,
    async list() {
      const entries = [];
      for (const kind of kinds) {
        let files;
        try { files = await readdir(await records(kind), { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        for (const file of files) {
          const sessionId = file.name.slice(0, -5);
          if (!file.isFile() || !file.name.endsWith('.json') || !id.test(sessionId)) continue;
          const value = await record(kind, sessionId).catch(() => null);
          if (!value) continue;
          const { id: key, title, status, updatedAt, url } = value;
          entries.push({ id: key, kind, title, status, updatedAt, ...(url && { url }) });
        }
      }
      return entries.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    },
    async saveArtifact(roomId, ref, bytes) {
      if (!sha.test(ref.sha256 ?? '') || bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) {
        throw Error('Artifact failed its length or SHA-256 check.');
      }
      const parent = await directory(join(await base(true), 'artifacts'), true);
      const group = await directory(join(parent, checkedId(roomId)), true);
      await writeAtomic(join(group, ref.sha256), bytes);
    },
    async readArtifact(roomId, artifactId) {
      const value = await record('group', roomId);
      const ref = value.artifacts?.find(item => item.artifactId === artifactId);
      if (!ref || !sha.test(ref.sha256 ?? '')) throw Error('Unknown workspace artifact.');
      const parent = await directory(join(await base(), 'artifacts'));
      const group = await directory(join(parent, checkedId(roomId)));
      const bytes = await readBounded(join(group, ref.sha256), 2 * 1024 * 1024);
      if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) throw Error('Workspace artifact integrity check failed.');
      return { ...ref, bytes, path: join(group, ref.sha256) };
    },
  };
}

export async function workspaceGroupResult(store, roomId) {
  const value = await store.read('group', roomId).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (value?.status === 'blocked' && value.result?.receiptId && value.result?.diagnosis) {
    return { ok: true, roomId, status: 'blocked', receiptId: value.result.receiptId,
      diagnosis: value.result.diagnosis, retryAllowed: false };
  }
  if (value?.status !== 'completed' || !value.result?.receiptId) {
    return { ok: true, roomId, status: 'pending', retryAllowed: false };
  }
  const artifacts = await Promise.all((value.artifacts ?? []).map(async item => {
    const { bytes, ...ref } = await store.readArtifact(roomId, item.artifactId);
    return { ...ref, bytes: bytes.length };
  }));
  return { ok: true, roomId, status: 'completed', receiptId: value.result.receiptId,
    text: value.result.text, artifacts };
}
