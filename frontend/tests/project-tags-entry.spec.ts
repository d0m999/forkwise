import { test, expect, place } from './writing-board-fixture';

test('+N明确打开目标卡完整标签，不被旧选区覆盖，并保留组合输入和在途保存边界', async ({ page, workspace }) => {
  const names = ['完整保留但卡面需要省略的长标签名称'.repeat(6), 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', '甲独有'];
  await place(page, '入口甲', 70, 120); await place(page, '入口乙', 400, 180);
  const initial = await workspace.state(), projectId = initial.project.id;
  const ids = names.map((_, i) => `entry-tag-${i}`);
  for (const [i, name] of names.entries())
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'tag.create', expected: null, payload: { id: ids[i], name } });
  for (const [i, card] of initial.cards.entries())
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'card.tags', expected: null, payload: { id: card.id, tagIds: i === 0 ? ids : ids.slice(0, -1) } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const a = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '入口甲', exact: true }) });
  const b = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '入口乙', exact: true }) });
  const board = page.getByRole('complementary', { name: '写字板', exact: true });
  const editor = page.getByRole('textbox', { name: '卡片正文', exact: true });
  const open = async (title: string, tags: string[]) => {
    await expect.poll(async () => {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      return { title: await board.getByRole('heading').textContent(), owner: await board.locator('.board-identity small').textContent(), tags: await board.locator('.board-tags .project-tag').allTextContents() };
    }).toEqual({ title: `正在编辑：${title}`, owner: `卡片 ${initial.cards[title === '入口甲' ? 0 : 1]!.id}`, tags });
  };
  const clearSelection = () => page.locator('.react-flow__pane').click({ position: { x: 30, y: 500 } });

  await b.locator('.title-button').click(); await b.locator('.tag-overflow').click();
  await open('入口乙', names.slice(0, -1));
  const beforeReadOnly = await workspace.state();
  const contentHistory = async () => {
    const history = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
    return history.undo.filter((action: { label: string }) => action.label === 'body.edit' || action.label === 'card.tags' || action.label.startsWith('tag.'));
  };
  const historyBefore = await contentHistory();
  await a.locator('.tag-overflow').click();
  await open('入口甲', names);
  await expect(b).toHaveClass(/selected/);
  await expect(editor).not.toBeFocused();
  await b.locator('.title-button').click(); await open('入口乙', names.slice(0, -1));
  expect(await contentHistory()).toEqual(historyBefore);
  const afterReadOnly = await workspace.state();
  expect(afterReadOnly.tags).toEqual(beforeReadOnly.tags);
  expect(afterReadOnly.cards.map(card => ({ id: card.id, body: card.body, cardTags: card.cardTags }))).toEqual(beforeReadOnly.cards.map(card => ({ id: card.id, body: card.body, cardTags: card.cardTags })));

  await board.getByRole('button', { name: '关闭正文', exact: true }).click();
  await a.locator('.tag-overflow').click();
  await open('入口甲', names);
  await a.locator('.tag-overflow').click();
  await open('入口甲', names);

  await clearSelection(); await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await b.locator('.tag-overflow').click(); await open('入口乙', names.slice(0, -1));
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await a.locator('.title-button').click(); await b.locator('.title-button').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await a.locator('.tag-overflow').click(); await open('入口甲', names);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

  await clearSelection(); await b.locator('.title-button').click(); await open('入口乙', names.slice(0, -1));
  await editor.dispatchEvent('compositionstart');
  await a.locator('.tag-overflow').click(); await open('入口乙', names.slice(0, -1));
  await editor.dispatchEvent('compositionend');

  let arrived!: () => void, release!: () => void;
  const arrival = new Promise<void>(resolve => arrived = resolve), ack = new Promise<void>(resolve => release = resolve);
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'body.edit') return route.continue();
    const response = await route.fetch(); arrived(); await ack; await route.fulfill({ response });
  });
  try {
    await editor.fill('乙的保存仍绑定乙'); await arrival;
    await a.locator('.tag-overflow').click(); await open('入口乙', names.slice(0, -1));
    release(); await open('入口甲', names);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  const saved = await workspace.state();
  expect(saved.cards[0]!.cardTags!.tagIds).toEqual(ids);
  expect(saved.cards[1]!.cardTags!.tagIds).toEqual(ids.slice(0, -1));
  expect(saved.cards[0]!.body.blocks.map(block => block.text)).toEqual(['']);
  expect(saved.cards[1]!.body.blocks.map(block => block.text)).toEqual(['乙的保存仍绑定乙']);
});

for (const navigation of ['click', 'keyboard', 'empty', 'multi', 'marquee'] as const) {
  test(`正文ACK等待中的 +N 不覆盖较晚画布导航：${navigation}`, async ({ page, workspace }, info) => {
    await place(page, '迟到甲', 70, 120); await place(page, '迟到乙', 400, 180);
    const initial = await workspace.state(), projectId = initial.project.id;
    const [cardA, cardB] = initial.cards;
    const names = ['卡面省略但写字板完整显示的长标签'.repeat(6), 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', '甲独有'];
    const ids = names.map((_, i) => `late-tag-${i}`);
    for (const [i, name] of names.entries())
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'tag.create', expected: null, payload: { id: ids[i], name } });
    for (const [i, card] of initial.cards.entries())
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'card.tags', expected: null, payload: { id: card.id, tagIds: i === 0 ? ids : ids.slice(0, -1) } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const a = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '迟到甲', exact: true }) });
    const b = page.locator('.react-flow__node').filter({ has: page.getByRole('button', { name: '迟到乙', exact: true }) });
    const board = page.getByRole('complementary', { name: '写字板', exact: true });
    await b.locator('.title-button').click(); await b.locator('.tag-overflow').click();
    await expect(board.getByRole('heading')).toHaveText('正在编辑：迟到乙');
    const before = await workspace.state();
    const history = async () => (await (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json()).undo
      .filter((action: { label: string }) => action.label === 'body.edit' || action.label === 'card.tags' || action.label.startsWith('tag.'));
    const historyBefore = await history();
    let arrived!: () => void, release!: () => void, commandId = '';
    const arrival = new Promise<void>(resolve => arrived = resolve), ack = new Promise<void>(resolve => release = resolve);
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type !== 'body.edit') return route.continue();
      expect(command.payload.id).toBe(cardB!.id); commandId = command.commandId;
      const response = await route.fetch(); expect(response.status()).toBe(200);
      arrived(); await ack; await route.fulfill({ response });
    });
    const frames = (count: number) => board.evaluate(async (host, count) => {
      const result = [];
      for (let i = 0; i < count; i++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        result.push({ title: host.querySelector('h2')?.textContent, owner: host.querySelector('.board-identity small')?.textContent,
          tags: [...host.querySelectorAll('.board-tags .project-tag')].map(tag => tag.textContent),
          selected: [...document.querySelectorAll('.react-flow__node.selected')].map(node => node.getAttribute('data-id')).sort() });
      }
      return result;
    }, count);
    const selected = navigation === 'empty' ? [] : navigation === 'multi' ? [cardA!.item.id, cardB!.item.id].sort() : [cardB!.item.id];
    const expected = { title: '正在编辑：迟到乙', owner: `卡片 ${cardB!.id}`, tags: names.slice(0, -1), selected };
    try {
      await page.getByRole('textbox', { name: '卡片正文', exact: true }).fill('较晚导航期间仍只保存乙'); await arrival;
      await a.locator('.tag-overflow').click();
      if (navigation === 'keyboard') await b.locator('.title-button').press('Enter');
      else if (navigation === 'empty') await page.locator('.react-flow__pane').click({ position: { x: 30, y: 500 } });
      else if (navigation === 'multi') await a.locator('.title-button').click({ modifiers: ['Shift'] });
      else if (navigation === 'marquee') {
        const rect = (await b.boundingBox())!;
        await page.mouse.move(rect.x - 12, rect.y - 12); await page.mouse.down();
        await page.mouse.move(rect.x + rect.width + 12, rect.y + rect.height + 12, { steps: 8 }); await page.mouse.up();
      } else await b.locator('.title-button').click();
      const held = await frames(4); expect(held).toEqual(Array.from({ length: 4 }, () => expected));
      release(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
      const settled = await frames(12);
      await info.attach('actual-navigation-frames', { body: JSON.stringify({ navigation, held, settled }), contentType: 'application/json' });
      expect(settled).toEqual(Array.from({ length: 12 }, () => expected));
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
    const saved = await workspace.state(), actions = await history();
    expect(saved.cards[0]!.body).toEqual(before.cards[0]!.body);
    expect(saved.cards[1]!.body.blocks.map(block => block.text)).toEqual(['较晚导航期间仍只保存乙']);
    expect(saved.cards.map(card => card.cardTags)).toEqual(before.cards.map(card => card.cardTags));
    expect(saved.tags).toEqual(before.tags);
    expect(actions.slice(0, -1)).toEqual(historyBefore);
    expect(actions.at(-1)).toMatchObject({ id: commandId, label: 'body.edit', target: { id: cardB!.id } });
    expect(actions).toHaveLength(historyBefore.length + 1);
  });
}
