import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkflow } from '../runtime/workflow.mjs';
import { createPortable } from '../runtime.mjs';
import { consultOverA2A } from '../runtime/a2a.mjs';

test('auto-chunks large evidenceFiles along line boundaries up to 16 materials of 12,000 chars', async () => {
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zesia-evidence-'));
  try {
    process.chdir(dir);
    const filePath = path.join(dir, 'large.css');
    const line = '.card-item { display: flex; gap: 12px; padding: 16px; color: #111827; }\n';
    const lines = Array.from({ length: 300 }, (_, i) => `/* ${String(i + 1).padStart(3, '0')} */ ${line}`);
    fs.writeFileSync(filePath, lines.join(''));

    const wf = createWorkflow({
      dataDir: path.join(dir, 'data'),
      requester: 'TestAgent',
      project: 'demo',
    });
    const res = await wf.prepareConsult({
      brief: 'Review the large stylesheet.',
      context: { goal: 'Check layout rules.' },
      evidenceFiles: [{ id: 'styles', path: 'large.css', startLine: 1, endLine: 300 }],
    });

    assert.equal(res.ok, true, res.errorMessage || '');
    const mats = res.draft.packet.context.materials;
    assert.ok(mats.length >= 2 && mats.length <= 16, `expected >=2 chunks, got ${mats.length}`);
    for (const m of mats) {
      assert.ok(m.content.length <= 12000, `chunk exceeded 12000 chars: ${m.content.length}`);
    }
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('captures image attachmentFiles and enforces 6 MiB / supported type rules', async () => {
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zesia-attach-'));
  try {
    process.chdir(dir);
    const imgPath = path.join(dir, 'screenshot.png');
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082',
      'hex',
    );
    fs.writeFileSync(imgPath, pngBytes);

    const badPath = path.join(dir, 'archive.zip');
    fs.writeFileSync(badPath, Buffer.from([1, 2, 3, 4]));

    const wf = createWorkflow({
      dataDir: path.join(dir, 'data'),
      requester: 'TestAgent',
      project: 'demo',
    });

    const okRes = await wf.prepareConsult({
      brief: 'Inspect this UI screenshot.',
      context: { goal: 'Verify alignment.' },
      attachmentFiles: [{ id: 'ui', path: 'screenshot.png', description: 'Homepage screenshot' }],
    });
    assert.equal(okRes.ok, true, okRes.errorMessage || '');
    const pkt = okRes.draft.packet;
    assert.equal(pkt.context.attachments.length, 1);
    const att = pkt.context.attachments[0];
    assert.equal(att.mediaType, 'image/png');
    assert.ok(att.data.startsWith('data:image/png;base64,'));
    assert.equal(Buffer.from(att.data.split(',')[1], 'base64').length, pngBytes.length);

    const badRes = await wf.prepareConsult({
      brief: 'Inspect invalid attachment.',
      context: { goal: 'Reject unsupported format.' },
      attachmentFiles: [{ id: 'bad', path: 'archive.zip' }],
    });
    assert.equal(badRes.ok, false);
    assert.equal(badRes.errorCode, 'preparation_failed');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createPortable prepare expands attachmentFiles and consultOverA2A accepts >200 KiB attachments', async () => {
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zesia-portable-att-'));
  try {
    process.chdir(dir);
    const largeBytes = Buffer.alloc(190_000, 0x41);
    fs.writeFileSync(path.join(dir, 'large.png'), largeBytes);

    const runtime = createPortable({
      stateDir: path.join(dir, 'state'),
      configuration: async () => ({ url: 'https://consult.example', token: 'synthetic-token' }),
    });
    const prepared = await runtime.prepare({
      requester: 'Codex',
      project: 'demo',
      brief: 'Inspect screenshot.',
      context: { goal: 'Check UI.' },
      attachmentFiles: [{ path: 'large.png' }],
    });
    assert.equal(prepared.ok, true);
    assert.equal(prepared.packet.context.attachments[0].filename, 'large.png');
    assert.ok(Buffer.byteLength(prepared.packet.context.attachments[0].data, 'utf8') > 200_000);

    let calls = 0;
    const result = await consultOverA2A({
      url: 'https://consult.example',
      token: 'synthetic-cli-secret',
      input: prepared.packet,
      fetch: async (_url, init) => {
        calls++;
        const rpc = JSON.parse(init.body);
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            message: {
              messageId: 'm1',
              contextId: 'c1',
              role: 'ROLE_AGENT',
              parts: [{ mediaType: 'application/vnd.zesia.consult+json', data: { format: 'zesia.consult.v0', advice: 'Looks good.', consultId: 'cid1', followUp: { requests: [] } } }],
            },
          },
        });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.consultId, 'cid1');
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
