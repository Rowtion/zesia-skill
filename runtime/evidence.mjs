import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';

export const MAX_MATERIALS = 16;
export const MAX_MATERIAL_CHARS = 12000;
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;

export const ALLOWED_ATTACHMENT_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
  ['.txt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.csv', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.json', 'application/json'],
]);

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

export function attachmentPayload(attachment) {
  if (!attachment || typeof attachment !== 'object' || typeof attachment.data !== 'string' || typeof attachment.mediaType !== 'string') {
    return { valid: false, base64: '', bytes: 0 };
  }
  const raw = attachment.data.trim();
  let base64 = raw;
  const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(raw);
  if (dataUrlMatch) {
    if (dataUrlMatch[1].toLowerCase() !== attachment.mediaType.toLowerCase()) {
      return { valid: false, base64: '', bytes: 0 };
    }
    base64 = dataUrlMatch[2];
  } else if (/^data:/i.test(raw)) {
    return { valid: false, base64: '', bytes: 0 };
  }
  const normalized = base64.replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return { valid: false, base64: '', bytes: 0 };
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return { valid: true, base64: normalized, bytes: Math.floor((normalized.length * 3) / 4) - padding };
}

/** Scan every string in the outgoing packet, including caller-supplied materials. */
export function scanPacket(packet) {
  const walk = (value, path) => {
    if (typeof value === 'string') assertNoSecrets(value, path || 'consultation content');
    else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}.${i}`);
    } else if (value && typeof value === 'object') {
      if (path.startsWith('context.attachments.') && typeof value.mediaType === 'string' && typeof value.data === 'string') {
        for (const [key, child] of Object.entries(value)) {
          if (key === 'data') {
            if (value.mediaType.startsWith('text/') || value.mediaType === 'application/json') {
              const parsed = attachmentPayload(value);
              if (parsed.valid) assertNoSecrets(Buffer.from(parsed.base64, 'base64').toString('utf8'), `${path}.data`);
            }
          } else {
            walk(child, `${path}.${key}`);
          }
        }
        return;
      }
      for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(packet, '');
}

export function projectRoot(env = process.env) {
  return resolve(env.CLAUDE_PROJECT_DIR || process.cwd());
}

async function resolveProjectFile(filePath, realRoot, maxSize = 2_000_000) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Evidence needs a project-relative path.');
  const target = await realpath(resolve(realRoot, filePath));
  const name = relative(realRoot, target);
  if (!name || name.startsWith('..') || isAbsolute(name) || name.split(/[\\/]/u).some(part => CREDENTIAL_PATH.test(part))) {
    throw new Error('Evidence path is outside the project or contains credential/configuration data.');
  }
  const handle = await open(target, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxSize) throw new Error('Select a project file within the allowed size limit.');
    // A hardlink inside the project can still point at an outside file;
    // realpath cannot see that, so reject multiply-linked files outright.
    if (info.nlink > 1) throw new Error('Evidence file has multiple hard links; choose a regular project file.');
    return { name, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

function buildExcerptChunk(name, chunkStart, chunkEnd, chunkLines) {
  const excerpt = chunkLines.join('');
  assertNoSecrets(excerpt, `Evidence ${name}`);
  const hash = createHash('sha256').update(excerpt).digest('hex');
  const content = `Source: ${name}:${chunkStart}-${chunkEnd}\nExcerpt SHA-256: ${hash}\n${excerpt}`;
  const identity = createHash('sha256').update(`${name}:${chunkStart}-${chunkEnd}\n${excerpt}`).digest('hex');
  return { id: `file-${identity.slice(0, 20)}`, content };
}

/**
 * Copy bounded text excerpts from files inside the project, automatically
 * splitting long selections along line boundaries into <= 12,000-char chunks.
 */
export async function captureEvidence(files = [], { root = projectRoot() } = {}) {
  if (!Array.isArray(files) || files.length > MAX_MATERIALS) throw new Error(`Supply at most ${MAX_MATERIALS} file excerpts.`);
  if (!files.length) return [];
  const realRoot = await realpath(root);
  const materials = [];
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !file.path.trim()) throw new Error('Evidence needs a project-relative path.');
    const { name, bytes } = await resolveProjectFile(file.path, realRoot, 2_000_000);
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (source.includes('\0')) throw new Error('Binary evidence is not supported in evidenceFiles; use attachmentFiles for images or PDFs.');
    const lines = source.match(/[^\n]*\n|[^\n]+$/gu) || [];
    const lastReadableLine = lines.length + (source.endsWith('\n') ? 1 : 0);
    const start = file.startLine ?? 1;
    const end = file.endLine ?? lines.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > lines.length || end < start || end > lastReadableLine) {
      throw new Error(`Choose an existing line range within ${name} (1-${lines.length}).`);
    }

    let cursor = start;
    while (cursor <= end) {
      let chunkEnd = cursor;
      let built = null;
      while (chunkEnd <= end) {
        const candidate = buildExcerptChunk(name, cursor, chunkEnd, lines.slice(cursor - 1, chunkEnd));
        if (candidate.content.length > MAX_MATERIAL_CHARS) {
          if (chunkEnd === cursor) {
            throw new Error(`A single line at ${name}:${cursor} exceeds ${MAX_MATERIAL_CHARS} characters; attach as a file or select a shorter range.`);
          }
          break;
        }
        built = candidate;
        chunkEnd += 1;
      }
      materials.push(built);
      if (materials.length > MAX_MATERIALS) {
        throw new Error(`Evidence splits into more than ${MAX_MATERIALS} chunks; select a narrower set of files.`);
      }
      cursor = chunkEnd;
    }
  }
  return materials;
}

/**
 * Copy image/document attachments from inside the project for multimodal
 * review (screenshots, PDFs, markdown/text specs) up to 10 files / 6 MiB total.
 */
export async function captureAttachments(files = [], { root = projectRoot() } = {}) {
  if (!Array.isArray(files) || files.length > MAX_ATTACHMENTS) throw new Error(`Supply at most ${MAX_ATTACHMENTS} attachment files.`);
  if (!files.length) return [];
  const realRoot = await realpath(root);
  const attachments = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || !file.path.trim()) throw new Error('Attachment needs a project-relative path.');
    const { name, bytes } = await resolveProjectFile(file.path, realRoot, MAX_ATTACHMENT_BYTES);
    const mediaType = file.mediaType || ALLOWED_ATTACHMENT_TYPES.get(extname(name).toLowerCase());
    if (!mediaType || ![...ALLOWED_ATTACHMENT_TYPES.values()].includes(mediaType)) {
      throw new Error(`Unsupported attachment type for ${name}. Allowed: png, jpg, webp, gif, pdf, txt, md, json.`);
    }
    if (mediaType.startsWith('text/') || mediaType === 'application/json') {
      assertNoSecrets(new TextDecoder('utf-8', { fatal: false }).decode(bytes), `Attachment ${name}`);
    }
    const base64 = bytes.toString('base64');
    const data = `data:${mediaType};base64,${base64}`;
    totalBytes += Buffer.byteLength(data, 'utf8');
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Total attachment payload exceeds ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MiB.`);
    }
    const identity = createHash('sha256').update(bytes).digest('hex');
    attachments.push({
      id: `att-${identity.slice(0, 16)}`,
      filename: basename(name),
      mediaType,
      data,
    });
  }
  return attachments;
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

export function mergeAttachments(existing = [], additions = []) {
  const map = new Map();
  for (const item of [...existing, ...additions]) {
    if (map.has(item.id) && map.get(item.id).data !== item.data) {
      throw new Error('Conflicting attachment IDs. Nothing sent.');
    }
    map.set(item.id, item);
  }
  return [...map.values()];
}
