import { expect, test, type Workspace } from './writing-board-fixture';
import type { Page } from '@playwright/test';
import { createFrameCommand } from '../src/canvas-frame-commands';
import { expectedContainerClipboard } from './container-copy-clipboard-fixture';

async function prefixFrame(page: Page, workspace: Workspace) {
  const projectId = (await workspace.state()).project.id, frameId = 'clipboard-line:0';
  const frame = createFrameCommand(await workspace.state(), [], { x: 100, y: 140, width: 600, height: 450 });
  frame.payload.id = frameId;
  await workspace.execute(page, frame);
  await workspace.execute(page, { commandId: 'shape', projectId, type: 'shape.create', expected: null,
    payload: { id: 'inside', content: { shapeType: 'ellipse', shortText: '内部' }, pose: { x: 250, y: 260, width: 100, height: 60 } } });
  const shape = (await workspace.state()).shapes![0]!;
  await workspace.execute(page, { commandId: 'line', projectId, type: 'connector.create', expected: null,
    payload: { id: 'internal', path: 'straight', start: { kind: 'bound', targetKind: 'frame', itemId: frameId, side: 'top' }, end: { kind: 'bound', itemId: shape.item.id, side: 'top' } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  return { state: await workspace.state(), frameId, shape };
}

test('显式内部线再Shift选Frame复制，只选新根不选新内部线', async ({ page, workspace }) => {
  const { frameId } = await prefixFrame(page, workspace);
  const original = page.locator('[data-connector-id="internal"]');
  await original.click(); await expect(original).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '分区1', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator(`[data-frame-id="${frameId}"]`)).toHaveAttribute('data-selected', 'true');
  await expect(original).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Meta+d');
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(2);
  const copied = await workspace.state(), frame = copied.frames!.find(v => v.id !== frameId)!, line = copied.connectors!.find(v => v.id !== 'internal')!;
  await expect.poll(async () => page.locator('[data-frame-id][data-selected=true]').getAttribute('data-frame-id')).toBe(frame.id);
  await expect(page.locator(`[data-connector-id="${line.id}"]`)).toHaveAttribute('aria-pressed', 'false');
  await expect(original).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
});

test('模拟MIME事件：合法clipboard-line:0 Frame与内部线的v2快照可粘贴，虚构线身份不能碰撞', async ({ page, workspace }) => {
  const { state, frameId, shape } = await prefixFrame(page, workspace);
  const base = expectedContainerClipboard(state, [frameId], [frameId, shape.item.id]), line = state.connectors![0]!;
  const document = { ...base, connectors: [{ path: line.path,
    start: { kind: 'bound', itemId: frameId, side: 'top', targetKind: 'frame' }, end: { kind: 'bound', itemId: shape.item.id, side: 'top' },
    ...(line.style ? { style: line.style } : {}), ...(line.label !== undefined ? { label: line.label } : {}) }] };
  await page.locator('.react-flow__pane').evaluate((element, raw) => {
    const data = new DataTransfer(); data.setData('web application/x-forkwise-canvas', raw);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, JSON.stringify(document));
  await expect.poll(async () => (await workspace.state()).frames!.length).toBe(2);
  const copied = await workspace.state(), newFrame = copied.frames!.find(v => v.id !== frameId)!;
  const newShape = copied.shapes!.find(v => v.id !== shape.id)!, newLine = copied.connectors!.find(v => v.id !== line.id)!;
  expect(newLine.start).toEqual({ kind: 'bound', targetKind: 'frame', itemId: newFrame.id, side: 'top' });
  expect(newLine.end).toEqual({ kind: 'bound', itemId: newShape.item.id, side: 'top' });
  expect(copied.containment!.find(v => v.id === newShape.item.id)!.parent).toEqual({ kind: 'frame', id: newFrame.id });
});
