import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rename, lstat, unlink, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const WORKSPACE_FORMAT = 'zesia.workspace.session.v1';
export const defaultWorkspaceDir = () => process.env.ZESIA_WORKSPACE_DIR || join(homedir(), '.zesia');
const kinds = new Set(['draft', 'consult', 'group']);
const id = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const sha = /^[a-f0-9]{64}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const DRIVER_RECOVERY_MS = 48 * 60 * 60_000;
const roomIdPattern = /^room_[a-f0-9]{48}$/u;

function driverRecoveryExpiry(record) {
  const issued = Number(/^zrq-(\d+)-/u.exec(record?.requestId ?? '')?.[1]);
  return Number.isSafeInteger(issued) && issued >= 0 ? issued + DRIVER_RECOVERY_MS : 0;
}

async function directory(path, create = false) {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(dirname(path));
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Workspace directory is unsafe.');
  return path;
}

async function readBounded(path, max, privateFile = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw Error('Workspace file is unsafe.');
    if (privateFile && process.platform !== 'win32' && (stat.mode & 0o077)) throw Error('Driver recovery file permissions are unsafe.');
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
    await syncDirectory(dirname(path));
  } finally {
    await handle.close().catch(() => {});
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function syncDirectory(path) {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishDirectory(path, fill) {
  const temporary = await mkdtemp(join(dirname(path), '.incoming-'));
  try {
    await fill(temporary);
    await syncDirectory(temporary);
    try {
      await rename(temporary, path);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function deliveryOutput(folder, output, create = false) {
  if (!/^output\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}\/)*[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/u.test(output.path)
    || !sha.test(output.sha256) || !Number.isSafeInteger(output.bytes) || output.bytes < 1 || output.bytes > 2 * 1024 * 1024) {
    throw Error('Invalid delivery artifact reference.');
  }
  const segments = output.path.split('/');
  const file = segments.pop();
  for (const segment of segments) folder = await directory(join(folder, segment), create);
  return join(folder, file);
}

function requireOutputBytes(output, bytes) {
  const sha256 = digest(bytes);
  if (bytes.length !== output.bytes || sha256 !== output.sha256) throw Error('Delivery artifact failed verification.');
  return { path: output.path, sha256, bytes: bytes.length };
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
  async function deliveries(roomId, create) {
    const entries = await directory(join(await base(create), 'deliveries'), create);
    return directory(join(entries, checkedId(roomId)), create);
  }
  async function recoveryPath(roomId, create) {
    const parent = await directory(join(await base(create), 'driver-recovery'), create);
    return join(parent, checkedId(roomId) + '.json');
  }
  async function removeDriverRecovery(roomId) {
    try { await unlink(await recoveryPath(roomId)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function readDriverDelivery(roomId, deliveryId) {
    const folder = await directory(join(await deliveries(roomId), checkedId(deliveryId)));
    const sealed = JSON.parse(await readBounded(join(folder, 'receipt.json'), 128 * 1024));
    if (sealed.manifest?.roomId !== roomId || sealed.manifest.deliveryId !== deliveryId
      || !sha.test(sealed.manifestSha256) || !sha.test(sealed.localReceiptSha256)
      || !Array.isArray(sealed.manifest.outputs) || !sealed.manifest.outputs.length || sealed.manifest.outputs.length > 8) {
      throw Error('Invalid local delivery receipt.');
    }
    const artifacts = [];
    const measuredOutputs = [];
    for (const output of sealed.manifest.outputs) {
      const path = await deliveryOutput(folder, output);
      measuredOutputs.push(requireOutputBytes(output, await readBounded(path, output.bytes)));
      artifacts.push({ ...output, path });
    }
    return { folder, sealed, artifacts, measuredOutputs };
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
    readDriverDelivery,
    async saveDriverRecovery(roomId, state) {
      await writeAtomic(await recoveryPath(roomId, true), JSON.stringify(state));
    },
    async readDriverRecovery(roomId, now = Date.now()) {
      const record = JSON.parse(await readBounded(await recoveryPath(roomId), 8 * 1024, true));
      if (driverRecoveryExpiry(record) <= now) {
        await removeDriverRecovery(roomId);
        throw Error('The local driver recovery key expired.');
      }
      return record;
    },
    removeDriverRecovery,
    async cleanDriverRecovery({ all = false, apply = false, now = Date.now() } = {}) {
      let parent, entries;
      try {
        parent = await directory(join(await base(), 'driver-recovery'));
        entries = await readdir(parent, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const removed = [];
      for (const entry of entries) {
        const roomId = entry.name.slice(0, -5);
        if (!entry.isFile() || !entry.name.endsWith('.json') || !roomIdPattern.test(roomId)) continue;
        if (!all) {
          const record = await readBounded(join(parent, entry.name), 8 * 1024, true).then(JSON.parse).catch(() => null);
          if (driverRecoveryExpiry(record) > now) continue;
        }
        if (apply) await removeDriverRecovery(roomId);
        removed.push(roomId);
      }
      return removed;
    },
    async saveDriverDelivery(roomId, sealed, download) {
      const deliveryId = checkedId(sealed.manifest.deliveryId);
      const ready = await readDriverDelivery(roomId, deliveryId).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (ready) {
        if (ready.sealed.manifestSha256 !== sealed.manifestSha256 || ready.sealed.localReceiptSha256 !== sealed.localReceiptSha256) {
          throw Error('The local delivery conflicts with the sealed manifest.');
        }
        return ready;
      }
      const parent = await deliveries(roomId, true);
      await publishDirectory(join(parent, deliveryId), async temporary => {
        for (const output of sealed.manifest.outputs) {
          const bytes = await download(output);
          requireOutputBytes(output, bytes);
          await writeAtomic(await deliveryOutput(temporary, output, true), bytes);
        }
        await writeAtomic(join(temporary, 'receipt.json'), JSON.stringify(sealed));
      });
      const saved = await readDriverDelivery(roomId, deliveryId);
      if (saved.sealed.manifestSha256 !== sealed.manifestSha256 || saved.sealed.localReceiptSha256 !== sealed.localReceiptSha256) {
        throw Error('The local delivery conflicts with the sealed manifest.');
      }
      return saved;
    },
    async saveDriverProof(roomId, deliveryId, attestation, summary) {
      const { folder } = await readDriverDelivery(roomId, deliveryId);
      const proof = join(folder, 'proof');
      const exists = await directory(proof).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!exists) await publishDirectory(proof, async temporary => {
        await writeAtomic(join(temporary, 'attestation.json'), attestation);
        await writeAtomic(join(temporary, 'SUMMARY.md'), summary);
      });
      const attestationPath = join(proof, 'attestation.json');
      const summaryPath = join(proof, 'SUMMARY.md');
      const [savedAttestation, savedSummary] = await Promise.all([
        readBounded(attestationPath, 128 * 1024), readBounded(summaryPath, 128 * 1024),
      ]);
      if (!savedAttestation.equals(attestation) || !savedSummary.equals(summary)) throw Error('The local proof conflicts with the cloud receipt.');
      return { attestationPath, summaryPath, attestationSha256: digest(attestation), summarySha256: digest(summary) };
    },
    async readDriverProof(roomId, deliveryId, ref) {
      const stored = await readDriverDelivery(roomId, deliveryId);
      const proof = await directory(join(stored.folder, 'proof'));
      const attestationPath = join(proof, 'attestation.json');
      const summaryPath = join(proof, 'SUMMARY.md');
      const [attestation, summary] = await Promise.all([readBounded(attestationPath, 128 * 1024), readBounded(summaryPath, 128 * 1024)]);
      if (digest(attestation) !== ref.attestationSha256 || digest(summary) !== ref.summarySha256) throw Error('Local delivery proof integrity check failed.');
      return { artifacts: stored.artifacts, attestationPath, summaryPath };
    },
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
  if (value?.status === 'expired' && value.driverDeliveryId) {
    const { artifacts } = await store.readDriverDelivery(roomId, value.driverDeliveryId);
    return { ok: true, roomId, status: 'expired', receiptId: value.driverDeliveryId,
      cloudPurgedAt: value.cloudCopy.cloudPurgedAt, artifacts, retryAllowed: false };
  }
  if (value?.status !== 'completed' || !value.result?.receiptId) {
    return { ok: true, roomId, status: 'pending', retryAllowed: false };
  }
  if (value.driverProof) {
    const proof = await store.readDriverProof(roomId, value.result.receiptId, value.driverProof);
    return { ok: true, roomId, status: 'completed', receiptId: value.result.receiptId,
      text: value.result.text, cloudPurgedAt: value.cloudCopy.cloudPurgedAt, ...proof };
  }
  const artifacts = await Promise.all((value.artifacts ?? []).map(async item => {
    const { bytes, ...ref } = await store.readArtifact(roomId, item.artifactId);
    return { ...ref, bytes: bytes.length };
  }));
  return { ok: true, roomId, status: 'completed', receiptId: value.result.receiptId,
    text: value.result.text, artifacts };
}
