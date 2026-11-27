import { expect, place, test } from './writing-board-fixture';

for (const width of [1360, 760]) {
  test(`模拟整理在 ${width}px 审阅后显示完整候选，保留原卡与既有连线`, async ({ page, workspace }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await place(page, '供应链观察', width - 300, 140);
    const initial = await workspace.state();
    const source = initial.cards[0]!;
    const projectId = initial.project.id;
    const text = width === 760 ? '观察公开披露。' + '假设输入。'.repeat(3200) : '观察公开披露。';
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'body.edit',
      expected: source.body.versionId, payload: { id: source.id, blocks: [{ type: 'text', id: source.body.blocks[0]!.id, text }] } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create',
      expected: null, payload: { id: 'review-connector',
        start: { kind: 'bound', itemId: source.item.id, side: 'left' },
        end: { kind: 'free', point: { x: 150, y: 300 } } } });
    const originalTitle = page.getByRole('button', { name: '供应链观察', exact: true });
    await originalTitle.click();
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
    const before = await workspace.state();
    expect(before.connectors).toHaveLength(1);
    const trigger = page.getByRole('button', { name: 'AI', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'AI 整理', exact: true });
    await expect(dialog.getByText('当前卡片', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '用模型整理' })).toBeDisabled();
    await expect(dialog.getByText('模拟整理仅用于演示或测试。示例在本机生成。')).toBeVisible();
    await dialog.getByRole('checkbox', { name: /卡片标题/ }).check();
    await dialog.getByRole('checkbox', { name: '段落 1', exact: true }).check();
    await page.screenshot({ path: info.outputPath(`organize-input-${width}.png`) });
    const started = page.waitForResponse(response => response.url().endsWith('/organize/tasks') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '试用模拟整理' }).click();
    const task = await (await started).json();
    expect(task).toMatchObject({ mode: 'simulate', model: null, input: { title: '供应链观察',
      blocks: [{ id: source.body.blocks[0]!.id, text }] } });
    const expectedState = width === 760 ? '部分完成' : '可以审阅';
    await expect(dialog.getByRole('status')).toHaveText(`模拟整理 ${expectedState}`);
    if (width === 760) await expect(dialog.getByRole('region', { name: '资料缺口' })).toContainText('模拟结果达到文字上限');
    expect(await workspace.state()).toEqual(before);
    const viewport = page.locator('.react-flow__viewport');
    const beforeLayout = await viewport.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).toString());
    await page.screenshot({ path: info.outputPath(`organize-review-${width}.png`) });
    await dialog.getByRole('button', { name: '关闭 AI 整理' }).click();
    expect(await workspace.state()).toEqual(before);
    expect(await viewport.evaluate(element => new DOMMatrix(getComputedStyle(element).transform).toString())).toBe(beforeLayout);

    await page.getByRole('button', { name: '项目导航' }).click();
    await page.getByRole('button', { name: 'AI 整理记录', exact: true }).click();
    const records = page.getByRole('dialog', { name: 'AI 整理记录', exact: true });
    await expect(records.getByRole('option', { selected: true })).toHaveText(/模拟整理.*供应链观察/);
    await records.getByRole('button', { name: '添加为新卡' }).click();
    await expect(records.getByRole('status')).toContainText('已添加为新卡');
    await records.getByRole('button', { name: '关闭 AI 整理' }).click();
    const saved = await workspace.state();
    expect(saved.cards.filter(card => card.id !== source.id)).toHaveLength(1);
    expect(saved.cards.find(card => card.id === source.id)).toEqual(before.cards[0]);
    expect(saved.connectors).toEqual(before.connectors);
    const card = saved.cards.find(card => card.id !== source.id)!;
    expect(card.aiOrigin).toEqual({ taskId: task.id, mode: 'simulate' });
    const candidate = page.locator(`.react-flow__node[data-id="${card.item.id}"]`);
    await expect(candidate.locator('.card-ai-origin')).toHaveText('模拟整理');
    await expect(candidate).toBeInViewport({ ratio: 1 });
    const bounds = await candidate.boundingBox(), canvas = await page.locator('.canvas .react-flow').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(canvas!.x);
    expect(bounds!.y).toBeGreaterThanOrEqual(canvas!.y);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height);
    await page.screenshot({ path: info.outputPath(`organize-candidate-${width}.png`) });
    console.log('issue63-organize', JSON.stringify({ width, height: 900, fixture: '本机模拟整理',
      input: { title: task.input.title, textLength: text.length }, state: expectedState, bounds, canvas }));
  });
}
