import { test, expect, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { fiveMembers } from './group-selection-fixture';
import { history } from './group-gesture-fixture';
type Point = { x: number; y: number };

async function view(page: Page, itemId = '') {
  return page.evaluate(id => {
    const flow = document.querySelector('.react-flow')!, box = flow.getBoundingClientRect();
    const viewport = flow.querySelector('.react-flow__viewport')!;
    const api = (viewport as Element & { computedStyleMap?: () => { get(name: string): unknown } }).computedStyleMap;
    if (!api) throw new Error('Typed OM unavailable');
    const value = api.call(viewport).get('transform') as { toMatrix?: () => DOMMatrix };
    if (!value?.toMatrix) throw new Error('Typed OM matrix unavailable');
    const m = value.toMatrix();
    if (!Number.isFinite(m.a) || m.a <= 0 || m.a !== m.d || m.b || m.c) throw new Error('Unexpected viewport transform');
    const bounds = (el: Element | null) => { const b = el?.getBoundingClientRect(); return b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null; };
    return { left: box.left, top: box.top, width: box.width, height: box.height, z: m.a, tx: m.e, ty: m.f,
      rect: bounds(flow.querySelector('.react-flow__selection')),
      target: id ? bounds(flow.querySelector('.react-flow__node[data-id="' + CSS.escape(id) + '"]')) : null };
  }, itemId);
}
function screen(v: Awaited<ReturnType<typeof view>>, p: Point): Point {
  return { x: v.left + v.tx + p.x * v.z, y: v.top + v.ty + p.y * v.z };
}
async function selected(page: Page, ids: string[]) {
  await expect.poll(() => page.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!).sort())).toEqual([...ids].sort());
}
async function seed(page: Page, workspace: Workspace) {
  const group = await fiveMembers(page, workspace), projectId = group.before.project.id;
  for (const [id, text, y] of [['loose-a', '框选甲', 120], ['loose-b', '框选乙', 360]] as const)
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'shape.create', expected: null,
      payload: { id, content: { shapeType: 'rectangle', shortText: text }, pose: { x: 1020, y, width: 120, height: 80 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const a = page.getByRole('img', { name: '框选甲', exact: true }), b = page.getByRole('img', { name: '框选乙', exact: true });
  await expect(a).toBeVisible(); await expect(b).toBeVisible();
  const before = await workspace.state(), timeline = await history(page, workspace, projectId), commands: unknown[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  const aId = before.shapes!.find(value => value.id === 'loose-a')!.item.id, bId = before.shapes!.find(value => value.id === 'loose-b')!.item.id;
  expect(before.shapes!.filter(value => ['loose-a', 'loose-b'].includes(value.id)).map(value => value.item.pose)).toEqual([
    { x: 1020, y: 120, width: 120, height: 80 }, { x: 1020, y: 360, width: 120, height: 80 }]);
  return { ...group, before, timeline, commands, a, b, aId, bId };
}
async function unchanged(page: Page, workspace: Workspace, data: Awaited<ReturnType<typeof seed>>) {
  expect(data.commands).toEqual([]); expect(await workspace.state()).toEqual(data.before);
  expect(await history(page, workspace, data.before.project.id)).toEqual(data.timeline);
}

async function mouse(page: Page, shift = false) {
  const session = await page.context().newCDPSession(page), sessionId = crypto.randomUUID();
  const record = (event: string) => { const file = process.env.FORKWISE_ISSUE10_RESOURCE_LOG;
    if (file) appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), fixturePID: process.pid, event, sessionId }) + '\n'); };
  record('cdp-session-open');
  await page.evaluate(() => {
    const owner = window as typeof window & { marqueeTrace: any[]; removeMarqueeTrace: () => void };
    owner.marqueeTrace = [];
    const observe = (event: MouseEvent) => owner.marqueeTrace.push({ type: event.type, x: event.clientX, y: event.clientY,
      buttons: event.buttons, shift: event.shiftKey, trusted: event.isTrusted });
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mousemove', 'mouseup']) window.addEventListener(name, observe as EventListener, true);
    owner.removeMarqueeTrace = () => { for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mousemove', 'mouseup']) window.removeEventListener(name, observe as EventListener, true); };
  });
  let pressed = false, last: Point = { x: 0, y: 0 };
  const send = async (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', p: Point) => {
    last = p; await session.send('Input.dispatchMouseEvent', { type, ...p, button: type === 'mouseMoved' && !pressed ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' || pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: shift ? 8 : 0 });
  };
  if (shift) await page.keyboard.down('Shift');
  return {
    async down(p: Point) {
      expect(await page.evaluate(point => document.elementFromPoint(point.x, point.y)?.classList.contains('react-flow__pane'), p)).toBe(true);
      await send('mouseMoved', p); await send('mousePressed', p); pressed = true;
    },
    move: (p: Point) => send('mouseMoved', p),
    async up(p: Point) { await send('mouseReleased', p); pressed = false; },
    async trace(moves: number) {
      const events = await page.evaluate(() => (window as typeof window & { marqueeTrace: { type: string; x: number; y: number; buttons: number; shift: boolean; trusted: boolean }[] }).marqueeTrace);
      console.log('ISSUE28_MARQUEE_TRACE', JSON.stringify(events));
      expect(events.every(event => event.trusted)).toBe(true);
      expect(events.filter(event => event.type === 'mousemove' && event.buttons === 1)).toHaveLength(moves);
      expect(events.every(event => event.shift === shift)).toBe(true);
      return events;
    },
    async close() {
      try { if (pressed) await send('mouseReleased', last); }
      finally {
        try {
          console.log('ISSUE28_MARQUEE_FINAL_TRACE', JSON.stringify(await page.evaluate(() => (window as typeof window & { marqueeTrace: unknown[] }).marqueeTrace)));
          await page.evaluate(() => (window as typeof window & { removeMarqueeTrace: () => void }).removeMarqueeTrace());
          if (shift) await page.keyboard.up('Shift');
        } finally { await session.detach(); record('cdp-session-detached'); }
      }
    },
  };
}
async function rectangle(page: Page, from: Point, to: Point, shift = false, up = to) {
  const v = await view(page), input = await mouse(page, shift);
  try {
    await input.down(screen(v, from)); await input.move(screen(v, to)); await input.up(screen(v, up));
    const events = await input.trace(1), actualUp = events.filter(event => event.type === 'pointerup').at(-1)!;
    expect(actualUp.x).toBeCloseTo(screen(v, up).x, 4); expect(actualUp.y).toBeCloseTo(screen(v, up).y, 4);
  }
  finally { await input.close(); }
}
async function enter(page: Page, data: Awaited<ReturnType<typeof seed>>) {
  await data.visuals.shape.click(); await page.getByRole('button', { name: '进入组合', exact: true }).click(); await selected(page, []);
}

for (const both of [true, false]) {
  test(`旧looseA新框${both ? '完整A+B' : '仅B'}按本次全集替换`, async ({ page, workspace }) => {
    const data = await seed(page, workspace); await data.a.click(); await selected(page, [data.aId]);
    await rectangle(page, { x: 1000, y: both ? 100 : 340 }, { x: 1160, y: 460 });
    await selected(page, both ? [data.aId, data.bId] : [data.bId]); await unchanged(page, workspace, data);
  });
}
for (const full of [true, false]) {
  test(`旧Group新框${full ? '完整pose并集无需outlinePadding' : '部分成员不偷偷进入'}`, async ({ page, workspace }) => {
    const data = await seed(page, workspace); await data.visuals.shape.click(); await selected(page, Object.values(data.items).map(value => value.item.id));
    expect(data.before.groups![0]!.bounds).toEqual({ x: 100, y: 120, width: 780, height: 420 });
    await rectangle(page, full ? { x: 95, y: 115 } : { x: 435, y: 415 }, full ? { x: 885, y: 545 } : { x: 645, y: 445 });
    await selected(page, full ? Object.values(data.items).map(value => value.item.id) : []);
    await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', String(full));
    if (!full) { await data.visuals.shape.click(); await selected(page, Object.values(data.items).map(value => value.item.id)); }
    await unchanged(page, workspace, data);
  });
}
test('entered完整Stroke pose框选成员，内部小框不满足Full', async ({ page, workspace }) => {
  const data = await seed(page, workspace); await enter(page, data);
  await rectangle(page, { x: 435, y: 415 }, { x: 645, y: 445 }); await selected(page, [data.items.stroke.item.id]);
  await rectangle(page, { x: 445, y: 423 }, { x: 635, y: 437 }); await selected(page, []);
  await expect(page.getByRole('group', { name: '组合', exact: true })).toHaveAttribute('data-selected', 'false');
  await unchanged(page, workspace, data);
});
test('entered Shift追加及Esc取消恢复完整选择和上下文，尾随up无效', async ({ page, workspace }) => {
  const data = await seed(page, workspace); await enter(page, data); await data.visuals.text.click();
  await selected(page, [data.items.text.item.id]);
  await rectangle(page, { x: 435, y: 415 }, { x: 645, y: 445 }, true);
  const ids = [data.items.text.item.id, data.items.stroke.item.id]; await selected(page, ids);
  const v = await view(page), input = await mouse(page, true);
  try {
    await input.down(screen(v, { x: 715, y: 115 })); await input.move(screen(v, { x: 885, y: 225 }));
    await selected(page, [...ids, data.items.shape.item.id]);
    await page.keyboard.press('Escape'); await selected(page, ids);
    await input.move(screen(v, { x: 935, y: 275 })); await input.up(screen(v, { x: 935, y: 275 })); await input.trace(2);
  } finally { await input.close(); }
  await selected(page, ids); await data.visuals.image.click(); await selected(page, [data.items.image.item.id]);
  await unchanged(page, workspace, data);
});
test('缩小视图后仍以本次完整矩形选旧A和新B', async ({ page, workspace }) => {
  const data = await seed(page, workspace); await page.getByRole('button', { name: '缩小', exact: true }).click();
  expect((await view(page)).z).toBeLessThan(1); await data.a.click(); await selected(page, [data.aId]);
  await rectangle(page, { x: 1000, y: 100 }, { x: 1160, y: 460 }); await selected(page, [data.aId, data.bId]);
  await unchanged(page, workspace, data);
});
test('mouseup不同终点且无额外move，最终矩形包含A+B', async ({ page, workspace }) => {
  const data = await seed(page, workspace); await data.a.click(); await selected(page, [data.aId]);
  await rectangle(page, { x: 1000, y: 100 }, { x: 1160, y: 260 }, false, { x: 1160, y: 460 });
  await selected(page, [data.aId, data.bId]); await unchanged(page, workspace, data);
});
test('held pointer autoPan的新矩形从未完整包含变成包含，停止move后仍正确命中', async ({ page, workspace }) => {
  const data = await seed(page, workspace), initial = await view(page);
  expect(initial.z).toBe(1);
  const right = (initial.width - initial.tx) / initial.z;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId: data.before.project.id, type: 'shape.create', expected: null,
    payload: { id: 'pan-target', content: { shapeType: 'rectangle', shortText: '平移后才包含' }, pose: { x: right + 80, y: 360, width: 120, height: 80 } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  data.before = await workspace.state(); data.timeline = await history(page, workspace, data.before.project.id); data.commands.length = 0;
  const id = data.before.shapes!.find(value => value.id === 'pan-target')!.item.id;
  const v = await view(page, id), input = await mouse(page), edge = { x: v.left + v.width - 2, y: v.top + 460 };
  expect(v.target).not.toBeNull();
  const contained = (s: Awaited<ReturnType<typeof view>>) => !!s.rect && !!s.target && s.rect.left <= s.target.left && s.rect.top <= s.target.top && s.rect.right >= s.target.right && s.rect.bottom >= s.target.bottom;
  try {
    await input.down(screen(v, { x: right - 250, y: 320 })); await input.move(edge);
    const first = await view(page, id); expect(contained(first)).toBe(false);
    const samples = [first];
    for (let i = 0; i < 40 && !contained(samples.at(-1)!); i++) { await page.waitForTimeout(50); samples.push(await view(page, id)); }
    console.log('ISSUE28_MARQUEE_HELD_SAMPLES', JSON.stringify(samples));
    expect(samples.some(s => s.tx !== first.tx)).toBe(true); expect(contained(samples.at(-1)!)).toBe(true);
    await selected(page, [id]); await input.up(edge); await input.trace(1);
  } finally { await input.close(); }
  await selected(page, [id]); await unchanged(page, workspace, data);
});
