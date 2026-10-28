import { test, expect } from './writing-board-fixture';
import type { Command } from '../src/api';
import { zoom } from './group-gesture-fixture';
import { fiveMembers } from './group-selection-fixture';
import type { Page } from '@playwright/test';

async function textLines(page: Page, itemId: string) {
  return page.locator(`.react-flow__node[data-id="${itemId}"] .canvas-text-content`).evaluate(element => {
    const lines: { y: number; text: string }[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: globalThis.Node | null;
    while ((node = walker.nextNode())) for (let offset = 0; offset < (node.textContent?.length ?? 0); offset++) {
      const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
      const y = range.getBoundingClientRect().y, line = lines.find(value => Math.abs(value.y - y) < 1);
      if (line) line.text += node.textContent![offset]; else lines.push({ y, text: node.textContent![offset]! });
    }
    return lines.map(line => line.text);
  });
}

test('组合角点统一1.5x缩放Card和Shape，目标测量一次落盘且无补写layout', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'scale-card', title: '短卡', text: '', x: 100, y: 120 });
  await execute('shape.create', { id: 'scale-shape', content: { shapeType: 'ellipse', shortText: '缩放形状' }, pose: { x: 460, y: 200, width: 100, height: 60 } });
  const source = await workspace.state(), ids = [source.cards[0]!.item.id, source.shapes![0]!.item.id];
  await execute('group.create', { id: 'scale-group', itemIds: ids }, { groups: { 'scale-group': null }, containment: Object.fromEntries(ids.map(id => [id, null])) });
  const layout = page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === 'card.layout');
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('img', { name: '缩放形状', exact: true }).click();
  const before = await workspace.state(), commands: Command[] = [];
  page.on('request', r => { if (r.url().endsWith('/api/mapping/execute') && r.method() === 'POST') commands.push(r.postDataJSON()); });
  const handle = page.getByRole('button', { name: '调整组合尺寸：右下', exact: true });
  await expect(handle).toBeVisible(); const box = (await handle.boundingBox())!;
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('aria-label'),
    { x: box.x + box.width / 2, y: box.y + box.height / 2 })).toBe('调整组合尺寸：右下');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 230, box.y + box.height / 2 + 70);
  await page.mouse.up();
  await expect.poll(async () => (await workspace.state()).shapes![0]!.item.pose).toEqual({ x: 640, y: 240, width: 150, height: 90 });
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const after = await workspace.state();
  expect(after.cards[0]!.item.pose).toEqual({ x: 100, y: 120, width: 420, height: before.cards[0]!.item.pose.height * 1.5 });
  expect(after.cards[0]!.item.heightPolicy?.manualHeight).toBe(after.cards[0]!.item.pose.height);
  expect(after.project.revision).toBe(before.project.revision + 1);
  expect(commands.map(c => c.type)).toEqual(['group.scale']);
  expect(after.containment).toEqual(before.containment);
  await page.waitForTimeout(350);
  expect(commands.map(c => c.type)).toEqual(['group.scale']);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state()).toEqual(after);
  expect(commands.map(c => c.type)).toEqual(['group.scale']);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual(before.cards[0]!.item.pose);
  expect((await workspace.state()).cards[0]!.item.heightPolicy).toEqual(before.cards[0]!.item.heightPolicy);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual(after.cards[0]!.item.pose);
  expect((await workspace.state()).cards[0]!.item.heightPolicy).toEqual(after.cards[0]!.item.heightPolicy);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await page.waitForTimeout(350);
  expect((await workspace.state()).cards[0]!.item.pose).toEqual(after.cards[0]!.item.pose);
  expect(commands.map(c => c.type)).toEqual(['group.scale', 'history.undo', 'history.redo']);
});

for (const [smallerZoom, corner] of [[false, '左上'], [true, '左上'], [false, '右上'], [false, '左下'], [false, '右下']] as const)
test(`fractional多样式Text统一0.8x保逐行和自身固定角，最终Pose精确且零text.layout zoomSmall=${smallerZoom} corner=${corner}`, async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  for (const [id, x, y, width, fontSize] of [['a', 100, 140, 137.35, 19.7], ['b', 350, 180, 163.45, 23.4]] as const)
    await execute('text.create', { id, content: { runs: [{ text: '长文分行验证', bold: true }, { text: 'ABC\n第二段中文', color: '#123456' }],
      fontSize, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width }, pose: { x, y, width, height: 27 } });
  await execute('shape.create', { id: 'anchor', content: { shapeType: 'rectangle', shortText: '固定参照' }, pose: { x: 600, y: 120, width: 100, height: 200 } });
  const raw = await workspace.state(), ids = [...raw.texts!.map(t => t.item.id), raw.shapes![0]!.item.id];
  await execute('group.create', { id: 'text-group', itemIds: ids }, { groups: { 'text-group': null }, containment: Object.fromEntries(ids.map(id => [id, null])) });
  const layouts = ['a', 'b'].map(id => page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === 'text.layout' && r.request().postDataJSON()?.payload.id === id));
  await page.reload(); for (const response of layouts) expect((await response).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  if (smallerZoom) { await page.getByRole('button', { name: '缩小', exact: true }).click(); await expect.poll(() => zoom(page)).toBeLessThan(1); }
  await page.getByRole('img', { name: '固定参照', exact: true }).click();
  const before = await workspace.state(), originalLines = await Promise.all(before.texts!.map(t => textLines(page, t.item.id)));
  const commands: Command[] = [];
  page.on('request', r => { if (r.url().endsWith('/api/mapping/execute') && r.method() === 'POST') commands.push(r.postDataJSON()); });
  const left = corner.startsWith('左'), top = corner.endsWith('上'), anchor = { x: left ? 700 : 100, y: top ? 320 : 120 };
  const handle = page.getByRole('button', { name: `调整组合尺寸：${corner}`, exact: true }), box = (await handle.boundingBox())!, z = await zoom(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + (left ? 120 : -120) * z, box.y + box.height / 2 + (top ? 40 : -40) * z); await page.mouse.up();
  await expect.poll(() => commands.filter(c => c.type === 'group.scale').length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const after = await workspace.state();
  const scale = commands.find((c): c is Extract<Command, { type: 'group.scale' }> => c.type === 'group.scale')!.payload.scale;
  expect(scale).toBeCloseTo(0.8, 6);
  expect(after.shapes![0]!.item.pose.x).toBeCloseTo(anchor.x + scale * (600 - anchor.x), 10);
  for (let index = 0; index < before.texts!.length; index++) {
    const old = before.texts![index]!, value = after.texts![index]!, p = value.item.pose;
    expect(value.content.runs).toEqual(old.content.runs);
    expect(value.content.fontSize).toBe(old.content.fontSize * scale);
    expect(value.content.width).toBe(old.content.width * scale);
    expect(p.x + (left ? p.width : 0)).toBeCloseTo(anchor.x + scale * (old.item.pose.x + (left ? old.item.pose.width : 0) - anchor.x), 10);
    expect(p.y + (top ? p.height : 0)).toBeCloseTo(anchor.y + scale * (old.item.pose.y + (top ? old.item.pose.height : 0) - anchor.y), 10);
    expect(await textLines(page, value.item.id)).toEqual(originalLines[index]);
    const rendered = (await page.locator(`.react-flow__node[data-id="${value.item.id}"] .canvas-text`).boundingBox())!;
    expect(Math.abs(rendered.width / z - p.width)).toBeLessThan(0.01);
    expect(Math.abs(rendered.height / z - p.height)).toBeLessThan(0.01);
  }
  await page.waitForTimeout(350); expect(commands.map(c => c.type)).toEqual(['group.scale']);
  expect(after.project.revision).toBe(before.project.revision + 1);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(await workspace.state()).toEqual(after); expect(commands.map(c => c.type)).toEqual(['group.scale']);
});

test('两Card共同可行缩放下界来自目标宽度真实标题标签，保实测可行端点且最终复测', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  for (const [id, title, y] of [['long', '标题需要完整显示与换行'.repeat(16), 120], ['short', '第二张短卡', 400]] as const)
    await execute('thought.create', { id, title, text: '', x: 100, y });
  const layouts = ['long', 'short'].map(id => page.waitForResponse(r => r.url().endsWith('/api/mapping/execute') && r.request().postDataJSON()?.type === 'card.layout' && r.request().postDataJSON()?.payload.id === id));
  await page.reload(); for (const response of layouts) expect((await response).status()).toBe(200);
  const initial = await workspace.state();
  await execute('pose.batch', { poses: initial.cards.map(v => ({ id: v.id, ...v.item.pose, width: 560, height: v.id === 'long' ? 300 : 180 })) }, Object.fromEntries(initial.cards.map(v => [v.id, v.item.versionId])));
  await execute('tag.create', { id: 'tag', name: '可见标签' });
  await execute('card.tags', { id: 'long', tagIds: ['tag'] }, null);
  const fresh = await workspace.state();
  await execute('group.create', { id: 'cards', itemIds: fresh.cards.map(v => v.item.id) }, { groups: { cards: null }, containment: Object.fromEntries(fresh.cards.map(v => [v.item.id, null])) });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(page.locator('.card-visible-tags').getByText('可见标签', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '第二张短卡', exact: true }).click();
  const before = await workspace.state(), commands: Command[] = [];
  page.on('request', r => { if (r.url().endsWith('/api/mapping/execute') && r.method() === 'POST') commands.push(r.postDataJSON()); });
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
    const observed: { width: number; height: number; targetWidth: number }[] = [];
    (window as typeof window & { groupMeasures: typeof observed }).groupMeasures = observed;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { ...original, get() {
      const height = original.get!.call(this) as number;
      if (this.matches('.title-button') && this.textContent.length > 100 && this.closest('[data-group-measurement]')) observed.push({ width: this.parentElement.getBoundingClientRect().width, height, targetWidth: parseFloat(this.parentElement.style.width) });
      return height;
    } });
  });
  const handle = page.getByRole('button', { name: '调整组合尺寸：右下', exact: true }), box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 280, box.y + box.height / 2 - 230); await page.mouse.up();
  await expect.poll(() => commands.some(c => c.type === 'group.scale')).toBe(true);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const after = await workspace.state(), command = commands[0] as Extract<Command, { type: 'group.scale' }>, s = command.payload.scale;
  expect(s).toBeGreaterThan(0.5); expect(s).toBeLessThanOrEqual(1);
  for (const card of after.cards) {
    const old = before.cards.find(v => v.id === card.id)!;
    expect(card.item.pose.width).toBe(old.item.pose.width * s); expect(card.item.pose.height).toBe(old.item.pose.height * s);
    const visible = page.locator(`.react-flow__node[data-id="${card.item.id}"] .thought-card`);
    const necessary = await visible.evaluate(el => { const style = getComputedStyle(el); return Math.ceil((el.querySelector('.title-button') as HTMLElement).offsetHeight + ((el.querySelector('.card-visible-tags') as HTMLElement)?.offsetHeight ?? 0) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)); });
    expect(card.item.heightPolicy!.necessaryHeight).toBe(necessary); expect(card.item.pose.height).toBeGreaterThanOrEqual(necessary);
  }
  const samples = await page.evaluate(() => (window as typeof window & { groupMeasures: { width: number; height: number; targetWidth: number }[] }).groupMeasures);
  expect(samples[0]!.width).toBe(560); expect(samples[2]!.width).toBe(280);
  expect(samples.length / 2).toBeLessThanOrEqual(24);
  expect(samples.slice(0, -2)).toContainEqual(samples.at(-1)!);
  expect(samples.at(-1)!.width).toBeCloseTo(after.cards[0]!.item.pose.width, 1);
  const long = before.cards.find(v => v.id === 'long')!, short = before.cards.find(v => v.id === 'short')!;
  const overhead = command.payload.measurements.cards[long.item.id]!.necessaryHeight - samples.at(-1)!.height;
  let lower = 0.5, upper = 1;
  for (const sample of samples.filter((_, index) => index % 2 === 0).slice(3, -1)) {
    const scale = (lower + upper) / 2;
    const canonicalWidth = await page.evaluate(width => {
      const probe = document.createElement('div'); probe.style.width = `${width}px`;
      return parseFloat(probe.style.width);
    }, scale * long.item.pose.width);
    expect(sample.targetWidth).toBe(canonicalWidth);
    if (long.item.pose.height * scale >= sample.height + overhead && short.item.pose.height * scale >= command.payload.measurements.cards[short.item.id]!.necessaryHeight) upper = scale;
    else lower = scale;
  }
  expect(s).toBe(upper); expect(s).toBeLessThan(1);
  expect((upper - lower) * Math.max(before.groups![0]!.bounds.width, before.groups![0]!.bounds.height) * await zoom(page)).toBeLessThanOrEqual(0.5);
  await expect(page.locator('[data-group-measurement]')).toHaveCount(0);
  await page.waitForTimeout(350); expect(commands.map(c => c.type)).toEqual(['group.scale']);
});

for (const mode of ['cancel', 'noop', 'nonpositive', 'budget', 'initial-budget', 'unstable', 'mixed', 'drag-wait'] as const)
  test(`组合缩放${mode}清理真实测量DOM且尾up不改版本历史`, async ({ page, workspace }) => {
    const f = await fiveMembers(page, workspace), state = await workspace.state(), stroke = state.strokes![0]!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: state.project.id, type: 'group.remove-member',
      expected: { group: state.groups![0]!.versionId, containment: state.containment!.find(v => v.id === stroke.item.id)!.versionId },
      payload: { id: 'selection-group', itemId: stroke.item.id } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await f.visuals.shape.click();
    const before = await workspace.state(), commands: Command[] = [];
    const history = await (await page.request.get(workspace.origin + `/api/mapping/projects/${state.project.id}/history`)).json();
    page.on('request', r => { if (r.url().endsWith('/api/mapping/execute') && r.method() === 'POST') commands.push(r.postDataJSON()); });
    if (mode === 'budget' || mode === 'initial-budget' || mode === 'unstable') await page.evaluate(mode => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
      let samples = 0;
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { ...original, get() {
        const height = original.get!.call(this) as number;
        if (!this.matches('.title-button') || !this.closest('[data-group-measurement]')) return height;
        samples++;
        if (mode === 'budget' && samples === 3 || mode === 'initial-budget' && samples === 1) {
          const started = performance.now(); while (performance.now() - started < 510) { /* real measurement delay */ }
          (window as typeof window & { groupDelayedSample: number }).groupDelayedSample = performance.now() - started;
        }
        return height + (mode === 'unstable' && samples >= 5 ? 1 : 0);
      } });
    }, mode);
    const handle = page.getByRole('button', { name: '调整组合尺寸：右下', exact: true }), box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    if (mode !== 'initial-budget') await expect(page.locator('[data-group-measurement]')).toHaveCount(1);
    if (mode === 'drag-wait') await page.waitForTimeout(600);
    if (mode !== 'noop') await page.mouse.move(box.x + box.width / 2 + (mode === 'nonpositive' ? -850 : 78), box.y + box.height / 2 + (mode === 'nonpositive' ? -500 : 42));
    if (mode === 'cancel') await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(page.locator('[data-group-measurement]')).toHaveCount(0);
    if (mode === 'mixed' || mode === 'drag-wait') {
      await expect(page.getByRole('status')).toHaveText('已保存到本机');
      const after = await workspace.state(), scale = (commands[0] as Extract<Command, { type: 'group.scale' }>).payload.scale;
      expect(scale).toBe(1.1);
      for (const key of ['cards', 'texts', 'shapes', 'images'] as const) {
        const old = before[key]![0]!, value = after[key]![0]!;
        expect(value.item.pose.x).toBeCloseTo(100 + scale * (old.item.pose.x - 100), 10);
        expect(value.item.pose.y).toBeCloseTo(120 + scale * (old.item.pose.y - 120), 10);
        expect(Math.abs(value.item.pose.width - old.item.pose.width * scale)).toBeLessThan(0.01);
      }
      expect(after.project.revision).toBe(before.project.revision + 1); expect(after.strokes).toEqual(before.strokes);
      await page.waitForTimeout(350); expect(commands.map(c => c.type)).toEqual(['group.scale']); return;
    }
    await page.waitForTimeout(350);
    expect(commands).toEqual([]); expect(await workspace.state()).toEqual(before);
    if (mode === 'budget' || mode === 'initial-budget') {
      expect(await page.evaluate(() => (window as typeof window & { groupDelayedSample: number }).groupDelayedSample)).toBeGreaterThanOrEqual(500);
      await expect(page.getByRole('alert')).toContainText('测量超时');
    }
    if (mode === 'unstable') await expect(page.getByRole('alert')).toContainText('测量不稳定');
    expect(await (await page.request.get(workspace.origin + `/api/mapping/projects/${state.project.id}/history`)).json()).toEqual(history);
    await expect(page.locator('.canvas-group-outline[data-selected="true"]')).toHaveCount(1);
  });

test('含Stroke整体scale rotate不可用但真实整体移动仍一次保存', async ({ page, workspace }) => {
  const f = await fiveMembers(page, workspace), commands: Command[] = [];
  await f.visuals.shape.click();
  await expect(page.getByRole('button', { name: /^调整组合尺寸/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^组合[左右]转90/ })).toHaveCount(0);
  await expect(page.getByText('含笔迹，暂仅支持整体移动', { exact: true })).toBeVisible();
  const before = await workspace.state();
  page.on('request', r => { if (r.url().endsWith('/api/mapping/execute') && r.method() === 'POST') commands.push(r.postDataJSON()); });
  const box = (await f.visuals.shape.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2); await page.mouse.up();
  await expect.poll(() => commands.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(commands[0]!.type).toBe('canvas.move-selection');
  const after = await workspace.state();
  expect(after.strokes![0]!.item.pose.x).toBe(before.strokes![0]!.item.pose.x + 40);
  expect(after.images![0]!.item.pose.x).toBe(before.images![0]!.item.pose.x + 40);
});
