import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createWorkspaceStore } from '../runtime/workspace.mjs';
import { createGroupWorkflow } from '../runtime/collab-room.mjs';
import { ONLINE_ORIGINS, startOnlineReview } from './online.mjs';

const workspaceOrigins = new Set([...ONLINE_ORIGINS, 'https://zesia-consult-staging.cprindex.workers.dev']);
const safeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function authorized(header, expected) {
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function jsonBody(request) {
  if (request.headers['content-type'] !== 'application/json') throw Error('Expected a JSON request.');
  const parts = [];
  let bytes = 0;
  for await (const part of request) {
    bytes += part.length;
    if (bytes > 16_384) throw Error('Workspace request is too large.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}

export async function startWorkspaceReview({
  runtime, origin = 'https://zesia.dev', store = createWorkspaceStore(), configuration, groupPacket,
  group = createGroupWorkflow({ store, configuration }), idleMs = 15 * 60_000,
} = {}) {
  if (!workspaceOrigins.has(origin)) throw Error('The workspace origin is not supported.');
  if (groupPacket && new URL((await configuration()).url).origin !== origin) {
    throw Error('Open group review on the same origin as the configured Consult Worker.');
  }
  const selectedDraft = groupPacket ? await group.stage(groupPacket) : '';
  const secret = randomBytes(32).toString('base64url');
  const expected = Buffer.from('Bearer ' + secret);
  let host;
  let lastActivity = Date.now();
  const reviews = new Set();
  let closed = false;

  async function consultSession(kind, sessionId) {
    if (!['draft', 'consult'].includes(kind)) throw Error('Unknown consultation kind.');
    const inspected = await runtime.inspect(sessionId);
    if (!inspected.ok || !inspected.packet || (kind === 'draft' ? inspected.status !== 'prepared' : inspected.status === 'prepared')) {
      throw Error('The selected consultation is unavailable.');
    }
    const { id, title, status, updatedAt } = {
      id: sessionId, title: inspected.packet.project || inspected.packet.brief, status: inspected.status,
      updatedAt: inspected.completedAt || inspected.expiresAt || new Date().toISOString(),
    };
    return { kind, id, title, status, updatedAt, packet: inspected.packet, result: inspected.result };
  }

  async function inventory() {
    const local = await runtime.list();
    const entries = new Map((await store.list())
      .filter(item => item.kind === 'group').map(item => [item.id, item]));
    for (const record of local.records) {
      if (!record.hasMaterials || !['prepared', 'sending', 'unknown', 'completed', 'failed'].includes(record.status)
        || (record.status === 'prepared' && record.expired)) continue;
      const kind = record.status === 'prepared' ? 'draft' : 'consult';
      const session = await consultSession(kind, record.draftId).catch(() => null);
      if (!session) continue;
      const { packet: _packet, result: _result, ...item } = session;
      entries.set(item.id, item);
    }
    for (const item of group.list()) if (!entries.has(item.id)) entries.set(item.id, item);
    return Array.from(entries.values()).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  const server = createServer(async (request, response) => {
    const headers = {
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'access-control-allow-origin': origin, vary: 'Origin',
    };
    function reply(status, data) {
      response.writeHead(status, { ...headers, 'content-type': 'application/json' });
      response.end(JSON.stringify(data));
    }
    try {
      if (closed || request.headers.host !== host || request.headers.origin !== origin || !request.url.startsWith('/bridge/v1/workspace')) {
        return reply(403, { ok: false });
      }
      if (request.method === 'OPTIONS') {
        const requestedHeaders = (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!['GET', 'POST'].includes(request.headers['access-control-request-method'])
          || requestedHeaders.some(value => !['authorization', 'content-type'].includes(value))) return reply(403, { ok: false });
        response.writeHead(204, { ...headers, 'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': 'Authorization, Content-Type',
        });
        return response.end();
      }
      if (!authorized(request.headers.authorization, expected)) return reply(403, { ok: false });
      lastActivity = Date.now();
      const url = new URL(request.url, 'http://' + host);
      const path = url.pathname;
      if (request.method === 'GET' && path === '/bridge/v1/workspace') {
        return reply(200, { version: 1, sessions: await inventory() });
      }
      if (request.method === 'POST' && path === '/bridge/v1/workspace/group/decision') {
        const value = await group.decision(await jsonBody(request));
        return reply(200, value);
      }
      const id = url.searchParams.get('id');
      if (!safeId.test(id ?? '')) return reply(404, { ok: false });
      const kind = url.searchParams.get('kind');
      if (request.method === 'GET' && path === '/bridge/v1/workspace/session') {
        const preview = kind === 'draft' && group.preview(id);
        const value = preview ? { id, kind, groupDraft: true, snapshot: preview } : kind === 'group'
          ? await store.read(kind, id) : await consultSession(kind, id);
        return reply(200, value);
      }
      if (request.method === 'GET' && path === '/bridge/v1/workspace/artifact') {
        const artifactId = url.searchParams.get('artifact');
        const value = kind === 'draft' ? group.attachment(id, artifactId) : await store.readArtifact(id, artifactId);
        response.writeHead(200, { ...headers, 'content-type': 'application/octet-stream',
          'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(value.filename), 'content-length': value.bytes.length,
        });
        return response.end(value.bytes);
      }
      if (request.method === 'POST' && path === '/bridge/v1/workspace/review' && kind === 'draft' && ONLINE_ORIGINS.includes(origin)) {
        const review = await startOnlineReview({ runtime, draftId: id, onlineOrigin: origin, onClose: () => reviews.delete(review) });
        reviews.add(review);
        return reply(200, { url: review.url });
      }
      return reply(404, { ok: false });
    } catch {
      if (!response.headersSent) reply(409, { ok: false, message: 'This local workspace operation is unavailable.' });
      else response.end();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  host = '127.0.0.1:' + port;
  function close() {
    closed = true;
    clearInterval(timer);
    for (const review of reviews) review.close();
    server.close();
    server.closeAllConnections();
  }
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > idleMs && !group.list().some(item => item.kind === 'group')) close();
    else void group.sync();
  }, 3_000);
  const query = selectedDraft ? '?' + new URLSearchParams({ draft: selectedDraft }) : '';
  const fragment = new URLSearchParams({ workspace: '1', port: String(port), key: secret });
  return { url: origin + '/consult' + query + '#' + fragment, close };
}
