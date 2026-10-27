import { test, expect } from './writing-board-fixture';
import { connectorSurfaceBox, seedConnectorCard } from './connector-ui-fixture';

test('等待位姿ACK时改选另一条线会取消旧线标签入口并保留新选区', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'label-entry-switch-card', 130, 150), projectId = (await workspace.state()).project.id;
  for (const [id, y] of [['label-entry-line-a', 220], ['label-entry-line-b', 420]] as const) {
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id, start: { kind: 'free', point: { x: 600, y } }, end: { kind: 'free', point: { x: 950, y } } } });
  }
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const beforeLines = (await workspace.state()).connectors!;
  let release!: () => void, committed = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'pose.move' || command.payload.id !== card.id) { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await held; await route.fulfill({ response });
  });
  try {
    const node = page.locator('.thought-card').first(); await node.locator('.title-button').click();
    await node.getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight'); await expect.poll(() => committed).toBe(true);
    const lineA = page.locator('.canvas-connector[data-connector-id="label-entry-line-a"]'), lineB = page.locator('.canvas-connector[data-connector-id="label-entry-line-b"]');
    await lineA.click(); await expect(lineA).toHaveAttribute('aria-pressed', 'true');
    const add = page.getByRole('button', { name: '添加文字', exact: true }); await expect(add).toBeEnabled(); await add.click();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await expect(input).toHaveCount(0);
    await lineB.click(); await expect(lineB).toHaveAttribute('aria-pressed', 'true'); await expect(lineA).toHaveAttribute('aria-pressed', 'false');
    release(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(lineB, 'ACK后的旧入口不能抢回已经改选的连线').toHaveAttribute('aria-pressed', 'true');
    await expect(lineA).toHaveAttribute('aria-pressed', 'false'); await expect(input).toHaveCount(0); expect((await workspace.state()).connectors).toEqual(beforeLines);
    await add.click(); await expect(input).toBeFocused(); await input.fill('新选中线的标签'); await input.press('Escape'); await expect(input).toHaveCount(0);
    const after = (await workspace.state()).connectors!; expect(after.find(value => value.id === 'label-entry-line-a')).toEqual(beforeLines.find(value => value.id === 'label-entry-line-a'));
    expect(after.find(value => value.id === 'label-entry-line-b')!.label!.text).toBe('新选中线的标签');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('点击标签位置输入先保存结束文字且保留新焦点输入与后续位置动作', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-position-outside', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['label-position-outside'],
    payload: { id: 'label-position-outside', label: { text: '原文', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const commands: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
  let release!: () => void, committed = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON(); if (command.type !== 'connector.label') { await route.continue(); return; }
    commands.push(command); const response = await route.fetch();
    if (commands.length === 1) { committed = true; await held; } await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }), position = page.getByRole('spinbutton', { name: '标签位置（%）', exact: true });
    await input.fill('外点前的完整文字'); await position.click(); await expect(position).toBeFocused(); await expect.poll(() => committed).toBe(true);
    await expect(input).toHaveValue('外点前的完整文字'); await position.fill('80'); release();
    await expect(input, '仅点击位置输入也是标签外点，确认保存后应结束文字编辑').toHaveCount(0);
    await expect(position).toBeFocused(); await expect(position).toHaveValue('80');
    expect((await workspace.state()).connectors![0]!.label!.position).toBe(0.5);
    await position.press('Enter'); await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.position).toBe(0.8);
    expect((await workspace.state()).connectors![0]!.label).toEqual({ text: '外点前的完整文字', position: 0.8, fontSize: 16, color: '#252933', bold: false });
    expect(commands).toHaveLength(2); await expect(position).toBeFocused();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('等待卡片位姿保存时切换卡片工具会取消旧标签入口', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'label-entry-pose-card', 130, 150), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-entry-pose-line', start: { kind: 'free', point: { x: 600, y: 250 } }, end: { kind: 'free', point: { x: 900, y: 400 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const beforeLine = (await workspace.state()).connectors!.find(value => value.id === 'label-entry-pose-line')!;
  let release!: () => void, committed = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'pose.move' || command.payload.id !== card.id) { await route.continue(); return; }
    const response = await route.fetch(); expect(response.status()).toBe(200); committed = true; await held; await route.fulfill({ response });
  });
  try {
    const node = page.locator('.thought-card').first(); await node.locator('.title-button').click();
    await node.getByRole('button', { name: '移动卡片：方向键调整位置', exact: true }).press('ArrowRight'); await expect.poll(() => committed).toBe(true);
    await page.getByRole('button', { name: '普通连线', exact: true }).click();
    const add = page.getByRole('button', { name: '添加文字', exact: true }); await expect(add).toBeEnabled(); await add.click();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await expect(input).toHaveCount(0);
    const tool = page.getByRole('button', { name: '卡片', exact: true }); await expect(tool).toBeEnabled(); await tool.click(); await expect(tool).toHaveAttribute('aria-pressed', 'true');
    release(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(input, '旧标签入口不得在新卡片工具选定后才打开').toHaveCount(0);
    const count = (await workspace.state()).cards.length; await page.locator('.react-flow__pane').click({ position: { x: 700, y: 550 } });
    await expect.poll(async () => (await workspace.state()).cards.length).toBe(count + 1);
    expect((await workspace.state()).connectors!.find(value => value.id === 'label-entry-pose-line')).toEqual(beforeLine);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('键盘结束连线文字后焦点返回入口且保存等待期间不抢新目标', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-return-focus', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const line = page.getByRole('button', { name: '普通连线', exact: true }), input = page.getByRole('textbox', { name: '连线文字', exact: true });
  await line.focus(); await line.press('Enter');
  const add = page.getByRole('button', { name: '添加文字', exact: true });
  for (let step = 0; step < 25 && !(await add.evaluate(element => element === document.activeElement)); step++) await page.keyboard.press('Tab');
  await expect(add).toBeFocused(); await page.keyboard.press('Enter'); await expect(input).toBeFocused(); await input.fill('Esc保存'); await input.press('Escape');
  const edit = page.getByRole('button', { name: '编辑文字', exact: true });
  await expect(input).toHaveCount(0); await expect(edit, '结束编辑应返回仍存在的触发入口').toBeFocused();
  await page.keyboard.press('Enter'); await expect(input).toBeFocused(); await input.fill('快捷键保存'); await input.press('Control+Enter');
  await expect(input).toHaveCount(0); await expect(edit).toBeFocused();
  let release!: () => void, committed = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'connector.label') { await route.continue(); return; }
    const response = await route.fetch(); committed = true; await held; await route.fulfill({ response });
  });
  try {
    await page.keyboard.press('Enter'); await input.fill('等待保存时选择新控件'); await input.press('Control+Enter'); await expect.poll(() => committed).toBe(true);
    const zoom = page.getByRole('button', { name: '放大', exact: true }); await zoom.click(); await expect(zoom).toBeFocused(); release();
    await expect(input).toHaveCount(0); await expect(zoom, '保存确认不能抢走用户新选控件的焦点').toBeFocused();
    expect((await workspace.state()).connectors![0]!.label!.text).toBe('等待保存时选择新控件');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('键盘按路径百分比定位标签且Enter和应用各一次撤销Escape不写入', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'keyboard-label-position', path: 'curve', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 720, y: 500 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['keyboard-label-position'],
    payload: { id: 'keyboard-label-position', label: { text: '键盘沿线定位', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const line = page.getByRole('button', { name: '普通连线', exact: true }), label = page.getByRole('button', { name: '连线文字', exact: true });
  await line.focus(); await line.press('Enter'); const position = page.getByRole('spinbutton', { name: '标签位置（%）', exact: true });
  await expect(position, '标签路径位置必须有可理解的键盘入口').toBeVisible();
  for (let step = 0; step < 30 && !(await position.evaluate(element => element === document.activeElement)); step++) await page.keyboard.press('Tab');
  await expect(position).toBeFocused(); await expect(page.getByText('0% 为起点，100% 为终点；Enter 应用，Esc 取消', { exact: true })).toBeVisible();
  const commands: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.label') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    await position.fill('80'); await position.press('Enter'); await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.position).toBe(0.8);
    await expect(position).toBeFocused(); expect(commands).toHaveLength(1);
    const target = await line.locator('path').evaluate(element => { const path = element as SVGPathElement, point = path.getPointAtLength(path.getTotalLength() * 0.8), screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!); return { x: screen.x, y: screen.y }; });
    await expect.poll(async () => { const box = (await label.boundingBox())!; return Math.hypot(box.x + box.width / 2 - target.x, box.y + box.height / 2 - target.y); }).toBeLessThan(2);
    await position.fill('20'); await position.press('Escape'); await expect(position).toHaveValue('80'); await expect(position).toBeFocused(); expect(commands).toHaveLength(1);
    expect((await workspace.state()).connectors![0]!.label!.position).toBe(0.8);
    await position.fill('65'); await position.press('Tab'); const apply = page.getByRole('button', { name: '应用标签位置', exact: true }); await expect(apply).toBeFocused(); await apply.press('Space');
    await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.position).toBe(0.65); await expect(position).toBeFocused(); expect(commands).toHaveLength(2);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(position).toHaveValue('80');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(position).toHaveValue('50');
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(position).toHaveValue('80');
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(position).toHaveValue('65');
    const saved = (await workspace.state()).connectors![0]!; expect(saved.label).toEqual({ text: '键盘沿线定位', position: 0.65, fontSize: 16, color: '#252933', bold: false });
  } finally { page.off('request', record); }
});

test('标签外点Shift点击当前线取消选中而Shift点击空白保留选区', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'outside-shift-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 720, y: 220 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['outside-shift-label'],
    payload: { id: 'outside-shift-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const label = page.getByRole('button', { name: '连线文字', exact: true }), line = page.getByRole('button', { name: '普通连线', exact: true });
  const input = page.getByRole('textbox', { name: '连线文字', exact: true });
  await label.dblclick(); await input.fill('点线前保存');
  const point = await line.locator('path').evaluate(element => { const path = element as SVGPathElement, p = path.getPointAtLength(path.getTotalLength() * 0.1), screen = new DOMPoint(p.x, p.y).matrixTransform(path.getScreenCTM()!); return { x: screen.x, y: screen.y }; });
  await page.keyboard.down('Shift'); try { await page.mouse.click(point.x, point.y); } finally { await page.keyboard.up('Shift'); }
  await expect(input).toHaveCount(0); await expect(label).toHaveText('点线前保存');
  await expect(line, '与未编辑时相同，Shift点击已选线应切换为未选中').toHaveAttribute('aria-pressed', 'false');
  await label.dblclick(); await input.fill('点空白前保存');
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 40 }, modifiers: ['Shift'] });
  await expect(input).toHaveCount(0); await expect(label).toHaveText('点空白前保存');
  await expect(line, 'Shift点击空白不应清掉当前线选区').toHaveAttribute('aria-pressed', 'true');
  expect((await workspace.state()).connectors![0]!.label!.text).toBe('点空白前保存');
});

test('外点缩放控件和画布外状态区保留文字并结束且缩放正常执行', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'outside-control-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['outside-control-label'],
    payload: { id: 'outside-control-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let release!: () => void, committed = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'connector.label') { await route.continue(); return; }
    const response = await route.fetch(); committed = true; await held; await route.fulfill({ response });
  });
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('缩放前完整文字');
    const viewport = page.locator('.react-flow__viewport'), before = await viewport.getAttribute('style');
    await page.getByRole('button', { name: '放大', exact: true }).click(); await expect.poll(() => viewport.getAttribute('style')).not.toBe(before);
    await expect.poll(() => committed).toBe(true); await expect(input).toHaveValue('缩放前完整文字'); release();
    await expect(input, '缩放也是标签外点，保存确认后必须结束编辑').toHaveCount(0); await expect(label).toHaveText('缩放前完整文字');
    await label.dblclick(); await input.fill('画布外也保留'); await page.locator('.save-state').click({ position: { x: 2, y: 2 } });
    await expect(input).toHaveCount(0); await expect(label).toHaveText('画布外也保留'); expect((await workspace.state()).connectors![0]!.label!.text).toBe('画布外也保留');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('键盘离开标签输入区再返回时保持光标并结束前一撤销组', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-focus-groups', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['label-focus-groups'],
    payload: { id: 'label-focus-groups', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await page.clock.setFixedTime(Date.now());
  const label = page.getByRole('button', { name: '连线文字', exact: true }), line = page.getByRole('button', { name: '普通连线', exact: true }); await label.dblclick();
  const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.press('End'); await input.pressSequentially('A');
  await input.press('Shift+Tab'); await expect(line).toBeFocused(); await page.keyboard.press('Tab'); await expect(input).toBeFocused();
  expect(await input.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 2]);
  await input.pressSequentially('B'); await expect(input).toHaveValue('0AB'); await input.press('Escape'); await expect(input).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label, '离开输入区前后应是两次独立编辑动作').toHaveText('0A');
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('0');
  await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(label).toHaveText('0A');
  await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(label).toHaveText('0AB');
});

test('连续标签输入在两秒提交一批且自动保存不拆开统一撤销组', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-batch-timing', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['label-batch-timing'],
    payload: { id: 'label-batch-timing', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const commands: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.label') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.press('End');
    const clockStart = Date.now(); await page.clock.install({ time: clockStart }); await page.clock.pauseAt(clockStart + 1000);
    for (const letter of 'ABCDEF') { await input.pressSequentially(letter); await page.clock.runFor(300); }
    await input.pressSequentially('G'); await page.clock.runFor(199); expect(commands).toHaveLength(0);
    await page.clock.runFor(1); await expect.poll(() => commands.length).toBe(1); expect(commands[0]!.payload.label?.text).toBe('0ABCDEFG');
    await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.text).toBe('0ABCDEFG');
    await input.pressSequentially('H'); await input.press('Escape'); await expect(input).toHaveCount(0); await expect(label).toHaveText('0ABCDEFGH');
    expect(commands).toHaveLength(2); expect(commands[1]!.editGroup).toBe(commands[0]!.editGroup);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('0');
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(label).toHaveText('0ABCDEFGH');
  } finally { page.off('request', record); }
});

test('清空真实绑定文字宿主使用最新标签版本且历史移除目标保留标签输入', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'label-host-protected-card', 700, 400), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'label-deleted-text-host', content: { runs: [{ text: '文字宿主' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
      pose: { x: 220, y: 160, width: 160, height: 27 } } });
  const host = (await workspace.state()).texts![0]!;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-host-bound-line', path: 'curve', start: { kind: 'bound', itemId: host.item.id, side: 'right' }, end: { kind: 'bound', itemId: card.item.id, side: 'left' } } });
  const styled = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.style', expected: created.connectorVersions['label-host-bound-line'],
    payload: { id: 'label-host-bound-line', style: { startMarker: 'dot', endMarker: 'diamond', color: '#123456', width: 6, dash: 'dashed' } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: styled.connectorVersions['label-host-bound-line'],
    payload: { id: 'label-host-bound-line', label: { text: '原标签', position: 0.4, fontSize: 20, color: '#654321', bold: true } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const commands: import('../src/api').Command[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }), line = page.getByRole('button', { name: '普通连线', exact: true });
    await label.dblclick(); const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('最新确认的标签\n完整保留');
    await page.locator('.canvas-text-content').dblclick(); const textInput = page.getByRole('textbox', { name: '独立文字', exact: true }); await expect(textInput).toBeVisible(); await expect(input).toHaveCount(0);
    const before = await workspace.state(), incident = before.connectors![0]!, original = before.texts![0]!; expect(incident.label!.text).toBe('最新确认的标签\n完整保留');
    const deletedResponse = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'text.delete');
    await textInput.fill(''); await textInput.press('Escape'); expect((await deletedResponse).status()).toBe(200);
    await expect(textInput).toHaveCount(0); await expect(line).toHaveCount(0);
    expect(commands.filter(command => command.type === 'text.delete')).toEqual([expect.objectContaining({ expected: { text: original.versionId, pose: original.item.versionId, connectors: { [incident.id]: incident.versionId } }, payload: { id: original.id } })]);
    const deleted = await workspace.state(); expect(deleted.texts).toEqual([]); expect(deleted.connectors).toEqual([]); expect(deleted.cards).toEqual(before.cards);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('最新确认的标签\n完整保留'); await expect(page.locator('.canvas-text-content')).toHaveText('文字宿主');
    expect((await workspace.state()).connectors).toEqual([expect.objectContaining({ id: incident.id, path: incident.path, start: incident.start, end: incident.end, style: incident.style, label: incident.label })]);
    await label.dblclick(); await expect(input).toBeFocused(); await input.press('Control+y');
    const detached = page.getByRole('region', { name: '已移除连线的文字', exact: true }); await expect(detached).toBeVisible(); await expect(input).toHaveValue('最新确认的标签\n完整保留'); await expect(line).toHaveCount(0);
    expect(commands.filter(command => command.type === 'connector.label')).toHaveLength(1);
    await page.getByRole('button', { name: '保留草稿并结束', exact: true }).click(); await expect(input).toHaveCount(0);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('最新确认的标签\n完整保留');
    const restored = await workspace.state(); expect(restored.texts![0]).toMatchObject({ id: host.id, content: host.content, item: { id: host.item.id } });
    expect(restored.connectors![0]).toMatchObject({ id: incident.id, start: incident.start, end: incident.end, style: incident.style, label: incident.label }); expect(restored.cards).toEqual(before.cards);
  } finally { page.off('request', record); }
});

test('恢复标签读取当前版本且等待中新的文字编辑意图取消旧接管', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'newer-editor-intent', content: { runs: [{ text: '新的编辑目标' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
      pose: { x: 120, y: 120, width: 160, height: 27 } } });
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'fresh-recovery-label', start: { kind: 'free', point: { x: 220, y: 250 } }, end: { kind: 'free', point: { x: 660, y: 410 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['fresh-recovery-label'],
    payload: { id: 'fresh-recovery-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const attempts: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
  let release!: () => void, reading = false; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'connector.label') { await route.continue(); return; }
    attempts.push(command);
    if (attempts.length === 1) await workspace.execute(page, { ...command, commandId: crypto.randomUUID(), editGroup: undefined, payload: { id: command.payload.id, label: { ...command.payload.label, text: 'R' } } });
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('A'); await input.press('Escape');
    const comparison = page.getByRole('textbox', { name: '已保存的连线文字', exact: true }); await expect(comparison).toHaveValue('R');
    await page.getByRole('button', { name: '保留草稿并结束', exact: true }).click(); await expect(input).toHaveCount(0);
    const before = (await workspace.state()).connectors![0]!;
    const peer = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: before.versionId,
      payload: { id: before.id, label: { ...before.label!, text: 'R2' } } });
    await page.route('**/api/mapping/projects/*/map?**', async route => {
      if (reading) { await route.continue(); return; }
      reading = true; const response = await route.fetch(); await held; await route.fulfill({ response });
    });
    const recovery = page.getByRole('button', { name: '恢复连线文字', exact: true }); await recovery.click(); await expect.poll(() => reading).toBe(true);
    await page.locator('.canvas-text-content').dblclick(); const textInput = page.getByRole('textbox', { name: '独立文字', exact: true }); await expect(textInput).toBeFocused();
    const completedRead = page.waitForResponse(response => new URL(response.url()).searchParams.get('view') === 'connector-detail');
    release(); await (await completedRead).finished(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(input, '旧恢复读取完成不能抢走新的编辑上下文').toHaveCount(0); await expect(textInput).toBeFocused(); await expect(recovery).toBeVisible(); expect(attempts).toHaveLength(1);
    await textInput.press('Escape'); await expect(textInput).toHaveCount(0); await recovery.click();
    await expect(input).toHaveValue('A'); await expect(comparison, '比较应取恢复时的新版本').toHaveValue('R2'); expect(attempts).toHaveLength(1);
    await page.getByRole('button', { name: '确认保留我的文字', exact: true }).click(); await expect(input).toHaveCount(0);
    expect(attempts).toHaveLength(2); expect(attempts[1]!.expected).toBe(peer.connectorVersions[before.id]); expect(attempts[1]!.commandId).not.toBe(attempts[0]!.commandId);
    expect((await workspace.state()).connectors![0]!.label!.text).toBe('A');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('恢复独立文字先等待标签确认且失败保留双方原请求', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'label-before-text-recovery', content: { runs: [{ text: '独立基线' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 160 },
      pose: { x: 140, y: 140, width: 160, height: 27 } } });
  const host = (await workspace.state()).texts![0]!;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'text-recovery-bound-label', start: { kind: 'bound', itemId: host.item.id, side: 'right' }, end: { kind: 'free', point: { x: 720, y: 440 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['text-recovery-bound-label'],
    payload: { id: 'text-recovery-bound-label', label: { text: '标签基线', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let originalText: import('../src/api').Command | undefined, release!: () => void, allowLabel = false;
  const held = new Promise<void>(resolve => { release = resolve; }), labelAttempts: import('../src/api').Command[] = [], textRetries: import('../src/api').Command[] = [];
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'text.edit') { await route.continue(); return; }
    originalText = route.request().postDataJSON(); await route.fetch(); await route.abort('failed');
  });
  try {
    await page.locator('.canvas-text-content').dblclick();
    const textInput = page.getByRole('textbox', { name: '独立文字', exact: true }); await textInput.fill('文字A');
    await expect(page.getByRole('status')).toHaveText('文字保存未完成');
    page.once('dialog', dialog => void dialog.accept()); await page.reload(); await page.unrouteAll({ behavior: 'wait' });
    const recovery = page.getByRole('button', { name: '恢复独立文字草稿', exact: true }); await expect(recovery).toBeVisible();
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type === 'text.edit') textRetries.push(command);
      if (command.type !== 'connector.label') { await route.continue(); return; }
      labelAttempts.push(command);
      if (allowLabel) { await route.continue(); return; }
      await route.fetch(); await held; await route.abort('failed');
    });
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const labelInput = page.getByRole('textbox', { name: '连线文字', exact: true }); await labelInput.fill('标签B'); await expect.poll(() => labelAttempts.length).toBe(1);
    await recovery.click();
    await expect(textInput, '标签确认前不能恢复另一个输入上下文').toHaveCount(0);
    release(); await expect(page.getByRole('button', { name: '重试保存文字', exact: true })).toBeVisible();
    await expect(textInput).toHaveCount(0); await expect(labelInput).toHaveValue('标签B'); await expect(recovery).toBeVisible(); expect(textRetries).toEqual([]);
    allowLabel = true; await recovery.click();
    await expect(labelInput).toHaveCount(0); await expect(textInput).toHaveText('文字A');
    await expect.poll(() => textRetries.length).toBe(1); expect(textRetries).toEqual([originalText]); expect(labelAttempts).toHaveLength(2); expect(labelAttempts[1]).toEqual(labelAttempts[0]);
    await textInput.press('Escape'); await expect(textInput).toHaveCount(0); await expect(label).toHaveText('标签B');
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('恢复标签先等待独立文字确认失败不切换成功后原键恢复标签', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'text.create', expected: null,
    payload: { id: 'before-label-recovery', content: { runs: [{ text: '独立基线' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'auto', width: 320 },
      pose: { x: 140, y: 140, width: 160, height: 40 } } });
  const host = (await workspace.state()).texts![0]!;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'recovery-barrier-label', start: { kind: 'bound', itemId: host.item.id, side: 'right' }, end: { kind: 'free', point: { x: 720, y: 440 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['recovery-barrier-label'],
    payload: { id: 'recovery-barrier-label', label: { text: '标签基线', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let originalLabel: import('../src/api').Command | undefined, release!: () => void, allowText = false;
  const held = new Promise<void>(resolve => { release = resolve; }), textAttempts: import('../src/api').Command[] = [], labelRetries: import('../src/api').Command[] = [];
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'connector.label') { await route.continue(); return; }
    originalLabel = route.request().postDataJSON(); await route.fetch(); await route.abort('failed');
  });
  try {
    await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
    const labelInput = page.getByRole('textbox', { name: '连线文字', exact: true }); await labelInput.fill('A'); await labelInput.press('Escape');
    await expect(page.getByRole('button', { name: '重试保存文字', exact: true })).toBeVisible();
    page.once('dialog', dialog => void dialog.accept()); await page.reload(); await page.unrouteAll({ behavior: 'wait' });
    const recovery = page.getByRole('button', { name: '恢复连线文字', exact: true }); await expect(recovery).toBeVisible();
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type === 'connector.label') labelRetries.push(command);
      if (command.type !== 'text.edit') { await route.continue(); return; }
      textAttempts.push(command);
      if (allowText) { await route.continue(); return; }
      await route.fetch(); await held; await route.abort('failed');
    });
    await page.locator('.canvas-text-content').dblclick();
    const textInput = page.getByRole('textbox', { name: '独立文字', exact: true }); await textInput.fill('独立文字待保存'); await expect.poll(() => textAttempts.length).toBe(1);
    await recovery.click();
    await expect(labelInput, '保存屏障完成前不能打开第二个编辑器或退休标签恢复记录').toHaveCount(0);
    release(); await expect(page.getByRole('status')).toHaveText('文字保存未完成');
    await expect(labelInput).toHaveCount(0); await expect(textInput).toHaveText('独立文字待保存'); await expect(recovery).toBeVisible();
    allowText = true; await recovery.click();
    await expect(textInput).toHaveCount(0); await expect(labelInput).toHaveValue('A'); expect(textAttempts).toHaveLength(2); expect(textAttempts[1]).toEqual(textAttempts[0]);
    await page.getByRole('button', { name: '重试保存文字', exact: true }).click(); await expect(labelInput).toHaveCount(0);
    expect(labelRetries).toEqual([originalLabel]); expect((await workspace.state()).texts![0]!.content.runs).toEqual([{ text: '独立文字待保存' }]);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('标签冲突比较展示已保存版本的字号颜色粗体及路径位置差异', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-appearance-conflict', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['label-appearance-conflict'],
    payload: { id: 'label-appearance-conflict', label: { text: '共同文字', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const remote = { text: '共同文字', position: 0.8, fontSize: 24, color: '#123456', bold: true }; let attempts = 0;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'connector.label') { await route.continue(); return; }
    if (++attempts === 1) await workspace.execute(page, { ...command, commandId: crypto.randomUUID(), editGroup: undefined,
      payload: { id: command.payload.id, label: remote } });
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('我的新文字'); await input.press('Escape');
    const comparison = page.getByRole('textbox', { name: '已保存的连线文字', exact: true }); await expect(comparison).toHaveValue('共同文字');
    await expect(input).toHaveCSS('font-size', '16px');
    await expect(comparison, '比较不能把已保存的24px字体伪装成本地16px').toHaveCSS('font-size', '24px');
    await expect(comparison).toHaveCSS('color', 'rgb(18, 52, 86)'); await expect(comparison).toHaveCSS('font-weight', '700');
    await expect(page.getByText('路径位置：我的文字 50%；已保存 80%', { exact: true })).toBeVisible();
    expect(attempts).toBe(1);
    await page.getByRole('button', { name: '确认保留已保存的文字', exact: true }).click(); await expect(input).toHaveCount(0);
    expect((await workspace.state()).connectors![0]!.label).toEqual(remote);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('冲突保留我的最新文字只提交一次解决动作并持久保留已保存文字副本', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'mine-choice-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['mine-choice-label'],
    payload: { id: 'mine-choice-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const attempts: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
  let release!: () => void, confirm!: () => void, peerVersion = '';
  const held = new Promise<void>(resolve => { release = resolve; }), confirmation = new Promise<void>(resolve => { confirm = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'connector.label') { await route.continue(); return; }
    attempts.push(command);
    if (attempts.length === 1) {
      const receipt = await workspace.execute(page, { ...command, commandId: crypto.randomUUID(), editGroup: undefined,
        payload: { id: command.payload.id, label: { ...command.payload.label, text: 'R' } } });
      peerVersion = receipt.connectorVersions[command.payload.id]; await held; await route.continue();
    } else if (attempts.length === 2) {
      const response = await route.fetch(); await confirmation; await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('A'); await expect.poll(() => attempts.length).toBe(1);
    await input.press('Home'); await input.pressSequentially('B'); await input.press('End'); await input.pressSequentially('C'); await expect(input).toHaveValue('BAC');
    release(); const comparison = page.getByRole('textbox', { name: '已保存的连线文字', exact: true }); await expect(comparison).toHaveValue('R');
    await test.step('副本持久化失败时保留双方并禁止解决写入', async () => {
      const restoreStorage = await page.evaluateHandle(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (key.startsWith('forkwise:connector-label-recovery:')) throw new DOMException('副本保全夹具失败', 'QuotaExceededError');
          original.call(this, key, value);
        };
        return () => { Storage.prototype.setItem = original; };
      });
      try {
        await page.getByRole('button', { name: '确认保留我的文字', exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: '副本保全夹具失败' })).toBeVisible();
        await expect(input).toHaveValue('BAC'); await expect(comparison).toHaveValue('R'); expect(attempts).toHaveLength(1);
        expect((await workspace.state()).connectors![0]!.label!.text).toBe('R');
      } finally { await restoreStorage.evaluate(restore => restore()); await restoreStorage.dispose(); }
    });
    await page.getByRole('button', { name: '确认保留我的文字', exact: true }).click(); await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1]!.payload.label?.text, '明确解决应直接保存最新完整输入，不重放旧分组中间态').toBe('BAC');
    expect(attempts[1]!.expected).toBe(peerVersion); expect(attempts[1]!.commandId).not.toBe(attempts[0]!.commandId);
    await expect(page.getByRole('status')).not.toHaveText('已保存到本机'); confirm();
    await expect(input).toHaveCount(0); await expect(label).toHaveText('BAC'); expect(attempts).toHaveLength(2);
    const copy = page.getByRole('button', { name: '查看已保存文字副本', exact: true });
    await expect(copy, '覆盖前必须留下另一份可恢复文字').toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('R');
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(label).toHaveText('BAC');
    await page.reload(); await expect(copy).toBeVisible(); await expect(page.getByRole('status')).toHaveText('已保存到本机'); await copy.click();
    await expect(input).toHaveValue('R'); await expect(comparison).toHaveValue('BAC'); expect(attempts).toHaveLength(2);
    expect((await workspace.state()).connectors![0]!.label!.text).toBe('BAC');
    await page.getByRole('button', { name: '保留草稿并结束', exact: true }).click(); await expect(input).toHaveCount(0);
  } finally { release(); confirm(); await page.unrouteAll({ behavior: 'wait' }); }
});

test('冲突选择已保存文字前保全完整本地多组草稿且重开恢复不自动覆盖', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'remote-choice-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['remote-choice-label'],
    payload: { id: 'remote-choice-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const attempts: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'connector.label') { await route.continue(); return; }
    attempts.push(command);
    if (attempts.length === 1) {
      await workspace.execute(page, { ...command, commandId: crypto.randomUUID(), editGroup: undefined,
        payload: { id: command.payload.id, label: { ...command.payload.label, text: 'R' } } });
      await held;
    }
    await route.continue();
  });
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('A'); await expect.poll(() => attempts.length).toBe(1);
    await input.press('Home'); await input.pressSequentially('B'); await input.press('End'); await input.pressSequentially('C'); await expect(input).toHaveValue('BAC');
    release(); const comparison = page.getByRole('textbox', { name: '已保存的连线文字', exact: true }); await expect(comparison).toHaveValue('R');
    await page.getByRole('button', { name: '确认保留已保存的文字', exact: true }).click(); await expect(input).toHaveCount(0); await expect(label).toHaveText('R');
    const recovery = page.getByRole('button', { name: '恢复连线文字', exact: true });
    await expect(recovery, '明确选择对方版本前必须留下完整本地可恢复草稿').toBeVisible(); expect(attempts).toHaveLength(1);
    await page.reload(); await expect(recovery).toBeVisible(); await recovery.click();
    await expect(input).toHaveValue('BAC'); await expect(comparison).toHaveValue('R'); expect(attempts).toHaveLength(1);
    expect((await workspace.state()).connectors![0]!.label!.text).toBe('R');
    await page.getByRole('button', { name: '保留草稿并结束', exact: true }).click(); await expect(input).toHaveCount(0);
  } finally { release(); await page.unroute('**/api/mapping/execute'); }
});

test('未知保存恢复后保留原命令和多组草稿并把继续输入作为新撤销组', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'recovery-groups-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['recovery-groups-label'],
    payload: { id: 'recovery-groups-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const fixedTime = Date.now(); await page.clock.setFixedTime(fixedTime);
  const attempts: import('../src/api').Command[] = [], retried: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'connector.label') { await route.continue(); return; }
    attempts.push(route.request().postDataJSON()); await route.fetch(); await held; await route.abort('failed');
  });
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('A'); await expect.poll(() => attempts.length).toBe(1);
    await input.press('Home'); await input.pressSequentially('B'); await input.press('End'); await input.pressSequentially('C'); await expect(input).toHaveValue('BAC');
    release(); await expect(page.getByRole('button', { name: '重试保存文字', exact: true })).toBeVisible();
    page.once('dialog', dialog => void dialog.accept()); await page.reload(); await page.clock.setFixedTime(fixedTime);
    await page.unroute('**/api/mapping/execute');
    const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.label') retried.push(request.postDataJSON()); };
    page.on('request', record);
    try {
      await page.getByRole('button', { name: '恢复连线文字', exact: true }).click(); await expect(input).toHaveValue('BAC');
      const at = await input.evaluate(element => (element as HTMLTextAreaElement).selectionStart);
      const continued = 'BAC'.slice(0, at) + 'D' + 'BAC'.slice(at);
      // No cursor movement or time gap may accidentally supply the boundary.
      await input.pressSequentially('D'); await expect(input).toHaveValue(continued); await input.press('Escape');
      await expect(input).toHaveCount(0); await expect(label).toHaveText(continued); expect(retried[0]).toEqual(attempts[0]);
      for (const text of ['BAC', 'BA', 'A', '0']) {
        await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label, '恢复前完整草稿必须保有独立组').toHaveText(text);
      }
      expect(retried.map(command => command.payload.label?.text)).toEqual(['A', 'BA', 'BAC', continued]);
    } finally { page.off('request', record); }
  } finally { release(); await page.unroute('**/api/mapping/execute'); }
});

test('连续输入双次粘贴和删除按输入动作分别撤销且不依赖停顿分组', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'input-types-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['input-types-label'],
    payload: { id: 'input-types-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.clock.setFixedTime(Date.now());
  const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
  const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.press('End'); await input.pressSequentially('A');
  const paste = async (text: string) => input.evaluate((element, data) => {
    // Synthetic DOM paste boundary; do not access the system clipboard.
    const target = element as HTMLTextAreaElement, start = target.selectionStart, end = target.selectionEnd;
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertFromPaste', data }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(target, target.value.slice(0, start) + data + target.value.slice(end));
    target.setSelectionRange(start + data.length, start + data.length);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data }));
  }, text);
  await paste('P'); await expect(input).toHaveValue('0AP'); await paste('Q'); await expect(input).toHaveValue('0APQ');
  await input.pressSequentially('BC'); await expect(input).toHaveValue('0APQBC');
  await input.press('Backspace'); await input.press('Backspace'); await expect(input).toHaveValue('0APQ');
  await input.pressSequentially('D'); await expect(input).toHaveValue('0APQD'); await input.press('Escape'); await expect(input).toHaveCount(0);
  for (const expected of ['0APQ', '0APQBC', '0APQ', '0AP', '0A', '0']) {
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(label, '每次粘贴与输入类型变化应独立分组，连续同类按键合组').toHaveText(expected);
  }
});

test('标签历史结果未知时保留输入上下文并原键重试后恢复焦点不重复撤销', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'unknown-history-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['unknown-history-label'],
    payload: { id: 'unknown-history-label', label: { text: 'base', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
  const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('changed');
  await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.text).toBe('changed'); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const attempts: unknown[] = [];
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'history.undo') { await route.continue(); return; }
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) { await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  try {
    await input.press('Control+z'); await expect(page.getByRole('button', { name: '重试撤销', exact: true })).toBeVisible();
    await expect(input).toHaveValue('changed'); await expect(input).toBeFocused(); await expect(input).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: '保存文字', exact: true }), '未知历史结果确认前不能关闭原输入上下文').toBeDisabled();
    await input.press('Escape'); await expect(input).toHaveValue('changed');
    const applied = await workspace.state(); expect(applied.connectors![0]!.label!.text).toBe('base');
    await page.getByRole('button', { name: '重试撤销', exact: true }).click();
    await expect(input).toHaveValue('base'); await expect(input).toBeFocused();
    expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]); expect((await workspace.state()).project.revision).toBe(applied.project.revision);
    await input.pressSequentially('X'); await expect(input).toHaveValue('baseX'); await input.press('Escape');
    await expect(input).toHaveCount(0); await expect(label).toHaveText('baseX');
  } finally { await page.unroute('**/api/mapping/execute'); }
});

test('标签聚焦时撤销重做只走统一历史并保留编辑上下文和连续输入', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'history-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['history-label'],
    payload: { id: 'history-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
  const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('A');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const commands: string[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute')) commands.push(request.postDataJSON().type); };
  page.on('request', record);
  try {
    await input.press('Home'); await input.press('End'); await input.pressSequentially('B'); await input.press('Control+z');
    await expect.poll(() => commands.filter(type => type === 'history.undo').length, '输入框撤销必须提交一次统一history而非原生回退后另存').toBe(1);
    await expect(input).toHaveValue('A'); await expect(input).toBeFocused();
    await input.press('Meta+z'); await expect(input).toHaveValue('0'); await expect(input).toBeFocused();
    expect(commands.filter(type => type === 'history.undo')).toHaveLength(2);
    await input.press('Control+y'); await expect(input).toHaveValue('A'); await expect(input).toBeFocused();
    expect(commands.filter(type => type === 'history.redo')).toHaveLength(1);
    await input.pressSequentially('C'); await expect(input).toHaveValue('AC'); await input.press('Escape');
    await expect(input).toHaveCount(0); await expect(label).toHaveText('AC');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('A');
    expect((await workspace.state()).connectors).toHaveLength(1);
  } finally { page.off('request', record); }
});

test('IME组合期间不提交半成品且完整组合与前一段文字分别撤销', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'ime-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['ime-label'],
    payload: { id: 'ime-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let attempts = 0;
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.label') attempts++; };
  page.on('request', record);
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('A');
    await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.text).toBe('A'); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await page.waitForTimeout(1100);
    // Browser event seam only; native OS IME remains a separate acceptance check.
    await input.dispatchEvent('compositionstart', { data: '' }); await input.fill('A中文');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
    await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true, keyCode: 229 });
    await page.waitForTimeout(2100); await expect(input).toHaveValue('A中文'); expect(attempts).toBe(1);
    expect((await workspace.state()).connectors![0]!.label!.text).toBe('A');
    await input.dispatchEvent('compositionend', { data: '中文' }); await input.press('Meta+Enter');
    await expect(input).toHaveCount(0); await expect(label).toHaveText('A中文'); expect(attempts).toBe(2);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label, '一次完整IME组合应独立于前一编辑段撤销').toHaveText('A');
  } finally { page.off('request', record); }
});

test('旧回执等待中光标移动前后的完整输入分别撤销且连续输入不逐字拆组', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'group-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['group-label'],
    payload: { id: 'group-label', label: { text: '0', position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let attempts = 0, release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    if (route.request().postDataJSON().type !== 'connector.label') { await route.continue(); return; }
    attempts++;
    if (attempts === 1) { const response = await route.fetch(); await held; await route.fulfill({ response }); }
    else await route.continue();
  });
  try {
    const label = page.getByRole('button', { name: '连线文字', exact: true }); await label.dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('A');
    await expect.poll(() => attempts).toBe(1);
    await input.press('Home'); await input.pressSequentially('B'); await expect(input).toHaveValue('BA');
    await input.press('End'); await input.pressSequentially('CD'); await expect(input).toHaveValue('BACD');
    await input.press('Escape'); release(); await expect(input).toHaveCount(0); await expect(label).toHaveText('BACD');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label, '最后一个连续输入组撤销后应保留前一个光标位置的完整输入').toHaveText('BA');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('A');
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveText('0');
  } finally { release(); await page.unroute('**/api/mapping/execute'); }
});

test('编辑标签后外点另一条标签先保存原输入再切选所点连线', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, y] of [['leave-a', 180], ['leave-b', 340]] as const) {
    const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id, start: { kind: 'free', point: { x: 220, y } }, end: { kind: 'free', point: { x: 620, y } } } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions[id],
      payload: { id, label: { text: id, position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  }
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '连线文字', exact: true }).filter({ hasText: 'leave-a' }).dblclick();
  const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('外点前的新输入');
  await page.getByRole('button', { name: '连线文字', exact: true }).filter({ hasText: 'leave-b' }).click();
  await expect(input).toHaveCount(0);
  await expect(page.locator('.canvas-connector[data-connector-id="leave-b"]'), '保存结束后应选择用户点击的标签所属连线').toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.canvas-connector[data-connector-id="leave-a"]')).toHaveAttribute('aria-pressed', 'false');
  expect((await workspace.state()).connectors!.map(value => value.label!.text)).toEqual(['外点前的新输入', 'leave-b']);
});

test('Shift点击标签只切换一次连线多选且键盘激活仍可单选', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  for (const [id, y] of [['label-a', 180], ['label-b', 340]] as const) {
    const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id, start: { kind: 'free', point: { x: 220, y } }, end: { kind: 'free', point: { x: 620, y } } } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions[id],
      payload: { id, label: { text: id, position: 0.5, fontSize: 16, color: '#252933', bold: false } } });
  }
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const a = page.locator('.canvas-connector[data-connector-id="label-a"]'), b = page.locator('.canvas-connector[data-connector-id="label-b"]');
  const labelA = page.getByRole('button', { name: '连线文字', exact: true }).filter({ hasText: 'label-a' });
  const labelB = page.getByRole('button', { name: '连线文字', exact: true }).filter({ hasText: 'label-b' });
  await labelA.click(); await expect(a).toHaveAttribute('aria-pressed', 'true');
  await labelB.click({ modifiers: ['Shift'] });
  await expect(a).toHaveAttribute('aria-pressed', 'true'); await expect(b, 'Shift点击标签应加入多选且不被随后的click取消').toHaveAttribute('aria-pressed', 'true');
  await labelB.click({ modifiers: ['Shift'] }); await expect(b).toHaveAttribute('aria-pressed', 'false'); await expect(a).toHaveAttribute('aria-pressed', 'true');
  await labelB.focus(); await labelB.press('Enter'); await expect(b).toHaveAttribute('aria-pressed', 'true'); await expect(a).toHaveAttribute('aria-pressed', 'false');
});

test('超过默认预算的标签完整重开到真实工作台且详情分页不截断', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'large-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  const text = '大标签😀无损重开'.repeat(8000);
  expect(Buffer.byteLength(text)).toBeGreaterThan(131_072);
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['large-label'],
    payload: { id: 'large-label', label: { text, position: 0.4, fontSize: 16, color: '#252933', bold: false } } });
  const saved = (await workspace.state()).connectors![0]!;
  await workspace.restart();
  const pages: { snapshot: string; revision: number; bytes: number }[] = [];
  await page.route(/\/api\/mapping\/projects\/[^/]+\/map\?/, async route => {
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get('view') === 'connector-detail') {
      const body = await response.json(); pages.push({ snapshot: body.snapshot, revision: body.revision, bytes: body.bytes });
    }
    await route.fulfill({ response });
  });
  try {
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    await expect(page.getByRole('button', { name: '连线文字', exact: true })).toHaveText(text);
    expect((await workspace.state()).connectors).toEqual([saved]); expect(pages.length).toBeGreaterThan(1);
    expect(new Set(pages.map(value => value.snapshot)).size).toBe(1);
    expect(pages.every(value => value.bytes <= 131_072 && value.revision === (pages[0]!.revision))).toBe(true);
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
});

test('菜单添加多行纯文标签并保留结束且统一撤销重开和清空只移除标签', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'labeled-line', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const original = (await workspace.state()).connectors![0]!;
  const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
  await expect(page.getByRole('button', { name: '添加文字', exact: true }), '标签必须有可见菜单入口').toBeVisible();
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await expect(input).toBeFocused();
  await input.fill('<em>第一行</em>'); await input.press('End'); await input.press('Enter'); await input.pressSequentially('第二行');
  await expect(input).toHaveValue('<em>第一行</em>\n第二行'); await input.press('Escape');
  await expect(input).toHaveCount(0);
  const label = page.getByRole('button', { name: '连线文字', exact: true });
  await expect(label).toHaveText('<em>第一行</em>\n第二行'); await expect(label.locator('em')).toHaveCount(0);
  await expect(label).toHaveCSS('font-size', '16px');
  const saved = (await workspace.state()).connectors![0]!;
  expect(saved).toMatchObject({ start: original.start, end: original.end, style: original.style,
    label: { text: '<em>第一行</em>\n第二行', position: 0.5, fontSize: 16, bold: false } });
  for (const text of ['<em>第一行</em>\n', '<em>第一行</em>']) {
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect.poll(() => label.textContent()).toBe(text);
  }
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveCount(0); await expect(line).toHaveCount(1);
  for (const text of ['<em>第一行</em>', '<em>第一行</em>\n', saved.label!.text]) {
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect.poll(() => label.textContent()).toBe(text);
  }
  await workspace.restart(); await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect(label).toHaveText(saved.label!.text); await label.dblclick(); await expect(input).toBeFocused();
  await input.fill(''); await input.press('Control+Enter'); await expect(input).toHaveCount(0); await expect(label).toHaveCount(0);
  expect((await workspace.state()).connectors).toEqual([expect.objectContaining({ id: original.id, start: original.start, end: original.end, label: null })]);
  await expect(line).toHaveCount(1);
});

test('编辑中的连线被删除时保留完整草稿并可结束后撤销删除再明确恢复', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'deleted-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  let removed = false;
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type === 'connector.label' && !removed) {
      removed = true;
      await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.delete', expected: command.expected, payload: { id: command.payload.id } });
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '普通连线', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('删除也不能吞掉的完整输入'); await input.press('Escape');
    await expect.poll(async () => (await workspace.state()).connectors).toEqual([]);
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(0);
    await expect(input, '目标消失后仍需提供完整未确认输入').toHaveValue('删除也不能吞掉的完整输入');
    await expect(page.getByRole('button', { name: '保留草稿并结束', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '保留草稿并结束', exact: true }).click(); await expect(input).toHaveCount(0);
    await expect(page.getByRole('button', { name: '恢复连线文字', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '恢复连线文字', exact: true }).click(); await expect(input).toHaveValue('删除也不能吞掉的完整输入');
    await page.getByRole('button', { name: '确认保留我的文字', exact: true }).click();
    await expect(input).toHaveCount(0); await expect(page.getByRole('button', { name: '连线文字', exact: true })).toHaveText('删除也不能吞掉的完整输入');
    expect((await workspace.state()).connectors).toHaveLength(1);
  } finally { await page.unroute('**/api/mapping/execute'); }
});

test('标签版本冲突保留双方并只在明确选择我的文字后提交新版本', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'conflict-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['conflict-label'],
    payload: { id: 'conflict-label', label: { text: '共同起点', position: 0.3, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const attempts: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = []; let peerVersion = '';
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'connector.label') { await route.continue(); return; }
    attempts.push(command);
    if (attempts.length === 1) {
      const receipt = await workspace.execute(page, { ...command, commandId: crypto.randomUUID(), editGroup: undefined,
        payload: { id: command.payload.id, label: { ...command.payload.label, text: '对方已保存的文字' } } });
      peerVersion = receipt.connectorVersions[command.payload.id];
    }
    await route.continue();
  });
  try {
    await page.getByRole('button', { name: '连线文字', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('我的完整新输入'); await input.press('Escape');
    const comparison = page.getByRole('region', { name: '连线文字保存冲突', exact: true });
    await expect(comparison, '已知版本冲突必须保留双方供明确处理').toBeVisible();
    await expect(comparison.getByRole('textbox', { name: '已保存的连线文字', exact: true })).toHaveValue('对方已保存的文字');
    await expect(input).toHaveValue('我的完整新输入'); expect((await workspace.state()).connectors![0]!.label!.text).toBe('对方已保存的文字');
    expect(attempts).toHaveLength(1);
    await page.getByRole('button', { name: '确认保留我的文字', exact: true }).click();
    await expect(input).toHaveCount(0); await expect(page.getByRole('button', { name: '连线文字', exact: true })).toHaveText('我的完整新输入');
    expect(attempts).toHaveLength(2); expect(attempts[1]!.expected).toBe(peerVersion); expect(attempts[1]!.commandId).not.toBe(attempts[0]!.commandId);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByRole('button', { name: '连线文字', exact: true })).toHaveText('对方已保存的文字');
  } finally { await page.unroute('**/api/mapping/execute'); }
});

test('未知标签保存重开后恢复完整新输入并重试同一原命令再提交后续批次', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'recover-label', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const attempts: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = []; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'connector.label') { await route.continue(); return; }
    attempts.push(command);
    if (attempts.length === 1) { await route.fetch(); await held; }
    await route.abort('failed');
  });
  try {
    await page.getByRole('button', { name: '普通连线', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('已提交但回执未知');
    await expect.poll(() => attempts.length).toBe(1); await input.fill('旧回执之后仍要保留的新输入'); release();
    await expect(page.getByRole('button', { name: '重试保存文字', exact: true })).toBeVisible();
    page.once('dialog', dialog => void dialog.accept()); await page.reload();
    await expect(page.getByRole('button', { name: '恢复连线文字', exact: true }), '重开不能丢弃未确认的完整标签输入').toBeVisible();
    await expect(page.getByRole('status'), '有未确认的新标签输入时不能宣称全部已保存').toHaveText('连线文字草稿待处理');
    await page.unroute('**/api/mapping/execute');
    const retry: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = [];
    const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.label') retry.push(request.postDataJSON()); };
    page.on('request', record);
    try {
      await page.getByRole('button', { name: '恢复连线文字', exact: true }).click(); await expect(input).toHaveValue('旧回执之后仍要保留的新输入');
      await page.getByRole('button', { name: '重试保存文字', exact: true }).click();
      await expect(input).toHaveCount(0); await expect(page.getByRole('button', { name: '连线文字', exact: true })).toHaveText('旧回执之后仍要保留的新输入');
      expect(retry).toHaveLength(2); expect(retry[0]).toEqual(attempts[0]);
      expect(retry[1]!.commandId).not.toBe(attempts[0]!.commandId); expect(retry[1]!.expected).not.toBe(attempts[0]!.expected);
      expect((await workspace.state()).connectors![0]!.label!.text).toBe('旧回执之后仍要保留的新输入');
      await expect(page.getByRole('button', { name: '恢复连线文字', exact: true })).toHaveCount(0);
      await expect(page.getByRole('status')).toHaveText('已保存到本机');
    } finally { page.off('request', record); }
  } finally { release(); await page.unroute('**/api/mapping/execute'); }
});

test('标签沿真实曲线路径拖动只在松开保存一次并接入统一撤销', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'drag-label', path: 'curve', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 700, y: 540 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['drag-label'],
    payload: { id: 'drag-label', label: { text: '沿曲线移动', position: 0.25, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = (await workspace.state()).connectors![0]!, commands: unknown[] = [];
  const record = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/api/mapping/execute') && request.postDataJSON()?.type === 'connector.label') commands.push(request.postDataJSON()); };
  page.on('request', record);
  try {
    const path = page.getByRole('button', { name: '普通连线', exact: true }).locator('path');
    const target = await path.evaluate(element => { const p = element as SVGPathElement, q = p.getPointAtLength(p.getTotalLength() * 0.82), s = new DOMPoint(q.x, q.y).matrixTransform(p.getScreenCTM()!); return { x: s.x, y: s.y }; });
    const label = page.getByRole('button', { name: '连线文字', exact: true });
    const initialBox = (await label.boundingBox())!, historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
    const history = await (await page.request.get(historyUrl)).json();
    for (const cancel of ['Escape', 'lostpointercapture'] as const) await test.step(cancel + '取消标签预览且晚到松手不写入', async () => {
      await label.evaluate(element => element.addEventListener('pointerdown', event => { (element as HTMLElement).dataset.labelPointer = String(event.pointerId); }, { once: true }));
      await label.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 8 });
      const pointer = Number(await label.getAttribute('data-label-pointer'));
      expect(await label.evaluate((element, id) => element.hasPointerCapture(id), pointer)).toBe(true);
      if (cancel === 'Escape') await page.keyboard.press('Escape');
      else await label.evaluate((element, id) => {
        element.addEventListener('lostpointercapture', event => { (element as HTMLElement).dataset.labelLost = String(event.isTrusted); }, { once: true });
        element.releasePointerCapture(id);
      }, pointer);
      await page.mouse.move(target.x + 15, target.y + 15); await page.mouse.up();
      expect(await label.evaluate((element, id) => element.hasPointerCapture(id), pointer)).toBe(false);
      if (cancel === 'lostpointercapture') await expect(label).toHaveAttribute('data-label-lost', 'true');
      await expect.poll(async () => { const box = (await label.boundingBox())!; return Math.hypot(box.x - initialBox.x, box.y - initialBox.y); }).toBeLessThan(1);
      expect(commands).toHaveLength(0); expect((await workspace.state()).connectors![0]).toEqual(before);
      expect(await (await page.request.get(historyUrl)).json()).toEqual(history);
      await label.evaluate(element => { delete (element as HTMLElement).dataset.labelPointer; delete (element as HTMLElement).dataset.labelLost; });
    });
    await label.hover(); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 8 });
    await expect.poll(async () => { const box = await label.boundingBox(); return Math.hypot(box!.x + box!.width / 2 - target.x, box!.y + box!.height / 2 - target.y); }, { message: '拖动预览必须沿实际SVG曲线定位标签' }).toBeLessThan(2);
    expect(commands).toHaveLength(0); expect((await workspace.state()).connectors![0]).toEqual(before);
    await page.mouse.up(); await expect.poll(() => commands.length).toBe(1);
    await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.position).toBeGreaterThan(0.8);
    const after = (await workspace.state()).connectors![0]!;
    expect(after.label!.position).toBeLessThan(0.84); expect(after).toMatchObject({ start: before.start, end: before.end, path: before.path, style: before.style });
    expect(after.label).toMatchObject({ text: before.label!.text, fontSize: 16, color: '#252933', bold: false });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect.poll(async () => (await workspace.state()).connectors![0]!.label!.position).toBe(0.25);
  } finally { await page.mouse.up(); page.off('request', record); }
});

test('整段标签字号颜色粗体独立保存并一次撤销样式动作', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  const created = await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'label-style', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.label', expected: created.connectorVersions['label-style'],
    payload: { id: 'label-style', label: { text: '整段第一行\n整段第二行', position: 0.3, fontSize: 16, color: '#252933', bold: false } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button', { name: '普通连线', exact: true }).click();
  const size = page.getByRole('combobox', { name: '标签字号', exact: true });
  await expect(size, '标签需要整段字号入口').toBeVisible(); await size.selectOption('24');
  const label = page.getByRole('button', { name: '连线文字', exact: true }); await expect(label).toHaveCSS('font-size', '24px');
  await page.getByRole('button', { name: '标签粗体', exact: true }).click(); await expect(label).toHaveCSS('font-weight', '700');
  await page.getByLabel('标签颜色', { exact: true }).fill('#2468ac'); await expect(label).toHaveCSS('color', 'rgb(36, 104, 172)');
  await expect(label).toHaveText('整段第一行\n整段第二行');
  expect((await workspace.state()).connectors![0]!.label).toEqual({ text: '整段第一行\n整段第二行', position: 0.3, fontSize: 24, color: '#2468ac', bold: true });
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await expect(label).toHaveCSS('color', 'rgb(37, 41, 51)');
  await expect(label).toHaveCSS('font-size', '24px'); await expect(label).toHaveCSS('font-weight', '700');
  await workspace.restart(); await page.reload(); await expect(label).toHaveText('整段第一行\n整段第二行'); await expect(label).toHaveCSS('font-size', '24px');
});

test('标签外点先保存再切换路径和卡片且绑定曲线随对象移动', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'label-host', 130, 150), projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'bound-label', start: { kind: 'bound', itemId: card.item.id, side: 'right' }, end: { kind: 'free', point: { x: 780, y: 390 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const line = page.getByRole('button', { name: '普通连线', exact: true }); await line.click();
  await page.getByLabel('线条颜色', { exact: true }).fill('#123456'); await expect(line.locator('path')).toHaveCSS('stroke', 'rgb(18, 52, 86)');
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await input.fill('路径切换前的输入');
  await page.getByRole('button', { name: '曲线', exact: true }).click();
  await expect(input, '路径动作应先保留并结束标签编辑').toHaveCount(0);
  const label = page.getByRole('button', { name: '连线文字', exact: true }); await expect(label).toHaveText('路径切换前的输入');
  await expect.poll(async () => (await workspace.state()).connectors![0]!.path).toBe('curve');
  await label.dblclick(); await input.fill('点击卡片前的输入');
  const box = await connectorSurfaceBox(page, card.item.id);
  await page.mouse.click(box.x + 80, box.y + box.height - 12);
  await expect(input).toHaveCount(0); await expect(label).toHaveText('点击卡片前的输入');
  await expect(page.locator('.react-flow__node[data-id="' + card.item.id + '"]')).toHaveClass(/selected/);
  const before = (await workspace.state()).connectors![0]!;
  expect(before).toMatchObject({ start: { kind: 'bound', itemId: card.item.id, side: 'right' }, style: { color: '#123456' }, path: 'curve' });
  const labelCenter = async () => { const b = await label.boundingBox(); return { x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }; };
  const pathCenter = () => line.locator('path').evaluate(element => { const p = element as SVGPathElement, q = p.getPointAtLength(p.getTotalLength() / 2), s = new DOMPoint(q.x, q.y).matrixTransform(p.getScreenCTM()!); return { x: s.x, y: s.y }; });
  const initial = await labelCenter();
  await page.keyboard.down('Alt'); await page.mouse.move(box.x + 80, box.y + box.height - 12); await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + box.height + 68, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await expect.poll(async () => (await labelCenter()).x).not.toBe(initial.x);
  const actual = await labelCenter(), expected = await pathCenter(); expect(actual.x).toBeCloseTo(expected.x, 0); expect(actual.y).toBeCloseTo(expected.y, 0);
  expect((await workspace.state()).connectors![0]).toEqual(before);
});

test('标签自动保存保留晚于旧回执的新输入且一个连续编辑组只撤销一次', async ({ page, workspace }) => {
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'autosave-line', start: { kind: 'free', point: { x: 220, y: 220 } }, end: { kind: 'free', point: { x: 620, y: 360 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const historyUrl = workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history';
  const beforeHistory = await (await page.request.get(historyUrl)).json();
  const commands: Extract<import('../src/api').Command, { type: 'connector.label' }>[] = []; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/mapping/execute', async route => {
    const command = route.request().postDataJSON();
    if (command.type !== 'connector.label') { await route.continue(); return; }
    commands.push(command); const response = await route.fetch();
    if (commands.length === 1) await held;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '普通连线', exact: true }).dblclick();
    const input = page.getByRole('textbox', { name: '连线文字', exact: true }); await expect(input).toBeFocused();
    await input.fill('前批');
    await expect.poll(() => commands.length, { message: '标签停输后应自动提交而不必结束编辑' }).toBe(1);
    await expect(page.getByRole('status')).not.toHaveText('已保存到本机');
    await expect(input).toBeEditable(); await input.fill('前批之后的新输入'); release();
    await expect.poll(async () => (await workspace.state()).connectors![0]!.label?.text).toBe('前批之后的新输入');
    await expect(input).toHaveValue('前批之后的新输入'); await expect(input).toBeFocused();
    await input.press('Escape'); await expect(input).toHaveCount(0);
    expect(commands).toHaveLength(2); expect(commands[1].editGroup).toBe(commands[0].editGroup); expect(commands[0].editGroup).toBeTruthy();
    expect(commands[1].expected).not.toBe(commands[0].expected);
    expect((await (await page.request.get(historyUrl)).json()).undo).toHaveLength(beforeHistory.undo.length + 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await expect(page.getByRole('button', { name: '连线文字', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '普通连线', exact: true })).toHaveCount(1);
  } finally { release(); await page.unroute('**/api/mapping/execute'); }
});
