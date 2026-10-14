import { test, expect, place } from './writing-board-fixture';
import { openMapping } from '../../backend/src/mapping/storage';

test('真实撤销会话撤下画布和写字板，保留原卡与完整草稿，不伪造删除或恢复入口', async ({ page, workspace }, info) => {
  const commands: string[] = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/mapping/execute'))
      commands.push(request.postDataJSON().type);
  });
  await place(page, '权限保全原卡', 80, 120);
  await page.getByRole('button', { name: '编辑正文', exact: true }).click();
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  await editor.click();
  await page.keyboard.insertText('已保存的完整第一段');
  await editor.press('Enter');
  await page.keyboard.insertText('已保存的完整第二段');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), original = before.cards[0]!;
  expect(original.body.blocks.map(block => block.text)).toEqual([
    '已保存的完整第一段', '已保存的完整第二段',
  ]);
  await page.getByRole('button', { name: '关闭正文', exact: true }).click();
  await expect(page.locator('.body-editor')).toHaveCount(0);
  await page.getByRole('button', { name: '写字板', exact: true }).click();
  await expect(editor).toHaveText('已保存的完整第一段已保存的完整第二段');
  await expect(editor).not.toBeFocused();

  // A separate scoped witness reads the same real SQLite via Mapping after
  // the browser's session is revoked; it cannot restore browser authority.
  const host = openMapping(workspace.directory);
  let witnessHash: string | undefined;
  try {
    const witnessToken = host.access.issue('human', [before.project.id]);
    const witness = host.access.authenticate(witnessToken);
    witnessHash = witness.tokenHash;
    await page.route('**/api/mapping/execute', route =>
      route.request().postDataJSON().type === 'body.edit'
        ? route.abort('failed') : route.continue());
    await editor.locator('[data-block-id]').last().click();
    await editor.press('End');
    await editor.press('Enter');
    await page.keyboard.insertText('未确认但必须保留的完整第三段');
    await expect(page.getByRole('status')).toHaveText('保存未完成');
    const lostAuthorization = page.waitForResponse(response =>
      response.url().includes('/api/mapping/') && response.status() === 401);
    workspace.revoke();
    const rejection = await lostAuthorization;
    expect(await rejection.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(page.getByText(
      '授权已失效，请从本机启动入口重新打开；未确认草稿已保留',
      { exact: true },
    )).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);

    const authoritative = host.read(
      { type: 'project', projectId: before.project.id }, witness,
    ).cards.find(card => card.id === original.id);
    expect(authoritative).toEqual(original);
    expect(commands).not.toContain('thought.delete');
    expect(commands).not.toContain('history.undo');
    expect(commands).not.toContain('history.redo');
    const recoveries = await page.evaluate(() => Object.keys(localStorage)
      .filter(key => key.startsWith('forkwise:recovery:v1:'))
      .map(key => JSON.parse(localStorage.getItem(key)!)));
    expect(recoveries.flatMap(entry => entry.drafts).some(draft =>
      draft.blocks?.map((block: { text: string }) => block.text).join('\n') ===
      '已保存的完整第一段\n已保存的完整第二段\n未确认但必须保留的完整第三段',
    )).toBe(true);
    await info.attach('permission-state', {
      contentType: 'application/json',
      body: JSON.stringify({ original, authoritative, commands, recoveries,
        unauthorized: { status: rejection.status(), url: rejection.url() },
        writingBoards: await page.locator('.body-editor').count(),
        deletedPanels: await page.getByLabel('已删除卡片', { exact: true }).count(),
        restoreButtons: await page.getByRole('button', { name: '撤销删除', exact: true }).count(),
      }, null, 2),
    });
    await page.screenshot({ path: info.outputPath('session-revoked.png') });
    await expect(page.getByLabel('已删除卡片', { exact: true })).toHaveCount(0);
    await expect(page.getByText('这张卡片已删除', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '撤销删除', exact: true })).toHaveCount(0);
    await expect(page.locator('.body-editor')).toHaveCount(0);
    await expect(editor).toHaveCount(0);
    const oldSessionRead = await page.request.get(workspace.origin + '/api/mapping/projects');
    expect(oldSessionRead.status()).toBe(401);
    expect(await oldSessionRead.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  } finally {
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      try {
        if (witnessHash) host.access.revoke(witnessHash);
      } finally { host.close(); }
    }
  }
});
