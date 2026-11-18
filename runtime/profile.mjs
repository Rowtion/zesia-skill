import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertNoSecrets } from './evidence.mjs';

export const PROFILE_VERSION = 1;
export const MAX_PROFILE_ITEMS = 10;
export const MAX_PROFILE_TEXT_CHARS = 200;
export const MAX_PROFILE_QUOTE_CHARS = 2000;
export const MAX_PROFILE_BYTES = 4096;

const ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/u;
const TOP_KEYS = new Set(['version', 'updatedAt', 'items']);
const ITEM_KEYS = ['id', 'sourceQuote', 'text', 'updatedAt'];

/** Resolve the local profile JSON file path, keeping test overrides isolated. */
export function defaultProfilePath(env = process.env, fallbackDir = null) {
  if (typeof env.ZESIA_PROFILE === 'string' && env.ZESIA_PROFILE.trim()) {
    return env.ZESIA_PROFILE.trim();
  }
  if (typeof env.ZESIA_CONFIG === 'string' && env.ZESIA_CONFIG.trim()) {
    return join(dirname(env.ZESIA_CONFIG.trim()), 'profile.json');
  }
  if (fallbackDir) {
    return join(fallbackDir, 'profile.json');
  }
  return join(homedir(), '.config', 'zesia', 'profile.json');
}

function validateItemShape(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('Each profile item must be an object.');
  }
  const keys = Object.keys(item).sort();
  if (keys.join(',') !== ITEM_KEYS.join(',')) {
    throw new Error('Profile item has missing or unsupported fields.');
  }
  if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) {
    throw new Error('Profile item id must be 1-32 alphanumeric, dot, underscore, or hyphen characters.');
  }
  if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_PROFILE_TEXT_CHARS) {
    throw new Error(`Profile item text must be a non-empty string of at most ${MAX_PROFILE_TEXT_CHARS} characters.`);
  }
  assertNoSecrets(item.text, 'profile item text');
  if (typeof item.sourceQuote !== 'string' || !item.sourceQuote.trim() || item.sourceQuote.length > MAX_PROFILE_QUOTE_CHARS) {
    throw new Error('Profile item requires a non-empty verbatim user sourceQuote; agent inferences cannot be written to Profile.');
  }
  assertNoSecrets(item.sourceQuote, 'profile item sourceQuote');
  if (typeof item.updatedAt !== 'string' || !item.updatedAt.trim()) {
    throw new Error('Profile item updatedAt must be a non-empty timestamp string.');
  }
}

/** Validate profile schema, capacity limits, byte cap, and provenance requirements. */
export function validateProfile(doc, rawBytes = null) {
  if (Number.isInteger(rawBytes) && rawBytes > MAX_PROFILE_BYTES) {
    throw new Error(`Profile exceeds the 4 KB limit (${rawBytes} / ${MAX_PROFILE_BYTES} bytes).`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('Profile must be a JSON object.');
  }
  if (Object.keys(doc).some(key => !TOP_KEYS.has(key))) {
    throw new Error('Profile contains an unsupported field.');
  }
  if (doc.version !== PROFILE_VERSION) {
    throw new Error(`Unsupported profile version: ${String(doc.version)}.`);
  }
  if (doc.updatedAt !== null && (typeof doc.updatedAt !== 'string' || !doc.updatedAt.trim())) {
    throw new Error('Profile updatedAt must be a non-empty string or null.');
  }
  if (!Array.isArray(doc.items)) {
    throw new Error('Profile items must be an array.');
  }
  if (doc.items.length > MAX_PROFILE_ITEMS) {
    throw new Error(`Profile supports at most ${MAX_PROFILE_ITEMS} items. Overwrite an existing id in-place or remove one with "zesia profile rm <id>".`);
  }
  const seen = new Set();
  for (const item of doc.items) {
    validateItemShape(item);
    if (seen.has(item.id)) {
      throw new Error(`Duplicate profile item id: ${item.id}.`);
    }
    seen.add(item.id);
  }
}

export async function readProfile(path = defaultProfilePath()) {
  const st = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!st) {
    return { version: PROFILE_VERSION, updatedAt: null, items: [] };
  }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
    throw new Error('Profile file must be a regular file without symbolic or hard links.');
  }
  const raw = await readFile(path, 'utf8');
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  if (rawBytes > MAX_PROFILE_BYTES) {
    throw new Error(`Profile exceeds the 4 KB limit (${rawBytes} / ${MAX_PROFILE_BYTES} bytes).`);
  }
  const doc = JSON.parse(raw);
  validateProfile(doc, rawBytes);
  return { version: PROFILE_VERSION, updatedAt: doc.updatedAt, items: doc.items };
}

export async function writeProfile(doc, path = defaultProfilePath()) {
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  validateProfile(doc, bytes);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { bytes, path };
}

export async function setProfileItem({ id, text, sourceQuote, origin } = {}, { path = defaultProfilePath(), now = Date.now } = {}) {
  if (origin !== undefined && origin !== 'user_statement') {
    throw new Error('Only user_statement principles with a verbatim sourceQuote can be saved to Profile.');
  }
  const current = await readProfile(path);
  const timestamp = new Date(now()).toISOString();
  const nextItem = { id, text, sourceQuote, updatedAt: timestamp };
  validateItemShape(nextItem);
  const items = current.items.map(item => ({ ...item }));
  const index = items.findIndex(item => item.id === id);
  let action;
  if (index !== -1) {
    items[index] = nextItem;
    action = 'updated';
  } else if (items.length >= MAX_PROFILE_ITEMS) {
    throw new Error(`Profile already has ${MAX_PROFILE_ITEMS} items (max ${MAX_PROFILE_ITEMS}). Overwrite an existing id in-place or remove one with "zesia profile rm <id>".`);
  } else {
    items.push(nextItem);
    action = 'created';
  }
  const { bytes } = await writeProfile({ version: PROFILE_VERSION, updatedAt: timestamp, items }, path);
  return { ok: true, action, item: nextItem, count: items.length, maxItems: MAX_PROFILE_ITEMS, bytes, maxBytes: MAX_PROFILE_BYTES, path };
}

export async function removeProfileItem(id, { path = defaultProfilePath(), now = Date.now } = {}) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new Error('Profile item id must be 1-32 alphanumeric, dot, underscore, or hyphen characters.');
  }
  const current = await readProfile(path);
  const index = current.items.findIndex(item => item.id === id);
  if (index === -1) {
    throw new Error(`Profile item "${id}" does not exist.`);
  }
  const items = current.items.filter((_, idx) => idx !== index);
  const timestamp = new Date(now()).toISOString();
  const { bytes } = await writeProfile({ version: PROFILE_VERSION, updatedAt: timestamp, items }, path);
  return { ok: true, action: 'removed', id, count: items.length, maxItems: MAX_PROFILE_ITEMS, bytes, maxBytes: MAX_PROFILE_BYTES, path };
}

/** Format the bounded local Profile as deterministic Markdown for human review or cross-agent export. */
export function formatProfileMarkdown(profile) {
  const items = Array.isArray(profile?.items) ? profile.items : [];
  if (!items.length) {
    return `# Zesia Profile (0/${MAX_PROFILE_ITEMS})\n\n_No preferences recorded._\n`;
  }
  const lines = [`# Zesia Profile (${items.length}/${MAX_PROFILE_ITEMS})`, ''];
  for (const item of items) {
    lines.push(`- **${item.id}**: ${item.text}`);
    const quoteLines = String(item.sourceQuote || '').split(/\r?\n/u);
    quoteLines.forEach((line, idx) => {
      const prefix = idx === 0 ? '  > "' : '  > ';
      const suffix = idx === quoteLines.length - 1 ? '"' : '';
      lines.push(`${prefix}${line}${suffix}`);
    });
  }
  return `${lines.join('\n')}\n`;
}

/** Merge local Profile constraints into packet context.statements without overwriting explicit entries. */
export function injectProfileStatements(statements = [], profile) {
  if (!profile?.items?.length) return statements;
  const list = Array.isArray(statements) ? [...statements] : [];
  const seenIds = new Set(list.map(item => item?.id).filter(Boolean));
  const seenRefs = new Set(list.map(item => item?.sourceRef).filter(Boolean));
  for (const item of profile.items) {
    const id = `profile:${item.id}`;
    const sourceRef = `zesia:profile:${item.id}`;
    if (seenIds.has(id) || seenRefs.has(sourceRef)) continue;
    seenIds.add(id);
    seenRefs.add(sourceRef);
    list.push({
      id,
      kind: 'constraint',
      origin: 'user_statement',
      text: item.text,
      sourceRef,
      sourceQuote: item.sourceQuote,
    });
  }
  return list;
}
