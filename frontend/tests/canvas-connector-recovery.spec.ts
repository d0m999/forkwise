import { test, expect } from './writing-board-fixture';
import type { Request, Route } from '@playwright/test';
import type { Command, Receipt } from '../../backend/src/mapping/contracts';
import { connectorSurfaceBox, seedConnectorCard } from './connector-ui-fixture';

test('连线创建已提交丢ACK后原命令重试不重复建线', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'protected-card', 930, 90);
  const before = await workspace.state(), commands: Extract<Command, { type: 'connector.create' }>[] = [];
  const history = async () => (await page.request.get(workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history')).json();
  const initialHistory = await history(); let committedReceipt: Receipt | null = null;
  const route = async (request: Route) => {
    const command = request.request().postDataJSON() as Command;
    if (command.type !== 'connector.create') return request.continue();
    commands.push(command);
    if (commands.length === 1) {
      const response = await request.fetch(); expect(response.status()).toBe(200);
      committedReceipt = await response.json(); await request.abort('failed');
    } else await request.continue();
  };
  await page.route('**/api/mapping/execute', route);
  try {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    await page.mouse.move(280, 450); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 5 });
    await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
    expect(commands).toHaveLength(0); await page.mouse.up();
    await expect.poll(() => committedReceipt !== null).toBe(true); await expect(page.getByRole('alert')).toBeVisible();
    const committed = await workspace.state(), committedHistory = await history();
    expect(committed.connectors).toHaveLength(1); expect(commands).toHaveLength(1);
    expect(committed.connectors![0]!.id).toBe(commands[0]!.payload.id);
    expect(committedHistory.undo).toHaveLength(initialHistory.undo.length + 1);
    const retry = page.getByRole('button', { name: '重试保存连线', exact: true });
    expect(await retry.count(), '真实提交丢ACK后必须提供明确原命令重试入口').toBe(1);
    const confirmed = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await retry.click(); const response = await confirmed;
    expect(response.status()).toBe(200); expect(await response.json()).toEqual(committedReceipt);
    await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
    expect(await workspace.state()).toEqual(committed); expect(await history()).toEqual(committedHistory);
    expect(committed.cards).toEqual(before.cards);
    console.log('issue26-create-ack-loss', JSON.stringify({ commands, committedReceipt, committedHistory, connector: committed.connectors![0], injection: 'real execute200 followed only by aborted ACK; retry crosses real HTTP' }));
  } finally { await page.unroute('**/api/mapping/execute', route); }
});

test('连线恢复记录写入失败时不发送创建命令', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'journal-protected-card', 930, 90);
  const before = await workspace.state(), commands: Command[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history';
  const initialHistory = await (await page.request.get(historyUrl)).json();
  const observe = (request: Request) => {
    if (!request.url().endsWith('/api/mapping/execute')) return;
    const command = request.postDataJSON() as Command;
    if (command.type === 'connector.create') commands.push(command);
  };
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as any).__connectorJournalFault = { attempts: 0, restore: () => { Storage.prototype.setItem = original; } };
    Storage.prototype.setItem = function(key: string, value: string) {
      if (this === localStorage && key.startsWith('forkwise:connector-create-recovery:v1:')) {
        (window as any).__connectorJournalFault.attempts++;
        throw new DOMException('owned connector journal unavailable', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  page.on('request', observe);
  try {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    await page.mouse.move(280, 450); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 5 });
    await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
    expect(commands).toHaveLength(0); await page.mouse.up();
    await expect.poll(async () => (await page.evaluate(() => (window as any).__connectorJournalFault.attempts)) + commands.length).toBeGreaterThan(0);
    expect(commands, '恢复记录未可靠落盘时不得先发出创建命令').toHaveLength(0);
    const attempts = await page.evaluate(() => (window as any).__connectorJournalFault.attempts);
    expect(attempts).toBeGreaterThan(0); await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
    expect(await workspace.state()).toEqual(before);
    expect(await (await page.request.get(historyUrl)).json()).toEqual(initialHistory);
    console.log('issue26-create-journal-failure', JSON.stringify({ attempts, commands, before, initialHistory, injection: 'localStorage connector journal setItem only; no HTTP interception' }));
  } finally {
    page.off('request', observe);
    await page.evaluate(() => { (window as any).__connectorJournalFault.restore(); delete (window as any).__connectorJournalFault; });
  }
});

test('同库重开后明确恢复未确认连线的原命令', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'reopen-protected-card', 930, 90);
  const before = await workspace.state(), commands: Command[] = []; let receipt: Receipt | null = null;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history';
  const initialHistory = await (await page.request.get(historyUrl)).json();
  const route = async (request: Route) => {
    const command = request.request().postDataJSON() as Command;
    if (command.type !== 'connector.create') return request.continue();
    commands.push(command);
    if (commands.length === 1) {
      const response = await request.fetch(); expect(response.status()).toBe(200);
      receipt = await response.json(); await request.abort('failed');
    } else await request.continue();
  };
  await page.route('**/api/mapping/execute', route);
  try {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    const box = await connectorSurfaceBox(page, card.item.id);
    await page.mouse.move(box.x + box.width, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(650, 550, { steps: 5 }); await page.mouse.up();
    await expect.poll(() => receipt !== null).toBe(true); await expect(page.getByRole('alert')).toBeVisible();
    const committed = await workspace.state(), committedHistory = await (await page.request.get(historyUrl)).json();
    expect(committed.connectors).toHaveLength(1); expect(committedHistory.undo).toHaveLength(initialHistory.undo.length + 1);
    expect(committed.connectors![0]!.start).toEqual({ kind: 'bound', itemId: card.item.id, side: 'right' });
    await workspace.restart(); page.once('dialog', dialog => dialog.accept()); await page.reload();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(committed.project.revision));
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
    expect(commands).toHaveLength(1); expect(await workspace.state()).toEqual(committed);
    const recover = page.getByRole('button', { name: '恢复未确认连线', exact: true });
    expect(await recover.count(), '同库重开必须提供明确恢复入口，不能自动重发未确认请求').toBe(1);
    const response = page.waitForResponse(value => value.url().endsWith('/api/mapping/execute') && value.request().postDataJSON()?.type === 'connector.create');
    await recover.click(); expect((await response).status()).toBe(200); expect(await (await response).json()).toEqual(receipt);
    await expect(recover).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
    expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(committedHistory);
    console.log('issue26-create-reopen', JSON.stringify({ commands, receipt, committed, committedHistory, recovery: 'real same-database server restart, browser reload, explicit original-command HTTP retry' }));
  } finally { await page.unroute('**/api/mapping/execute', route); }
});

test('连线创建结果未知时后继图写入和撤销被阻止', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'unknown-protected-card', 930, 90);
  const before = await workspace.state(), commands: Command[] = []; let committed = false;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history';
  const route = async (request: Route) => {
    const command = request.request().postDataJSON() as Command; commands.push(command);
    if (command.type === 'connector.create' && !committed) {
      const response = await request.fetch(); expect(response.status()).toBe(200);
      committed = true; await request.abort('failed');
    } else await request.continue();
  };
  await page.route('**/api/mapping/execute', route);
  try {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    await page.mouse.move(280, 450); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 5 }); await page.mouse.up();
    await expect.poll(() => committed).toBe(true); await expect(page.getByRole('alert')).toBeVisible();
    const saved = await workspace.state(), savedHistory = await (await page.request.get(historyUrl)).json();
    expect(saved.connectors).toHaveLength(1); expect(commands).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
    const retry = page.getByRole('button', { name: '重试保存连线', exact: true }); expect(await retry.count()).toBe(1);
    for (const name of ['卡片', '连线', '文字', '形状', '画笔', '图片', '撤销', '重做', '新建研究'])
      expect(await page.getByRole('button', { name, exact: true }).isEnabled(), '未确认创建期间不得启用后继写入口：' + name).toBe(false);
    await page.keyboard.press('Meta+z'); await page.mouse.click(300, 620);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(commands).toHaveLength(1); expect(await workspace.state()).toEqual(saved);
    expect(await (await page.request.get(historyUrl)).json()).toEqual(savedHistory);
    const confirmation = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await retry.click(); expect((await confirmation).status()).toBe(200);
    await expect(page.getByRole('alert')).toHaveCount(0); expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
    expect(await workspace.state()).toEqual(saved); expect(await (await page.request.get(historyUrl)).json()).toEqual(savedHistory);
    console.log('issue26-create-unknown-gate', JSON.stringify({ commands, saved, savedHistory, escape: 'pending retained; actual later keyboard undo and canvas click caused zero additional requests' }));
  } finally { await page.unroute('**/api/mapping/execute', route); }
});

test('创建绑定目标被peer删除后真实拒绝，可明确放弃并重新操作', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'peer-deleted-target', 930, 90);
  const before = await workspace.state(), commands: Extract<Command, { type: 'connector.create' }>[] = [];
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history';
  let release = () => {}, rejection: { status: number; body: { code: string } } | null = null;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const route = async (request: Route) => {
    const command = request.request().postDataJSON() as Command;
    if (command.type !== 'connector.create') return request.continue();
    commands.push(command);
    if (commands.length !== 1) return request.continue();
    await gate; const response = await request.fetch();
    rejection = { status: response.status(), body: await response.json() }; await request.fulfill({ response });
  };
  await page.route('**/api/mapping/execute', route);
  try {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    const box = await connectorSurfaceBox(page, card.item.id);
    await page.mouse.move(box.x + box.width, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 5 }); await page.mouse.up();
    await expect.poll(() => commands.length).toBe(1);
    expect(commands[0]!.payload.start).toEqual({ kind: 'bound', itemId: card.item.id, side: 'right' });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: before.project.id, type: 'thought.delete',
      expected: { thought: card.versionId, body: card.body.versionId, pose: card.item.versionId, appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null, connectors: {} }, payload: { id: card.id } });
    const afterPeer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json(); release();
    await expect.poll(() => rejection !== null).toBe(true); await expect(page.getByRole('alert')).toBeVisible();
    expect(rejection).toMatchObject({ status: 400, body: { code: 'INVALID_ENDPOINT' } });
    expect(await workspace.state()).toEqual(afterPeer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    const abandon = page.getByRole('button', { name: '放弃本次连线', exact: true });
    expect(await abandon.count(), '真实明确拒绝后必须提供放弃原操作的出口').toBe(1); await abandon.click();
    await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '连线', exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await page.mouse.move(280, 450); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 5 }); await page.mouse.up(); expect((await saved).status()).toBe(200);
    await expect(page.getByRole('status')).toHaveText('已保存到本机'); const final = await workspace.state(), finalHistory = await (await page.request.get(historyUrl)).json();
    expect(commands).toHaveLength(2); expect(commands[1]!.commandId).not.toBe(commands[0]!.commandId); expect(final.connectors).toHaveLength(1);
    expect(final.cards).toEqual([]); expect(finalHistory.undo).toHaveLength(peerHistory.undo.length + 1);
    expect(finalHistory.undo.some((action: { id: string }) => action.id === commands[0]!.commandId)).toBe(false);
    console.log('issue26-create-known-refusal', JSON.stringify({ commands, rejection, afterPeer, peerHistory, final, finalHistory, gate: 'original browser request held; public peer deletion completes; real service refusal preserved' }));
  } finally { release(); await page.unroute('**/api/mapping/execute', route); }
});

test('创建已确认成功后回读失败，保原请求恢复且不重复创建', async ({ page, workspace }) => {
  await seedConnectorCard(page, workspace, 'read-failure-protected-card', 930, 90);
  const before = await workspace.state(), attempts: { command: Command; receipt: Receipt }[] = []; let readAborted = false;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(before.project.id) + '/history';
  const execute = async (request: Route) => {
    const command = request.request().postDataJSON() as Command;
    if (command.type !== 'connector.create') return request.continue();
    const response = await request.fetch(); expect(response.status()).toBe(200);
    attempts.push({ command, receipt: await response.json() }); await request.fulfill({ response });
  };
  const failRead = async (request: Route) => {
    if (attempts.length === 1 && !readAborted) { readAborted = true; await request.abort('failed'); }
    else await request.continue();
  };
  const journal = () => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('forkwise:connector-create-recovery:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)));
  await page.route('**/api/mapping/execute', execute);
  await page.route('**/api/mapping/projects/*/map?*', failRead);
  try {
    await page.getByRole('button', { name: '连线', exact: true }).click();
    await page.mouse.move(280, 450); await page.mouse.down(); await page.mouse.move(650, 550, { steps: 5 }); await page.mouse.up();
    await expect.poll(() => readAborted).toBe(true); await expect(page.getByRole('alert')).toBeVisible();
    expect(attempts).toHaveLength(1); const committed = await workspace.state(), committedHistory = await (await page.request.get(historyUrl)).json();
    expect(committed.connectors).toHaveLength(1); const line = committed.connectors![0]!;
    expect(line.id).toBe((attempts[0]!.command as Extract<Command, { type: 'connector.create' }>).payload.id);
    const retained = await journal(); expect(retained).toHaveLength(1); expect(retained[0].command).toEqual(attempts[0]!.command);
    expect(retained[0].receipt, '真实execute200之后必须保留成功receipt，回读失败不能退回未创建').toEqual(attempts[0]!.receipt);
    await expect(page.getByRole('alert')).toContainText('连线已保存'); expect(await page.getByRole('button', { name: '放弃本次连线', exact: true }).count()).toBe(0);
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: before.project.id, type: 'connector.delete', expected: line.versionId, payload: { id: line.id } });
    const afterPeer = await workspace.state(), peerHistory = await (await page.request.get(historyUrl)).json(); expect(afterPeer.connectors).toEqual([]);
    const confirmation = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.create');
    await page.getByRole('button', { name: '重试保存连线', exact: true }).click(); expect((await confirmation).status()).toBe(200);
    await expect(page.getByRole('alert')).toHaveCount(0); await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(afterPeer.project.revision));
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect(await journal()).toEqual([]);
    expect(await workspace.state()).toEqual(afterPeer); expect(await (await page.request.get(historyUrl)).json()).toEqual(peerHistory);
    expect(peerHistory.undo.filter((action: { label: string }) => action.label === 'connector.create')).toHaveLength(1);
    expect(afterPeer.cards).toEqual(before.cards);
    console.log('issue26-create-read-failure', JSON.stringify({ attempts, retained, committedHistory, afterPeer, peerHistory, injection: 'actual execute200 ACK delivered, only subsequent compact read aborted once; no success mock' }));
  } finally {
    await page.unroute('**/api/mapping/projects/*/map?*', failRead); await page.unroute('**/api/mapping/execute', execute);
  }
});
