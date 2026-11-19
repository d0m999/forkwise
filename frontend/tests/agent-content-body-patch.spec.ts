import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '../../backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { expect, place, test } from './writing-board-fixture';

test('本人签发的 Agent 补丁在正式工作台同 revision 重读', async ({ page, workspace }, info) => {
  await place(page, '正文补丁验收');
  const initial = await workspace.state();
  const card = initial.cards[0]!;
  const blockId = card.body.blocks[0]!.id;
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  await page.getByRole('textbox', { name: '卡片正文', exact: true }).click();
  await page.keyboard.insertText('原有😀正文');
  await expect.poll(async () => (await workspace.state()).cards[0]!.body.blocks[0]?.text).toBe('原有😀正文');
  const prepared = await workspace.state();
  const paragraph = prepared.cards[0]!.body.blocks[0]!;
  expect(paragraph).toMatchObject({ id: blockId, inlineId: expect.any(String) });
  const commandId = crypto.randomUUID(), expected = prepared.cards[0]!.body.versionId;
  const range = { start: 0, end: 2 }, text = '补丁结果';
  const temp = mkdtempSync(join(tmpdir(), 'forkwise-body-ui-'));
  try {
    const tokenFile = join(temp, 'grant');
    const issued = spawnSync(process.execPath, [
      '--import', 'tsx', 'scripts/issue-body-grant.ts',
      '--data-dir', workspace.directory, '--project', initial.project.id,
      '--card', card.id, '--block', blockId, '--version', expected,
      '--start', String(range.start), '--end', String(range.end), '--out', tokenFile,
    ], { cwd: resolve('../backend'), encoding: 'utf8', timeout: 20_000 });
    expect(issued.status, issued.error?.message ?? issued.stderr).toBe(0);
    expect(issued.stdout.trim()).toMatch(/^[0-9a-f]{12}$/);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenFile, 'utf8').trim();
    const response = await fetch(workspace.origin + '/api/mapping/execute', {
      method: 'POST',
      headers: {
        Origin: workspace.origin, 'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        type: 'body.patch', projectId: initial.project.id, commandId, expected,
        payload: { id: card.id, blockId, range, text },
      }),
    });
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt.revision).toBe(prepared.project.revision + 1);
    await page.goto('about:blank');
    await workspace.restart();
    const client = new Client({ name: 'body-patch-ui-stdio', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: ['--import', 'tsx', 'src/mcp.ts'], cwd: resolve('../backend'),
      env: { FORKWISE_URL: workspace.origin, FORKWISE_AGENT_TOKEN: token }, stderr: 'pipe',
    });
    let mcpReplayRevision: number;
    try {
      await client.connect(transport);
      const replay = await client.callTool({
        name: 'forkwise_patch_card_body',
        arguments: { projectId: initial.project.id, commandId, expected, cardId: card.id, blockId, range, text },
      });
      expect(replay.structuredContent).toEqual({ response: receipt });
      mcpReplayRevision = (replay.structuredContent!.response as { revision: number }).revision;
    } finally {
      await client.close();
    }
    const reading = page.waitForResponse(result => {
      const url = new URL(result.url());
      return url.pathname === `/api/mapping/projects/${initial.project.id}/map` &&
        url.searchParams.get('view') === 'index' && result.status() === 200;
    });
    await workspace.open(page);
    const readRevision = (await (await reading).json()).revision;
    expect(readRevision).toBe(receipt.revision);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(receipt.revision));
    await page.getByText('正文补丁验收', { exact: true }).click();
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '卡片正文', exact: true })).toContainText('补丁结果😀正文');
    expect((await workspace.state()).cards[0]!.body.blocks[0]).toEqual({ ...paragraph, text: '补丁结果😀正文' });
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(receipt.revision));
    await page.screenshot({ path: info.outputPath('body-patch-reopened.png') });
    writeFileSync(info.outputPath('body-patch-ui-revision.json'), JSON.stringify({
      projectId: initial.project.id,
      commandId: receipt.commandId,
      receiptRevision: receipt.revision,
      mcpReplayRevision,
      readRevision,
      domRevision: Number(await page.locator('.workspace').getAttribute('data-revision')),
      text: '补丁结果😀正文',
    }) + '\n', { mode: 0o600 });
  } finally {
    rmSync(temp, { recursive: true });
  }
});
