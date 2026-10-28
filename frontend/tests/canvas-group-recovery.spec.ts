import { test, expect } from './writing-board-fixture';
import { fiveMembers } from './group-selection-fixture';

for (const mode of ['group', 'selection'] as const) {
  test(`D261外部${mode}删除当前写字板Card，经同步保留删除态且只绑定确切undo栈顶`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await page.getByRole('button', { name: '编辑正文', exact: true }).click();
    const board = page.getByRole('complementary', { name: '写字板', exact: true });
    await expect(board.locator('small[title]')).toHaveAttribute('title', f.items.card.id);
    const before = await workspace.state(), card = before.cards[0]!, group = before.groups![0]!;
    const text = before.texts![0]!, shape = before.shapes![0]!, image = before.images![0]!, stroke = before.strokes![0]!;
    const items = { [card.item.id]: { kind: 'card', thought: card.versionId, body: card.body.versionId, pose: card.item.versionId,
      appearance: card.appearance?.versionId ?? null, cardTags: card.cardTags?.versionId ?? null },
      [text.item.id]: { kind: 'text', text: text.versionId, pose: text.item.versionId },
      [shape.item.id]: { kind: 'shape', shape: shape.versionId, pose: shape.item.versionId },
      [image.item.id]: { kind: 'image', image: image.versionId, pose: image.item.versionId },
      [stroke.item.id]: { kind: 'stroke', stroke: stroke.versionId, pose: stroke.item.versionId } };
    const containment = Object.fromEntries(before.containment!.map(v => [v.id, v.versionId]));
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId,
      type: mode === 'group' ? 'group.delete' : 'canvas.delete-selection',
      payload: mode === 'group' ? { id: group.id } : { groupIds: [group.id], directItemIds: [] },
      expected: { ...(mode === 'group' ? { group: group.versionId } : { groups: { [group.id]: group.versionId } }), containment, items, connectors: {} } });
    const deleted = await workspace.state(), timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
    expect(deleted.cards).toEqual([]); expect(timeline.revision).toBe(deleted.project.revision);
    expect(timeline.undo.at(-1).deletedCardIds).toEqual([card.id]);
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(deleted.project.revision));
    await expect(board).toBeVisible(); await expect(board.locator('small[title]')).toHaveAttribute('title', card.id);
    await expect(board.getByText('这张卡片已删除', { exact: true })).toBeVisible();
    await expect(page.getByLabel('卡片正文', { exact: true })).toContainText('组合正文保持');
    const restore = board.getByRole('button', { name: '撤销删除', exact: true });
    await expect(restore).toBeEnabled();
    const requests: any[] = [];
    page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
    await restore.click(); await expect.poll(async () => (await workspace.state()).cards.length).toBe(1);
    await expect(board.getByText('这张卡片已删除', { exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ type: 'history.undo', expected: timeline.revision, payload: { actionId: timeline.undo.at(-1).id } });
    expect((await workspace.state()).groups![0]!.memberItemIds).toEqual(group.memberItemIds);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(0);
    await expect(restore).toBeEnabled();
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'tag.create', expected: null, payload: { id: 'later-tag', name: '后续动作' } });
    const later = await workspace.state();
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(later.project.revision));
    await expect(restore).toBeDisabled(); await expect(board.locator('small[title]')).toHaveAttribute('title', card.id);
    expect((await workspace.state()).cards).toEqual([]);
  });
}

for (const mode of ['unknown', 'confirmed-read-failure', 'rejected-read-failure'] as const) {
  test(`结构owner ${mode}保原请求与结果路线，重试不重授权且成功只完成一次`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await f.visuals.shape.click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    const before = await workspace.state(), group = before.groups![0]!, attempts: any[] = [], reads: number[] = [];
    const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
    let applied = false, failRead = mode !== 'unknown';
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'group.ungroup') { await route.continue(); return; }
      if (mode === 'rejected-read-failure' && attempts.length === 0) {
        const membership = before.containment!.find(v => v.id === f.items.stroke.item.id)!;
        await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.remove-member',
          expected: { group: group.versionId, containment: membership.versionId }, payload: { id: group.id, itemId: membership.id } });
      }
      const response = await route.fetch();
      attempts.push({ command, status: response.status(), body: await response.json() }); applied = true;
      if (mode === 'unknown' && attempts.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
      if (!applied || new URL(route.request().url()).searchParams.get('view') !== 'index') { await route.continue(); return; }
      const response = await route.fetch(); reads.push(response.status());
      if (failRead) { failRead = false; await route.abort('connectionreset'); }
      else await route.fulfill({ response });
    });
    try {
      await page.getByRole('button', { name: '取消组合', exact: true }).click();
      const retry = page.getByRole('button', { name: '重试保存', exact: true });
      await expect(retry).toBeVisible(); expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ status: mode === 'rejected-read-failure' ? 409 : 200,
        command: { type: 'group.ungroup', projectId, payload: { id: group.id }, expected: { group: group.versionId,
          containment: Object.fromEntries(before.containment!.map(v => [v.id, v.versionId])) } } });
      const committed = await workspace.state(), committedHistory = await (await page.request.get(historyUrl)).json();
      expect(committed.project.revision).toBe(before.project.revision + 1);
      expect(committedHistory.undo).toHaveLength(f.timeline.undo.length + 1);
      if (mode === 'unknown') {
        await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(committed.project.revision));
      }
      await retry.click();
      if (mode === 'rejected-read-failure') {
        await expect(page.getByRole('button', { name: '放弃本次组合操作', exact: true })).toBeVisible();
        await expect.poll(() => reads.length).toBeGreaterThan(0);
        if (reads.length === 1) await retry.click();
        await expect.poll(() => reads.length).toBeGreaterThan(1);
        expect(attempts).toHaveLength(1);
        await page.getByRole('button', { name: '放弃本次组合操作', exact: true }).click();
        await expect(retry).toHaveCount(0);
        await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toHaveCount(0);
      } else {
        await expect(retry).toHaveCount(0);
        expect(attempts).toHaveLength(mode === 'unknown' ? 2 : 1);
        if (mode === 'unknown') expect(attempts[1]).toEqual(attempts[0]);
        await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
        await expect(page.getByRole('button', { name: '组合所选对象', exact: true })).toBeVisible();
      }
      expect(await workspace.state()).toEqual(committed);
      expect(await (await page.request.get(historyUrl)).json()).toEqual(committedHistory);
      console.log('ISSUE28_STRUCTURE_RECOVERY', JSON.stringify({ mode, attempts, reads, committedHistory }));
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('结构owner未知ACK后真实改选loose Card，原请求重试完成不抢新选择', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'thought.create', expected: null,
    payload: { id: 'pending-choice-b', title: '后选卡B', text: '乙正文保持', x: 1020, y: 580 } });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
    response.request().postDataJSON()?.type === 'card.layout' && response.request().postDataJSON()?.payload.id === 'pending-choice-b');
  await page.reload(); expect((await layout).status()).toBe(200); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), card = before.cards.find(value => value.id === 'pending-choice-b')!;
  expect(before.containment!.some(value => value.id === card.item.id)).toBe(false);
  const historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
  const timeline = await (await page.request.get(historyUrl)).json(), attempts: any[] = [];
  await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'group.ungroup') { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); attempts.push(command);
    if (attempts.length === 1) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '取消组合', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible();
    const visual = page.getByRole('button', { name: '后选卡B', exact: true }); await expect(visual).toBeEnabled();
    const box = (await visual.boundingBox())!, point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(await page.evaluate(p => document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('.react-flow__node')?.dataset.id, point)).toBe(card.item.id);
    await visual.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + card.item.id + '"]')).toHaveClass(/selected/);
    const committed = await workspace.state(), committedHistory = await (await page.request.get(historyUrl)).json();
    expect(committed.groups).toEqual([]); expect(committed.project.revision).toBe(before.project.revision + 1);
    expect(committedHistory.undo).toHaveLength(timeline.undo.length + 1);
    await retry.click(); await expect(retry).toHaveCount(0); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.locator('.react-flow__node[data-id="' + card.item.id + '"]')).toHaveClass(/selected/);
    expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(committedHistory);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('成员Card菜单真实按钮持焦点时Delete不穿透删除背景成员或Group', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace);
  await f.visuals.card.click(); await f.visuals.card.click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  await page.getByRole('button', { name: '更多', exact: true }).click();
  const menu = page.getByRole('dialog', { name: '更多', exact: true }), remove = menu.getByRole('button', { name: '删除卡片', exact: true });
  await expect(menu).toBeVisible(); await remove.focus(); await expect(remove).toBeFocused();
  const before = await workspace.state(), requests: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') requests.push(request.postDataJSON()); });
  await page.keyboard.press('Delete');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(menu).toBeVisible(); await expect(remove).toBeFocused();
  expect(await workspace.state()).toEqual(before); expect(requests).toEqual([]);
  const timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + before.project.id + '/history')).json();
  expect(timeline).toEqual(f.timeline);
});

for (const mode of ['unknown', 'confirmed-read-failure'] as const) {
  test(`移动队列${mode}保完整move-selection请求，确认成功后重试只补读`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
    await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
    const before = await workspace.state(), attempts: any[] = [];
    let applied = false, failRead = mode === 'confirmed-read-failure';
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'canvas.move-selection') { await route.continue(); return; }
      const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() });
      applied = true;
      if (mode === 'unknown' && attempts.length === 1) await route.abort('connectionreset');
      else await route.fulfill({ response });
    });
    await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
      if (!applied || !failRead || new URL(route.request().url()).searchParams.get('view') !== 'index') { await route.continue(); return; }
      failRead = false; const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('connectionreset');
    });
    let pressed = false;
    try {
      const box = (await f.visuals.shape.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down(); pressed = true; await page.mouse.move(x + 40, y + 20, { steps: 4 });
      for (const value of Object.values(f.items)) {
        const node = page.locator('.react-flow__node[data-id="' + value.item.id + '"]');
        await expect.poll(() => node.evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return [m.e, m.f]; })).toEqual([value.item.pose.x + 40, value.item.pose.y + 20]);
      }
      expect(attempts).toEqual([]); expect(await workspace.state()).toEqual(before);
      await page.mouse.up(); pressed = false;
      const retry = page.getByRole('button', { name: /^重试(画布|文字)保存$/ });
      await expect(retry).toBeVisible(); expect(attempts).toHaveLength(1); expect(attempts[0].status).toBe(200);
      expect(attempts[0].command).toMatchObject({ type: 'canvas.move-selection', projectId,
        payload: { groupIds: ['selection-group'], directItemIds: [], dx: 40, dy: 20 },
        expected: { groups: { 'selection-group': before.groups![0]!.versionId },
          containment: Object.fromEntries(before.containment!.map(v => [v.id, v.versionId])),
          poses: Object.fromEntries([...before.cards, ...before.texts!, ...before.shapes!, ...before.images!, ...before.strokes!].map(v => [v.item.id, v.item.versionId])) } });
      const committed = await workspace.state(), historyUrl = workspace.origin + '/api/mapping/projects/' + projectId + '/history';
      const timeline = await (await page.request.get(historyUrl)).json();
      expect(committed.project.revision).toBe(before.project.revision + 1); expect(timeline.undo).toHaveLength(f.timeline.undo.length + 1);
      expect(committed.containment).toEqual(before.containment);
      expect(committed.groups![0]).toMatchObject({ ...before.groups![0], bounds: { ...before.groups![0]!.bounds, x: before.groups![0]!.bounds.x + 40, y: before.groups![0]!.bounds.y + 20 } });
      for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes'] as const) {
        const origin = before[key]![0]!, saved = committed[key]![0]!;
        expect(saved).toEqual({ ...origin, item: { ...origin.item, versionId: saved.item.versionId, pose: { ...origin.item.pose, x: origin.item.pose.x + 40, y: origin.item.pose.y + 20 } } });
        expect(saved.item.versionId).not.toBe(origin.item.versionId);
      }
      await retry.click(); await expect(retry).toHaveCount(0);
      expect(attempts).toHaveLength(mode === 'unknown' ? 2 : 1);
      if (mode === 'unknown') expect(attempts[1]).toEqual(attempts[0]);
      expect(await workspace.state()).toEqual(committed); expect(await (await page.request.get(historyUrl)).json()).toEqual(timeline);
      await expect(page.locator('.canvas-group-outline')).toHaveAttribute('data-selected', 'true');
      console.log('ISSUE28_QUEUE_RECOVERY', JSON.stringify({ mode, attempts, timeline }));
    } finally { if (pressed) await page.mouse.up(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}

test('移动队列真实409先保五类原意图，比较读取失败只重读且不吸入新成员', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  const before = await workspace.state(), group = before.groups![0]!, attempts: any[] = [], reads: number[] = [];
  let rejected = false, failRead = true;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'canvas.move-selection') { await route.continue(); return; }
    if (!attempts.length) {
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
        payload: { id: 'new-peer-member', content: { shapeType: 'rectangle', shortText: '新加入但不属原移动' }, pose: { x: 1020, y: 600, width: 100, height: 80 } } });
      const state = await workspace.state(), extra = state.shapes!.find(v => v.id === 'new-peer-member')!;
      expect(state.containment!.some(v => v.id === extra.item.id)).toBe(false);
      const members = [...group.memberItemIds, extra.item.id];
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'group.create',
        expected: { groups: { 'peer-regroup': null, [group.id]: group.versionId },
          containment: Object.fromEntries(members.map(id => [id, state.containment!.find(v => v.id === id)?.versionId ?? null])) },
        payload: { id: 'peer-regroup', itemIds: [group.itemId, extra.item.id] } });
      const regrouped = await workspace.state(); expect(regrouped.groups![0]!.memberItemIds).toEqual(members);
    }
    const response = await route.fetch(); attempts.push({ command, status: response.status(), body: await response.json() });
    rejected = response.status() === 409; await route.fulfill({ response });
  });
  await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
    if (!rejected || new URL(route.request().url()).searchParams.get('view') !== 'index') { await route.continue(); return; }
    const response = await route.fetch(); reads.push(response.status());
    if (failRead) { failRead = false; await route.abort('connectionreset'); } else await route.fulfill({ response });
  });
  let pressed = false;
  try {
    const box = (await f.visuals.shape.boundingBox())!, x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down(); pressed = true; await page.mouse.move(x + 40, y + 20, { steps: 4 });
    expect(attempts).toEqual([]); expect(await workspace.state()).toEqual(before);
    await page.mouse.up(); pressed = false;
    await expect.poll(() => rejected).toBe(true); expect(attempts).toHaveLength(1);
    expect(attempts[0].body.code).toBe('VERSION_CONFLICT');
    expect(attempts[0].command.payload).toEqual({ groupIds: [group.id], directItemIds: [], dx: 40, dy: 20 });
    expect(Object.keys(attempts[0].command.expected.poses).sort()).toEqual([...group.memberItemIds].sort());
    const panel = page.getByRole('region', { name: '混合移动保存冲突', exact: true });
    await expect(panel).toBeVisible(); await expect(panel.locator('tbody tr')).toHaveCount(5);
    await expect(panel.getByText('尚未读取', { exact: true })).toHaveCount(5);
    await expect(panel.getByText('对象已删除', { exact: true })).toHaveCount(0);
    const retry = page.getByRole('button', { name: /^重试(画布|文字)保存$/ });
    await expect(retry).toBeVisible(); await retry.click();
    await expect(panel.getByText('尚未读取', { exact: true })).toHaveCount(0);
    await expect(panel.locator('tbody tr')).toHaveCount(5); await expect(panel.getByText('笔迹 5', { exact: true })).toBeVisible();
    expect(attempts).toHaveLength(1); expect(reads.length).toBeGreaterThanOrEqual(2);
    const saved = await workspace.state(), timeline = await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json();
    expect(saved.groups![0]!.memberItemIds).toHaveLength(6); expect(saved.project.revision).toBe(before.project.revision + 2);
    expect(timeline.undo).toHaveLength(f.timeline.undo.length + 2);
    await panel.getByRole('button', { name: '放弃本次混合移动，保留已保存位置', exact: true }).click();
    await expect(panel).toHaveCount(0); expect(attempts).toHaveLength(1);
    expect(await workspace.state()).toEqual(saved);
    expect(await (await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history')).json()).toEqual(timeline);
  } finally { if (pressed) await page.mouse.up(); await page.unrouteAll({ behavior: 'wait' }); }
});


test('结构owner确认写入后补读失败先保项目A，补读完成才切换项目B且不迟到抢回', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), projectId = f.before.project.id;
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  await expect.poll(async () => {
    const id = await page.getByRole('tab', { selected: true }).getAttribute('title'); return !!id && id !== projectId;
  }).toBe(true);
  const otherId = (await page.getByRole('tab', { selected: true }).getAttribute('title'))!;
  expect(otherId).toBeTruthy(); expect(otherId).not.toBe(projectId);
  const tabA = page.locator('[role="tab"][title="' + projectId + '"]'), tabB = page.locator('[role="tab"][title="' + otherId + '"]');
  const readState = async (id: string) => {
    const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + id);
    expect(response.status()).toBe(200); return response.json();
  };
  const readHistory = async (id: string) => {
    const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + id + '/history');
    expect(response.status()).toBe(200); return response.json();
  };
  const other = await readState(otherId), otherHistory = await readHistory(otherId);
  await tabA.click(); await expect(tabA).toHaveAttribute('aria-selected', 'true');
  await f.visuals.shape.click(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(5);
  const before = await readState(projectId), timeline = await readHistory(projectId), group = before.groups[0];
  const attempts: any[] = [], reads: number[] = [];
  let applied = false, failRead = true;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'group.ungroup') { await route.continue(); return; }
    const response = await route.fetch(); attempts.push({ command, status: response.status() });
    applied = true; await route.fulfill({ response });
  });
  await page.route('**/api/mapping/projects/' + projectId + '/map?**', async route => {
    if (!applied || new URL(route.request().url()).searchParams.get('view') !== 'index') { await route.continue(); return; }
    const response = await route.fetch(); reads.push(response.status());
    if (failRead) await route.abort('connectionreset'); else await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '取消组合', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试保存', exact: true }); await expect(retry).toBeVisible();
    expect(attempts).toHaveLength(1); const failedReads = reads.length; expect(failedReads).toBeGreaterThan(0);
    expect(attempts[0]).toEqual({ status: 200, command: expect.objectContaining({ projectId, type: 'group.ungroup',
      expected: { group: group.versionId, containment: Object.fromEntries(before.containment.map((value: any) => [value.id, value.versionId])) }, payload: { id: group.id } }) });
    const committed = await readState(projectId), committedHistory = await readHistory(projectId);
    expect(committed.groups).toEqual([]); expect(committed.project.revision).toBe(before.project.revision + 1);
    expect(committedHistory.undo).toHaveLength(timeline.undo.length + 1); expect(committedHistory.undo.at(-1).label).toBe('group.ungroup');
    await tabB.click(); await expect(tabA).toHaveAttribute('aria-selected', 'true'); await expect(tabB).toHaveAttribute('aria-selected', 'false');
    expect(attempts).toHaveLength(1); await expect(retry).toBeVisible();
    expect(await readState(projectId)).toEqual(committed); expect(await readHistory(projectId)).toEqual(committedHistory);
    expect(await readState(otherId)).toEqual(other); expect(await readHistory(otherId)).toEqual(otherHistory);
    failRead = false; await retry.click(); await expect(retry).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.locator('.workspace')).toHaveAttribute('data-revision', String(committed.project.revision));
    expect(attempts).toHaveLength(1); expect(reads.length).toBeGreaterThan(failedReads);
    await tabB.click(); await expect(tabB).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(tabB).toHaveAttribute('aria-selected', 'true'); expect(attempts).toHaveLength(1);
    expect(await readState(projectId)).toEqual(committed); expect(await readHistory(projectId)).toEqual(committedHistory);
    expect(await readState(otherId)).toEqual(other); expect(await readHistory(otherId)).toEqual(otherHistory);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});
