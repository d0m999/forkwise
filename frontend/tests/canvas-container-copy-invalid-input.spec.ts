import { expect, test } from './writing-board-fixture';

const invalidCases = [
  { name: 'v2零成员group', version: 2, emptyGroup: true, explicit: false },
  { name: 'v1 stroke端点省略targetKind', version: 1, emptyGroup: false, explicit: false },
  { name: 'v1 stroke端点显式item', version: 1, emptyGroup: false, explicit: true },
  { name: 'v2 stroke端点省略targetKind', version: 2, emptyGroup: false, explicit: false },
  { name: 'v2 stroke端点显式item', version: 2, emptyGroup: false, explicit: true },
];
for (const sample of invalidCases) test(`模拟MIME事件拒绝${sample.name}，不派写入且保留项目状态`, async ({ page, workspace }) => {
  const before = await workspace.state(), writes: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/mapping/execute')) writes.push(request.postDataJSON()?.type); });
  const document = { kind: 'forkwise-canvas-snapshot', version: sample.version,
    ...(sample.version === 2 ? { roots: ['source-item'], containment: [] } : {}),
    objects: [sample.emptyGroup
      ? { kind: 'group', sourceId: 'source-group', itemId: 'source-item', stack: 1, pose: { x: 100, y: 100, width: 100, height: 100 } }
      : { kind: 'stroke', sourceId: 'source-stroke', itemId: 'source-item', stack: 1,
          content: { penKind: 'pen', color: '#403b36', width: 4, opacity: 1, path: [{ x: 0, y: 0 }, { x: 20, y: 10 }] }, pose: { x: 100, y: 100, width: 20, height: 10 } }],
    connectors: sample.emptyGroup ? [] : [{ path: 'straight', start: { kind: 'bound', itemId: 'source-item', side: 'top', ...(sample.explicit ? { targetKind: 'item' } : {}) }, end: { kind: 'free', point: { x: 500, y: 300 } } }],
  };
  await page.locator('.react-flow__pane').evaluate((element, raw) => {
    const data = new DataTransfer(); data.setData('web application/x-forkwise-canvas', raw);
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, JSON.stringify(document));
  await expect(page.getByText('无法读取这份画布剪贴板，原内容未改变', { exact: true })).toBeVisible();
  expect(writes).toEqual([]); expect(await workspace.state()).toEqual(before);
});
