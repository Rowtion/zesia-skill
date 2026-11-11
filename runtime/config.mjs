import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const REQUESTER = 'Claude Code';
export const DEFAULT_SERVICE_URL = 'https://api.zesia.dev';
const LEGACY_SERVICE_URL = 'https://zesia-consult.cprindex.workers.dev';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function defaultConfigPath(env = process.env) {
  return env.ZESIA_CONFIG || join(homedir(), '.config', 'zesia', 'claude-code.json');
}

/** Treat the retired workers.dev default as the current product endpoint. */
export function normalizeServiceUrl(stored) {
  if (typeof stored !== 'string' || !stored.trim()) return DEFAULT_SERVICE_URL;
  try {
    if (new URL(stored).origin === LEGACY_SERVICE_URL) return DEFAULT_SERVICE_URL;
  } catch {
    // destinationOf reports the malformed URL with a precise error.
  }
  return stored;
}

/** Return the canonical origin, rejecting remote plaintext and URL credentials. */
export function destinationOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('ZESIA_URL is not a valid URL.');
  }
  if (parsed.username || parsed.password) throw new Error('Do not put credentials in ZESIA_URL.');
  const loopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) throw new Error('ZESIA_URL must use HTTPS or loopback HTTP.');
  return parsed.origin;
}

export async function readConfig(env = process.env, { requireToken = true } = {}) {
  const path = defaultConfigPath(env);
  let stored = {};
  try {
    stored = JSON.parse(await readFile(path, 'utf8'));
    // Re-tighten a config created by an older version or by hand.
    await chmod(path, 0o600).catch(() => {});
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read the zesia configuration.');
  }
  const config = {
    url: destinationOf(env.ZESIA_URL || normalizeServiceUrl(stored.url)),
    token: env.ZESIA_TOKEN || (typeof stored.token === 'string' ? stored.token : ''),
    project: env.ZESIA_PROJECT || (typeof stored.project === 'string' ? stored.project : ''),
    // This plugin always requires an explicit confirmation and approval prompt.
    // Older configs may still contain confirmBeforeSend; it is intentionally ignored.
    confirmBeforeSend: true,
    path,
  };
  if (config.token && /[\s\x00-\x1f\x7f]/u.test(config.token)) {
    throw new Error('The configured trial token contains whitespace or control characters.');
  }
  if (requireToken && !config.token) {
    throw new Error('Configure the zesia trial token first: node scripts/configure.mjs');
  }
  return config;
}

/** Merge and atomically rewrite the private local configuration (mode 0600). */
export async function saveConfig(values = {}, env = process.env) {
  const path = defaultConfigPath(env);
  let previous = {};
  try {
    previous = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not update the zesia configuration.');
  }
  const next = { ...previous, ...values };
  if (next.url) next.url = destinationOf(next.url);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return path;
}
