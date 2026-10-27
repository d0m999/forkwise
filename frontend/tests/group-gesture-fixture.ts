import { expect, type Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import type { Workspace } from './writing-board-fixture';
import type { ProjectState } from '../src/api';

export type Point = { x: number; y: number };
type MouseTrace = { type: string; x: number; y: number; button: number; buttons: number; alt: boolean; trusted: boolean };

export async function trustedMouse(page: Page) {
  const session = await page.context().newCDPSession(page), sessionId = crypto.randomUUID();
  const record = (event: string) => {
    const path = process.env.FORKWISE_ISSUE10_RESOURCE_LOG;
    if (path) appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), fixturePID: process.pid, event, sessionId }) + '\n');
  };
  record('cdp-session-open');
  await page.evaluate(() => {
    const target = window as typeof window & { issue28MouseTrace?: MouseTrace[]; issue28RemoveMouseTrace?: () => void };
    const trace: MouseTrace[] = [];
    const observe = (event: MouseEvent) => trace.push({ type: event.type, x: event.clientX, y: event.clientY,
      button: event.button, buttons: event.buttons, alt: event.altKey, trusted: event.isTrusted });
    for (const name of ['mousedown', 'mousemove', 'mouseup'] as const) window.addEventListener(name, observe, true);
    target.issue28MouseTrace = trace;
    target.issue28RemoveMouseTrace = () => {
      for (const name of ['mousedown', 'mousemove', 'mouseup'] as const) window.removeEventListener(name, observe, true);
      delete target.issue28MouseTrace; delete target.issue28RemoveMouseTrace;
    };
  });
  let pressed = false, last: Point = { x: 0, y: 0 }, modifiers = 0;
  const send = async (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', point: Point, alt = false) => {
    last = point; modifiers = alt ? 1 : 0;
    await session.send('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' && !pressed ? 'none' : 'left',
      buttons: type === 'mouseReleased' ? 0 : type === 'mousePressed' || pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers });
  };
  return {
    async start(point: Point) {
      await page.evaluate(() => { (window as typeof window & { issue28MouseTrace: MouseTrace[] }).issue28MouseTrace.length = 0; });
      await send('mouseMoved', point); await send('mousePressed', point); pressed = true;
    },
    move: (point: Point, alt = false) => send('mouseMoved', point, alt),
    async up(point: Point, alt = false) { await send('mouseReleased', point, alt); pressed = false; },
    async trace() {
      const trace = await page.evaluate(() => (window as typeof window & { issue28MouseTrace: MouseTrace[] }).issue28MouseTrace);
      console.log('ISSUE28_TRUSTED_MOUSE', JSON.stringify(trace));
      expect(trace.some(event => event.type === 'mousedown')).toBe(true);
      expect(trace.at(-1)?.type).toBe('mouseup');
      expect(trace.filter(event => event.type === 'mousemove' && event.buttons === 1)).toHaveLength(1);
      expect(trace.every(event => event.trusted)).toBe(true);
      return trace;
    },
    async close() {
      try {
        if (pressed) { console.log('ISSUE28_CLEANUP_RELEASE', JSON.stringify(last)); await send('mouseReleased', last, modifiers === 1); }
        console.log('ISSUE28_FINAL_MOUSE_TRACE', JSON.stringify(await page.evaluate(() => (window as typeof window & { issue28MouseTrace?: MouseTrace[] }).issue28MouseTrace)));
      } finally {
        try { await page.evaluate(() => (window as typeof window & { issue28RemoveMouseTrace?: () => void }).issue28RemoveMouseTrace?.()); }
        finally { await session.detach(); record('cdp-session-detached'); }
      }
    },
  };
}

export function node(page: Page, itemId: string) { return page.locator('.react-flow__node[data-id="' + itemId + '"]'); }
export async function nodePoint(page: Page, itemId: string) {
  return node(page, itemId).evaluate(el => { const matrix = new DOMMatrix(getComputedStyle(el).transform); return { x: matrix.e, y: matrix.f }; });
}
export async function history(page: Page, workspace: Workspace, projectId: string) {
  const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + projectId + '/history');
  expect(response.status()).toBe(200); return response.json();
}
export async function zoom(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(el => {
    const api = (el as Element & { computedStyleMap?: () => { get(name: string): unknown } }).computedStyleMap;
    if (!api) throw new Error('Typed OM unavailable');
    const transform = api.call(el).get('transform') as { toMatrix?: () => DOMMatrix };
    if (!transform?.toMatrix) throw new Error('Typed OM transform matrix unavailable');
    const value = transform.toMatrix().a;
    if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid actual viewport scale');
    return value;
  });
}
export async function selectGroup(page: Page) {
  await page.locator('.react-flow__pane').click({ position: { x: 950, y: 550 } });
  await page.getByRole('img', { name: '手势形状', exact: true }).click();
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '进入组合', exact: true })).toBeVisible();
}
export async function seedGroup(page: Page, workspace: Workspace) {
  const projectId = (await workspace.state()).project.id;
  const execute = (type: string, payload: unknown, expected: unknown = null) => workspace.execute(page,
    { commandId: crypto.randomUUID(), projectId, type, expected, payload });
  await execute('thought.create', { id: 'gesture-card', title: '手势卡片', text: '保留手势正文', x: 100, y: 160 });
  await execute('shape.create', { id: 'gesture-shape', content: { shapeType: 'ellipse', shortText: '手势形状' },
    pose: { x: 420, y: 200, width: 180, height: 100 } });
  const initial = await workspace.state(), ids = [initial.cards[0]!.item.id, initial.shapes![0]!.item.id];
  await execute('group.create', { id: 'gesture-group', itemIds: ids },
    { groups: { 'gesture-group': null }, containment: Object.fromEntries(ids.map(id => [id, null])) });
  const layout = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'card.layout');
  await page.reload(); expect((await layout).status()).toBe(200);
  await expect(page.getByRole('status')).toHaveText('已保存到本机'); await selectGroup(page);
  const before = await workspace.state();
  expect(before.cards[0]!.item.pose).toMatchObject({ x: 100, y: 160 });
  expect(before.shapes![0]!.item.pose).toEqual({ x: 420, y: 200, width: 180, height: 100 });
  expect(before.groups![0]!.memberItemIds).toEqual(ids);
  return { before, cardId: ids[0]!, shapeId: ids[1]!, timeline: await history(page, workspace, projectId) };
}
export async function center(page: Page, itemId: string) {
  const box = (await node(page, itemId).boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
export function offset(point: Point, x: number, y: number): Point { return { x: point.x + x, y: point.y + y }; }
export function writes(page: Page) {
  const commands: any[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON()); });
  return commands;
}
export async function preview(page: Page, workspace: Workspace, before: ProjectState, card: Point, shape: Point) {
  await expect.poll(async () => nodePoint(page, before.cards[0]!.item.id)).toEqual(card);
  await expect.poll(async () => nodePoint(page, before.shapes![0]!.item.id)).toEqual(shape);
  expect(await workspace.state()).toEqual(before);
}
export async function savedGroup(page: Page, workspace: Workspace, before: ProjectState, timeline: any, commands: any[], dx: number, dy: number) {
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose.x).toBeCloseTo(100 + dx, 4);
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const after = await workspace.state();
  for (const [origin, value, x, y] of [[before.cards[0]!, after.cards[0]!, 100 + dx, 160 + dy],
    [before.shapes![0]!, after.shapes![0]!, 420 + dx, 200 + dy]] as const) {
    expect(value.item.pose.x).toBeCloseTo(x, 4); expect(value.item.pose.y).toBeCloseTo(y, 4);
    expect(value.item.versionId).not.toBe(origin.item.versionId);
    expect(value).toEqual({ ...origin, item: { ...origin.item, versionId: value.item.versionId, pose: { ...origin.item.pose, x: value.item.pose.x, y: value.item.pose.y } } });
  }
  expect(after.containment).toEqual(before.containment);
  expect(after.groups!.map(({ bounds, ...value }) => value)).toEqual(before.groups!.map(({ bounds, ...value }) => value));
  expect(after.project.revision).toBe(before.project.revision + 1); expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({ type: 'canvas.move-selection', payload: { groupIds: ['gesture-group'], directItemIds: [] } });
  expect(commands[0].payload.dx).toBeCloseTo(dx, 4); expect(commands[0].payload.dy).toBeCloseTo(dy, 4);
  expect(commands[0].expected).toEqual({ groups: { 'gesture-group': before.groups![0]!.versionId },
    containment: Object.fromEntries(before.containment!.map(value => [value.id, value.versionId])),
    poses: Object.fromEntries([before.cards[0]!, before.shapes![0]!].map(value => [value.item.id, value.item.versionId])) });
  expect((await history(page, workspace, before.project.id)).undo).toHaveLength(timeline.undo.length + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual(before.cards[0]!.item.pose);
  expect((await workspace.state()).shapes![0]!.item.pose).toEqual(before.shapes![0]!.item.pose);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).cards[0]!.item.pose).toEqual(after.cards[0]!.item.pose);
  expect((await workspace.state()).shapes![0]!.item.pose).toEqual(after.shapes![0]!.item.pose);
}

export type CanvasProbeSnapshot = {
  at: number;
  viewport: { a: number; b: number; c: number; d: number; e: number; f: number };
  flow: { x: number; y: number; width: number; height: number };
  nodes: { id: string; world: Point; selected: boolean }[];
};
export type CanvasProbeMouseEvent = {
  type: string; client: Point; buttons: number; trusted: boolean; sample: CanvasProbeSnapshot;
};
type ProbeOwner = { sample: () => CanvasProbeSnapshot; events: CanvasProbeMouseEvent[]; remove: () => void };

export async function publicCanvasProbe(page: Page) {
  await page.evaluate(() => {
    const target = window as typeof window & { issue28CanvasProbe?: ProbeOwner };
    const matrix = (el: Element) => {
      const api = (el as Element & { computedStyleMap?: () => { get(name: string): unknown } }).computedStyleMap;
      if (!api) throw new Error('Public Typed OM unavailable');
      const value = api.call(el).get('transform') as { toMatrix?: () => DOMMatrix };
      if (!value?.toMatrix) throw new Error('Public transform matrix unavailable');
      const m = value.toMatrix();
      if (![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite)) throw new Error('Nonfinite public matrix');
      return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
    };
    const sample = (): CanvasProbeSnapshot => {
      const flow = document.querySelector('.react-flow')!.getBoundingClientRect();
      return { at: performance.now(), viewport: matrix(document.querySelector('.react-flow__viewport')!),
        flow: { x: flow.x, y: flow.y, width: flow.width, height: flow.height },
        nodes: Array.from(document.querySelectorAll<HTMLElement>('.react-flow__node')).map(el => {
          const id = el.dataset.id;
          if (!id) throw new Error('Public canvas node has no identity');
          const m = matrix(el); return { id, world: { x: m.e, y: m.f }, selected: el.classList.contains('selected') };
        }) };
    };
    const events: CanvasProbeMouseEvent[] = [];
    const observe = (event: MouseEvent) => events.push({ type: event.type, client: { x: event.clientX, y: event.clientY },
      buttons: event.buttons, trusted: event.isTrusted, sample: sample() });
    for (const name of ['mousedown', 'mousemove', 'mouseup'] as const) window.addEventListener(name, observe, true);
    target.issue28CanvasProbe = { sample, events, remove: () => {
      for (const name of ['mousedown', 'mousemove', 'mouseup'] as const) window.removeEventListener(name, observe, true);
      delete target.issue28CanvasProbe;
    } };
  });
  return {
    sample: () => page.evaluate(() => (window as typeof window & { issue28CanvasProbe: ProbeOwner }).issue28CanvasProbe.sample()),
    events: () => page.evaluate(() => (window as typeof window & { issue28CanvasProbe: ProbeOwner }).issue28CanvasProbe.events),
    close: () => page.evaluate(() => (window as typeof window & { issue28CanvasProbe?: ProbeOwner }).issue28CanvasProbe?.remove()),
  };
}
