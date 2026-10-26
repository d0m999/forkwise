import { test, expect } from './writing-board-fixture';
import type { Command } from '../../backend/src/mapping/contracts';
import { connectorSurfaceBox, connectorSvgEnds, seedConnectorCard } from './connector-ui-fixture';

test('多对象地图中的端点中心可重接且不移动绑定文字', async ({ page, workspace }) => {
  const a = await seedConnectorCard(page, workspace, 'layer-start', 100, 80);
  const target = await seedConnectorCard(page, workspace, 'layer-target', 900, 90);
  for (let i = 0; i < 3; i++)
    await seedConnectorCard(page, workspace, 'layer-background-' + i, 1500 + i * 350, 700);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'layer-text', content: { runs: [{ text: '后创建的独立文字' }], fontSize: 18, lineHeight: 1.5,
      align: 'left', widthMode: 'fixed', width: 180 }, pose: { x: 680, y: 300, width: 180, height: 27 } } });
  const text = (await workspace.state()).texts!.find(value => value.id === 'layer-text')!;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'layer-line', path: 'straight', start: { kind: 'bound', itemId: a.item.id, side: 'right' },
      end: { kind: 'bound', itemId: text.item.id, side: 'top' } } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const line = page.getByRole('button', { name: '普通连线', exact: true });
  await line.click();
  const before = await workspace.state(), original = before.connectors!.find(value => value.id === 'layer-line')!;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const initialHistory = await (await page.request.get(historyUrl)).json();
  const handle = page.getByRole('button', { name: '连线终点', exact: true });
  await expect(handle).toBeVisible();
  const hit = await handle.evaluate((element, itemId) => {
    const box = element.getBoundingClientRect(), center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const actual = document.elementFromPoint(center.x, center.y);
    const host = [...document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')].find(node => node.dataset.id === itemId);
    return { center, hitIsHandleOrDescendant: !!actual && (actual === element || element.contains(actual)),
      hitTag: actual?.tagName, hitClass: actual?.getAttribute('class'),
      hostLayer: host && getComputedStyle(host).zIndex, handleLayer: getComputedStyle(element).zIndex };
  }, text.item.id);
  console.log('issue26-late-host-endpoint-hit', JSON.stringify(hit));
  expect(hit.hitIsHandleOrDescendant, '绑定文字上的端点中心必须命中手柄，而不是移动宿主').toBe(true);
  const box = await connectorSurfaceBox(page, target.item.id);
  const destination = { x: box.x, y: box.y + box.height / 2 };
  const initialEnds = await connectorSvgEnds(line.locator('path')), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    await handle.hover(); await page.mouse.down(); await page.mouse.move(destination.x, destination.y, { steps: 6 });
    const preview = page.getByRole('img', { name: '连线预览', exact: true });
    await expect(preview).toBeVisible();
    const ends = await connectorSvgEnds(preview.locator('path'));
    expect(ends.start).toEqual(initialEnds.start);
    expect(ends.end).toEqual(destination);
    expect(commands).toHaveLength(0);
    expect(await workspace.state()).toEqual(before);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') &&
      response.request().postDataJSON()?.type === 'connector.reconnect');
    await page.mouse.up();
    expect((await saved).status()).toBe(200);
    await expect(preview).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const after = await workspace.state(), changed = after.connectors!.find(value => value.id === original.id)!;
    expect(commands).toEqual([expect.objectContaining({ type: 'connector.reconnect', expected: original.versionId,
      payload: { id: original.id, endpoint: 'end', value: { kind: 'bound', itemId: target.item.id, side: 'left' } } })]);
    expect(changed).toMatchObject({ id: original.id, start: original.start,
      end: { kind: 'bound', itemId: target.item.id, side: 'left' } });
    expect(changed.versionId).not.toBe(original.versionId);
    expect(after.connectors).toHaveLength(before.connectors!.length);
    for (const key of ['cards', 'texts', 'shapes', 'images', 'strokes', 'tags'] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.project.revision).toBe(before.project.revision + 1);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(initialHistory.undo.length + 1);
    expect(await connectorSvgEnds(line.locator('path'))).toEqual(ends);
    const changesUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) +
      '/changes?after=' + before.project.revision;
    const changes = await (await page.request.get(changesUrl)).json();
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0].changedIds).toEqual([original.id]);
    console.log('issue26-late-host-reconnect', JSON.stringify({ original, changed, commands, revision: after.project.revision }));
  } finally { page.off('request', record); }
});
