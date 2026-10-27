import { test, expect } from './writing-board-fixture';
import { readCompactMap } from '../src/compact-map';
import type { CompactPage, ConnectorIndex, DetailChunk } from '../../backend/src/mapping/compact-contracts';
import Database from '../../backend/node_modules/better-sqlite3/lib/index.js';
import { join } from 'node:path';

test('完整投影区分JSON中不同的未配对surrogate标签文字', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id, original = String.fromCharCode(0xd800), changed = String.fromCharCode(0xd801);
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'literal-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['literal-label'],
    payload: { id: 'literal-label', label: { text: original, position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  const request = async <T,>(path: string): Promise<T> => {
    const response = await page.request.get(workspace.origin + '/api/mapping' + path); expect(response.ok()).toBe(true);
    const body = await response.json() as CompactPage<DetailChunk>;
    if (new URL(response.url()).searchParams.get('view') === 'connector-detail') {
      expect(body.coverage.complete).toBe(true);
      const value = JSON.parse(body.items.map(chunk => chunk.jsonText).join(''));
      expect(value.label.text).toBe(original); value.label.text = changed;
      const points = Array.from(JSON.stringify(value));
      body.items = body.items.map((chunk, index) => ({ ...chunk, jsonText: points.slice(index * 128, (index + 1) * 128).join('') }));
      while (body.bytes !== Buffer.byteLength(JSON.stringify(body))) body.bytes = Buffer.byteLength(JSON.stringify(body));
    }
    return body as T;
  };
  await expect(readCompactMap(projectId, request), '不同JSON文字不能因UTF8替换字符归一而通过摘要校验').rejects.toThrow(/连线文字.*快照/);
  expect((await workspace.state()).connectors![0]!.label!.text).toBe(original);
});

test('旧连线缺省外观和标签的不可变JSON重开可读且后续编辑不改旧版本', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'legacy-line', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  const { style: _style, label: _label, ...legacy } = (await workspace.state()).connectors![0]!;
  legacy.versionId = crypto.randomUUID();
  const raw = JSON.stringify(legacy), database = new Database(join(workspace.directory, 'workspace.sqlite'));
  try {
    // Fixture-only old-format storage; production reads must never rewrite it.
    database.transaction(() => {
      database.prepare('UPDATE mapping_connectors SET value=? WHERE project_id=? AND id=?').run(raw, projectId, legacy.id);
      database.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run(projectId, 'connector', legacy.id, legacy.versionId, raw);
    })();
  } finally { database.close(); }
  await workspace.restart(); await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const line = page.getByRole('button', { name: '普通连线', exact: true }); await expect(line).toHaveCount(1);
  await expect(line.locator('path')).toHaveCSS('stroke-width', '4px');
  expect((await workspace.state()).connectors).toEqual([legacy]);
  const projection = await readCompactMap(projectId, async <T,>(path: string) => {
    const response = await page.request.get(workspace.origin + '/api/mapping' + path); expect(response.ok()).toBe(true); return await response.json() as T;
  });
  expect(projection.connectors).toEqual([legacy]);
  await line.click(); await page.getByLabel('线条颜色', { exact: true }).fill('#123456');
  await expect.poll(async () => (await workspace.state()).connectors![0]!.style?.color).toBe('#123456');
  const version = await page.request.get(workspace.origin + `/api/mapping/projects/${projectId}/versions/connector/${legacy.id}/${legacy.versionId}`);
  expect(version.ok()).toBe(true); expect(await version.json()).toEqual(legacy);
  const readOnly = new Database(join(workspace.directory, 'workspace.sqlite'), { readonly: true });
  try { expect(readOnly.prepare("SELECT value FROM mapping_versions WHERE project_id=? AND domain='connector' AND id=? AND version_id=?").get(projectId, legacy.id, legacy.versionId)).toEqual({ value: raw }); }
  finally { readOnly.close(); }
});

test('完整投影拒绝同快照内连线外观和标签索引与详情不一致', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'checked-line', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['checked-line'],
    payload: { id: 'checked-line', label: { text: '完整😀标签', position: 0.3, fontSize: 16, color: '#252933', bold: false } } });
  const mutate: [string, (line: ConnectorIndex) => void][] = [
    ['起点标记', line => { line.style!.startMarker = 'dot'; }], ['终点标记', line => { line.style!.endMarker = 'diamond'; }],
    ['线色', line => { line.style!.color = '#123456'; }], ['线宽', line => { line.style!.width = 8; }], ['线型', line => { line.style!.dash = 'dashed'; }],
    ['标签位置', line => { line.label!.position = 0.6; }], ['标签字号', line => { line.label!.fontSize = 24; }],
    ['标签颜色', line => { line.label!.color = '#123456'; }], ['标签加粗', line => { line.label!.bold = true; }],
    ['标签码点数', line => { line.label!.textCodePoints++; }], ['标签内容摘要', line => { line.label!.textJsonSha256 = '0'.repeat(64); }],
    ['标签缺失', line => { delete line.label; }],
  ];
  for (const [name, change] of mutate) await test.step(name, async () => {
    const request = async <T,>(path: string): Promise<T> => {
      const response = await page.request.get(workspace.origin + '/api/mapping' + path); expect(response.ok()).toBe(true);
      const body = await response.json() as CompactPage<ConnectorIndex>;
      if (new URL(response.url()).searchParams.get('view') === 'connector-index') {
        change(body.items[0]!);
        while (body.bytes !== Buffer.byteLength(JSON.stringify(body))) body.bytes = Buffer.byteLength(JSON.stringify(body));
      }
      return body as T;
    };
    await expect(readCompactMap(projectId, request), name + '必须在发布前校验').rejects.toThrow(/连线.*快照/);
  });
});

test('普通连线默认显示末端开放箭头和4px中性色实线', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'styled-line', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const path = page.getByRole('button', { name: '普通连线', exact: true }).locator('path');
  const rendered = await path.evaluate(element => {
    const style = getComputedStyle(element);
    return { start: style.markerStart, end: style.markerEnd, color: style.stroke, width: style.strokeWidth, dash: style.strokeDasharray };
  });
  expect(rendered.start).toBe('none');
  expect(rendered.end, '默认终点箭头须进入实际SVG渲染').not.toBe('none');
  expect(rendered).toMatchObject({ color: 'rgb(98, 110, 129)', width: '4px', dash: 'none' });
});

test('多选反转逐线交换自己的端标并一次撤销且路径切换保留标签', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [index, markers] of [['first', ['triangle', 'dot']], ['second', ['none', 'diamond']]] as const) {
    const y = index === 'first' ? 200 : 360;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: index, start: { kind: 'free', point: { x: 220, y } }, end: { kind: 'free', point: { x: 620, y: y + 60 } } } });
    let current = (await workspace.state()).connectors!.find(line => line.id === index)!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.style', expected: current.versionId,
      payload: { id: index, style: { startMarker: markers[0], endMarker: markers[1] } } });
    current = (await workspace.state()).connectors!.find(line => line.id === index)!;
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: current.versionId,
      payload: { id: index, label: { text: index + '\n标签', position: 0.3, fontSize: 16, color: '#123456', bold: true } } });
  }
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = (await workspace.state()).connectors!;
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const beforeHistory = await (await page.request.get(historyUrl)).json();
  const lines = page.getByRole('button', { name: '普通连线', exact: true });
  await lines.nth(0).click(); await lines.nth(1).click({ modifiers: ['Shift'] });
  await expect(lines.nth(0), 'Shift选择应保留原先选中的线').toHaveAttribute('aria-pressed', 'true');
  await expect(lines.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '反转方向', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).connectors!.map(line => [line.style!.startMarker, line.style!.endMarker])).toEqual([['dot', 'triangle'], ['diamond', 'none']]);
  const reversed = (await workspace.state()).connectors!;
  reversed.forEach((line, i) => expect(line).toMatchObject({ start: before[i]!.start, end: before[i]!.end, label: before[i]!.label, path: before[i]!.path }));
  expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(beforeHistory.undo.length + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).connectors).toEqual(before.map(({ versionId, ...content }) => expect.objectContaining(content)));
  expect((await workspace.state()).connectors!.map(line => line.versionId)).not.toEqual(before.map(line => line.versionId));
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).connectors).toEqual(reversed.map(({ versionId, ...content }) => expect.objectContaining(content)));
  await page.locator('.react-flow__pane').click({ position: { x: 1100, y: 400 } }); await lines.nth(0).click();
  await page.getByRole('button', { name: '曲线', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).connectors![0]!.path).toBe('curve');
  expect((await workspace.state()).connectors![0]).toMatchObject({ start: reversed[0]!.start, end: reversed[0]!.end, label: reversed[0]!.label, style: reversed[0]!.style });
});

test('选中操作栏分别设置五种端标和外观且撤销重开保留端点', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'appearance-line', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).connectors![0]!;
  const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
  await expect(page.getByRole('combobox', { name: '起点标记', exact: true }), '选中栏须公开独立起点标记入口').toBeVisible();
  const shapes = { none: null, 'open-arrow': 'polyline', triangle: 'polygon', dot: 'circle', diamond: 'polygon' };
  for (const endpoint of ['start', 'end'] as const) {
    const control = page.getByRole('combobox', { name: endpoint === 'start' ? '起点标记' : '终点标记', exact: true });
    await expect(control.locator('option')).toHaveCount(5);
    for (const marker of ['none', 'open-arrow', 'triangle', 'dot', 'diamond'] as const) {
      await control.selectOption(marker);
      await expect.poll(async () => (await workspace.state()).connectors![0]!.style![endpoint === 'start' ? 'startMarker' : 'endMarker']).toBe(marker);
      await expect.poll(() => line.locator('path').evaluate((element, side) => {
        const style = getComputedStyle(element), reference = side === 'start' ? style.markerStart : style.markerEnd;
        const id = reference.match(/#([^\)"']+)/)?.[1];
        return id ? document.getElementById(id)?.firstElementChild?.tagName : null;
      }, endpoint)).toBe(shapes[marker]);
    }
  }
  await page.getByLabel('线条颜色', { exact: true }).fill('#123456');
  await expect.poll(async () => (await workspace.state()).connectors![0]!.style!.color).toBe('#123456');
  await page.getByRole('combobox', { name: '线宽', exact: true }).selectOption('8');
  await expect.poll(async () => (await workspace.state()).connectors![0]!.style!.width).toBe(8);
  await page.getByRole('combobox', { name: '线型', exact: true }).selectOption('dashed');
  await expect.poll(async () => (await workspace.state()).connectors![0]!.style!.dash).toBe('dashed');
  await expect(line.locator('path')).toHaveCSS('stroke', 'rgb(18, 52, 86)');
  await expect(line.locator('path')).toHaveCSS('stroke-width', '8px');
  await expect.poll(() => line.locator('path').evaluate(e => getComputedStyle(e).strokeDasharray)).not.toBe('none');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).connectors![0]!.style!.dash).toBe('solid');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => (await workspace.state()).connectors![0]!.style!.dash).toBe('dashed');
  const saved = (await workspace.state()).connectors![0]!;
  expect(saved).toMatchObject({ start: original.start, end: original.end, path: original.path,
    style: { startMarker: 'diamond', endMarker: 'diamond', color: '#123456', width: 8, dash: 'dashed' } });
  await workspace.restart(); await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect((await workspace.state()).connectors).toEqual([saved]);
  await expect(line.locator('path')).toHaveCSS('stroke', 'rgb(18, 52, 86)');
});
