import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

// Path segments that must never be copied as evidence. This is a locator
// guard, not a general sensitive-content detector; outgoing text is also
// scanned for high-confidence credentials below.
const CREDENTIAL_PATH = /^(?:\.env(?:\..*)?|\.git|\.aws|\.ssh|\.gnupg|\.docker|\.kube|\.config|\.netrc|\.npmrc|\.git-credentials|\.pgpass|\.htpasswd|known_hosts|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|tfvars|tfstate))$/iu;

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u, 'private key'],
  [/_authToken\s*=\s*\S+/u, 'npm auth token'],
  [/\bAKIA[0-9A-Z]{16}\b/u, 'AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/u, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/u, 'API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u, 'Slack token'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/u, 'bearer token'],
];

export function assertNoSecrets(value, label = 'consultation content') {
  if (typeof value !== 'string') return;
  for (const [pattern, kind] of SECRET_PATTERNS) {
    if (pattern.test(value)) throw new Error(`${label} appears to contain a ${kind}. Remove the secret before sending; nothing was sent.`);
  }
}

/** Scan every string in the outgoing packet, including caller-supplied materials. */
export function scanPacket(packet) {
  const walk = (value, path) => {
    if (typeof value === 'string') assertNoSecrets(value, path || 'consultation content');
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(packet, '');
}

export function projectRoot(env = process.env) {
  return resolve(env.CLAUDE_PROJECT_DIR || process.cwd());
}

/**
 * Copy at most three bounded excerpts from files inside the project. Rejects
 * credential-shaped paths, hardlinks, binary files and high-confidence secret
 * patterns. The user still reviews the packet before anything leaves the
 * machine.
 */
export async function captureEvidence(files = [], { root = projectRoot() } = {}) {
  if (!Array.isArray(files) || files.length > 3) throw new Error('Supply at most three bounded file excerpts.');
  if (!files.length) return [];
  const realRoot = await realpath(root);
  const materials = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !file.path.trim()) throw new Error('Evidence needs a project-relative path.');
    const target = await realpath(resolve(realRoot, file.path));
    const name = relative(realRoot, target);
    if (!name || name.startsWith('..') || isAbsolute(name) || name.split(/[\\/]/u).some(part => CREDENTIAL_PATH.test(part))) {
      throw new Error('Evidence path is outside the project or contains credential/configuration data.');
    }
    const handle = await open(target, 'r');
    let bytes;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 2_000_000) throw new Error('Select a small text evidence file.');
      // A hardlink inside the project can still point at an outside file;
      // realpath cannot see that, so reject multiply-linked files outright.
      if (info.nlink > 1) throw new Error('Evidence file has multiple hard links; choose a regular project file.');
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (source.includes('\0')) throw new Error('Binary evidence is not supported.');
    const lines = source.match(/[^\n]*\n|[^\n]+$/gu) || [];
    // Claude Read numbers the empty EOF line after a final newline. Accept that
    // one line in an inclusive range, while preserving the original bytes and
    // rejecting ranges beyond EOF or excerpts made only of that empty line.
    const lastReadableLine = lines.length + (source.endsWith('\n') ? 1 : 0);
    const start = file.startLine ?? 1;
    const end = file.endLine ?? Math.min(lines.length, start + 119);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > lines.length || end < start || end > lastReadableLine || end - start > 199) {
      throw new Error('Choose an existing range of at most 200 lines.');
    }
    const excerpt = lines.slice(start - 1, end).join('');
    assertNoSecrets(excerpt, `Evidence ${name}`);
    const hash = createHash('sha256').update(excerpt).digest('hex');
    const content = `Source: ${name}:${start}-${end}\nExcerpt SHA-256: ${hash}\n${excerpt}`;
    if (content.length > 6000) throw new Error('Evidence excerpt exceeds 6000 characters; select a narrower range.');
    const identity = createHash('sha256').update(`${name}:${start}-${end}\n${excerpt}`).digest('hex');
    materials.push({ id: `file-${identity.slice(0, 20)}`, content });
  }
  return materials;
}

export function mergeEvidence(existing = [], additions = []) {
  const map = new Map();
  for (const item of [...existing, ...additions]) {
    if (map.has(item.id) && map.get(item.id).content !== item.content) {
      throw new Error('Conflicting evidence IDs. Nothing sent.');
    }
    map.set(item.id, item);
  }
  return [...map.values()];
}
