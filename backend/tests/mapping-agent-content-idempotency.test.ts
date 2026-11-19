import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { command, contentFixture, patch, type ContentFixture } from './fixtures/agent-content.js';

async function withMcp(f: ContentFixture, token: string, run: (client: Client) => Promise<void>) {
  const client = new Client({ name: 'body-patch-stdio', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp.ts'],
    cwd: process.cwd(),
    env: { FORKWISE_URL: f.origin, FORKWISE_AGENT_TOKEN: token },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    await run(client);
  } finally {
    await client.close();
  }
}

it('AC5 Bearer 提交后丢弃响应，服务和 SQLite 重开后用真实 MCP stdio 取回原回执', async () => {
  const f = await contentFixture();
  const token = f.issue([f.grant()]);
  const req = patch(f.card().body.versionId);
  const before = f.snapshot();
  const lost = await f.request('/api/mapping/execute', token, req);
  expect(lost.status).toBe(200);
  await lost.body?.cancel();
  const committed = f.snapshot();
  expect(committed.state.project.revision).toBe(before.state.project.revision + 1);
  expect(committed.history.undo).toHaveLength(before.history.undo.length + 1);
  expect(committed.receipts).toHaveLength(before.receipts.length + 1);
  const expected = committed.receipts.find(entry => (entry as { command_id: string }).command_id === req.commandId) as { receipt: string };

  await f.restart();
  expect(f.snapshot()).toEqual(committed);
  const args = {
    projectId: req.projectId, commandId: req.commandId, expected: req.expected,
    cardId: req.payload.id, blockId: req.payload.blockId, range: req.payload.range, text: req.payload.text,
  };
  const next = { ...args, commandId: command('', null, null).commandId, expected: f.card().body.versionId, text: '又' };
  await withMcp(f, token, async (client) => {
    const replay = await client.callTool({ name: 'forkwise_patch_card_body', arguments: args });
    expect(replay.structuredContent).toEqual({ response: JSON.parse(expected.receipt) });
    expect(await f.post(req, token)).toEqual({ status: 200, body: JSON.parse(expected.receipt) });
    expect(f.snapshot()).toEqual(committed);
    const distinct = await client.callTool({
      name: 'forkwise_patch_card_body',
      arguments: next,
    });
    expect(distinct.structuredContent).toMatchObject({ error: { code: 'CONTENT_VERSION_FORBIDDEN' } });
    expect(f.snapshot()).toEqual(committed);
  });
  await withMcp(f, f.issue([f.grant()]), async (client) => {
    const fresh = await client.callTool({ name: 'forkwise_patch_card_body', arguments: next });
    expect(fresh.structuredContent).toMatchObject({ response: { revision: committed.state.project.revision + 1 } });
    expect(f.card().body.blocks[0]?.text).toBe('又文😀e\u0301结束');
  });
});

it.each(['actor', 'body'])('AC4/AC5 同 commandId 更换%s返回冲突且无写入', async (changed) => {
  const f = await contentFixture();
  const actor = f.issue([f.grant()]);
  const sender = changed === 'actor' ? f.issue([f.grant()]) : actor;
  const req = patch(f.card().body.versionId);
  expect((await f.post(req, actor)).status).toBe(200);
  const committed = f.snapshot();
  const replay = changed === 'body' ? { ...req, payload: { ...req.payload, text: '改变' } } : req;
  expect(await f.post(replay, sender)).toMatchObject({ status: 409, body: { code: 'IDEMPOTENCY_MISMATCH' } });
  expect(f.snapshot()).toEqual(committed);
});

it.each(['versions', 'history', 'receipt'] as const)('AC3 %s 抛错后同一事务完整回滚', async (failedPhase) => {
  let armed = false;
  let reached = false;
  const f = await contentFixture((phase) => {
    if (armed && phase === failedPhase) {
      reached = true;
      throw new Error('已注入事务故障');
    }
  });
  const req = patch(f.card().body.versionId);
  const token = f.issue([f.grant()]);
  const before = f.snapshot();
  armed = true;
  const failed = await f.request('/api/mapping/execute', token, req);
  expect(failed.status).toBe(503);
  await failed.body?.cancel();
  expect(reached).toBe(true);
  expect(f.snapshot()).toEqual(before);
  armed = false;
  expect((await f.post(req, token)).status).toBe(200);
  expect(f.state().project.revision).toBe(before.state.project.revision + 1);
  expect(f.history().undo).toHaveLength(before.history.undo.length + 1);
});
