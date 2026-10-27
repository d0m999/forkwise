import { test, expect } from './writing-board-fixture';
import type { Command } from '../../backend/src/mapping/contracts';
import { connectorSvgEnds, seedConnectorCard } from './connector-ui-fixture';
import { seedCrop } from './canvas-image-crop-fixture';

for (const target of ['卡片', '形状', '图片', '笔迹', '文字键盘', '空白画布'] as const) {
  test(`键盘移动连线后点击${target}取消草稿且可重新编辑`, async ({ page, workspace }) => {
    const card = await seedConnectorCard(page, workspace, 'deselect-card', 850, 90);
    const projectId = (await workspace.state()).project.id;
    if (target === '形状') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId,
      type: 'shape.create', expected: null, payload: { id: 'deselect-shape', content: {
        shapeType: 'rectangle', shortText: '取消连线选择的形状', fill: '#dce8dd', stroke: '#403b36', strokeWidth: 2,
      }, pose: { x: 850, y: 360, width: 200, height: 100 } } });
    if (target === '图片') await seedCrop(page, workspace, { pose: { x: 850, y: 360, width: 200, height: 150, rotation: 0 } });
    if (target === '笔迹') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId,
      type: 'stroke.create', expected: null, payload: { id: 'deselect-stroke', content: {
        penKind: 'pen', path: [{ x: 0, y: 0 }, { x: 180, y: 50 }], color: '#403b36', width: 4, opacity: 1,
      }, pose: { x: 850, y: 360, width: 180, height: 50 } } });
    if (target === '文字键盘') await workspace.execute(page, { commandId: crypto.randomUUID(), projectId,
      type: 'text.create', expected: null, payload: { id: 'deselect-text', content: {
        runs: [{ text: '取消连线选择的文字' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 190,
      }, pose: { x: 850, y: 360, width: 190, height: 27 } } });
    await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
      payload: { id: 'deselect-line', path: 'straight', start: { kind: 'free', point: { x: 200, y: 400 } },
        end: { kind: 'free', point: { x: 500, y: 500 } } } });
    await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
    const before = await workspace.state(), original = before.connectors![0]!;
    const history = async () => {
      const response = await page.request.get(workspace.origin + '/api/mapping/projects/' + encodeURIComponent(projectId) + '/history');
      expect(response.status()).toBe(200); return await response.json();
    };
    const beforeHistory = await history(), commands: Command[] = [];
    const record = (request: import('@playwright/test').Request) => {
      if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST') commands.push(request.postDataJSON());
    };
    const line = page.getByRole('button', { name: '普通连线', exact: true });
    const move = page.getByRole('button', { name: '移动连线', exact: true });
    const preview = page.getByRole('img', { name: '连线预览', exact: true });
    page.on('request', record);
    try {
      await line.focus(); await page.keyboard.press('Enter'); await expect(line).toHaveAttribute('aria-pressed', 'true');
      const initial = await connectorSvgEnds(line.locator('path'));
      await move.focus(); await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
      await expect(preview).toBeVisible();
      expect(await connectorSvgEnds(preview.locator('path'))).not.toEqual(initial);
      if (target === '卡片') await page.locator(`.react-flow__node[data-id="${card.item.id}"] article.thought-card`).click();
      else if (target === '形状') await page.getByRole('img', { name: '取消连线选择的形状', exact: true }).click();
      else if (target === '图片') await page.getByRole('img', { name: '裁剪交互.svg', exact: true }).click();
      else if (target === '笔迹') await page.locator('.react-flow__node-canvasStroke path[aria-hidden="true"]').click();
      else if (target === '文字键盘') {
        await page.getByRole('group', { name: '独立文字：方向键调整位置，Enter编辑', exact: true }).focus();
        await page.keyboard.press('Enter');
      }
      else {
        const pane = page.locator('.react-flow__pane');
        const blank = await pane.evaluate(element => {
          const box = element.getBoundingClientRect();
          const oldHit = document.elementFromPoint(box.left + 650, box.top + 650);
          for (const y of [24, box.height / 2, box.height - 24]) for (const x of [24, box.width / 2, box.width - 24]) {
            const screenX = box.left + x, screenY = box.top + y;
            if (x <= 0 || y <= 0 || screenX < 0 || screenY < 0 || screenX >= innerWidth || screenY >= innerHeight) continue;
            if (document.elementFromPoint(screenX, screenY) === element) return { position: { x, y }, screen: { x: screenX, y: screenY },
              hitClass: element.className, oldPointHitClass: oldHit?.getAttribute('class') ?? null,
              oldPointInsideConnectorTools: !!oldHit?.closest('.creation-tools.connector-tools') };
          }
          throw new Error('当前视口没有可真实点击且未被控件遮挡的空白pane位置');
        });
        console.log('issue27-deselect-visible-pane-hit', JSON.stringify(blank));
        await pane.click({ position: blank.position });
      }
      await expect(line).toHaveAttribute('aria-pressed', 'false');
      await expect(preview).toHaveCount(0); await expect(move).toHaveCount(0);
      if (target === '形状') await expect(page.getByRole('img', { name: '取消连线选择的形状', exact: true })).toBeFocused();
      if (target === '图片') await expect(page.getByRole('img', { name: '裁剪交互.svg', exact: true })).toBeFocused();
      if (target === '笔迹') await expect(page.getByRole('button', { name: '选择普通笔笔迹', exact: true })).toBeFocused();
      if (target === '文字键盘') await expect(page.getByRole('textbox', { name: '独立文字', exact: true })).toBeFocused();
      expect(commands).toHaveLength(0); expect(await workspace.state()).toEqual(before); expect(await history()).toEqual(beforeHistory);

      await line.focus(); await page.keyboard.press('Enter'); await expect(line).toHaveAttribute('aria-pressed', 'true');
      await expect(move).toBeEnabled(); await move.focus(); await page.keyboard.press('Enter');
      await page.keyboard.press('ArrowRight');
      const saved = page.waitForResponse(response => response.url().endsWith('/api/mapping/execute') && response.request().postDataJSON()?.type === 'connector.move');
      await page.keyboard.press('Enter'); expect((await saved).status()).toBe(200);
      await expect(preview).toHaveCount(0); await expect(line).toBeFocused();
      expect(commands).toEqual([expect.objectContaining({ type: 'connector.move', expected: original.versionId,
        payload: { id: original.id, dx: 10, dy: 0 } })]);
      const after = await workspace.state();
      expect(after.connectors).toEqual([expect.objectContaining({ id: original.id, path: original.path,
        start: { kind: 'free', point: { x: 210, y: 400 } }, end: { kind: 'free', point: { x: 510, y: 500 } } })]);
      expect(after.cards).toEqual(before.cards);
      expect((await history()).undo).toHaveLength(beforeHistory.undo.length + 1);
    } finally { page.off('request', record); }
  });
}

test('搜索定位卡片取消连线键盘草稿且不提交连线变化', async ({ page, workspace }) => {
  const card = await seedConnectorCard(page, workspace, 'search-deselect-card', 850, 90);
  const projectId = (await workspace.state()).project.id;
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'connector.create', expected: null,
    payload: { id: 'search-deselect-line', path: 'straight', start: { kind: 'free', point: { x: 200, y: 400 } },
      end: { kind: 'free', point: { x: 500, y: 500 } } } });
  await page.reload(); await expect(page.getByRole('status')).toHaveText('已保存到本机');
  const before = await workspace.state(), commands: Command[] = [];
  const record = (request: import('@playwright/test').Request) => {
    if (request.url().endsWith('/api/mapping/execute') && request.method() === 'POST' &&
      request.postDataJSON()?.type.startsWith('connector.')) commands.push(request.postDataJSON());
  };
  page.on('request', record);
  try {
    const line = page.getByRole('button', { name: '普通连线', exact: true });
    await line.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: '移动连线', exact: true }).focus();
    await page.keyboard.press('Enter'); await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('img', { name: '连线预览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '搜索当前项目卡片', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '搜索当前项目卡片', exact: true });
    await dialog.getByRole('searchbox', { name: '关键词', exact: true }).fill('连线的卡片');
    await dialog.getByRole('button', { name: '在画布中打开', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator(`.react-flow__node[data-id="${card.item.id}"]`)).toHaveClass(/selected/);
    await expect(line).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('img', { name: '连线预览', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '移动连线', exact: true })).toHaveCount(0);
    expect(commands).toHaveLength(0);
    const after = await workspace.state();
    expect(after.connectors).toEqual(before.connectors); expect(after.cards).toEqual(before.cards);
  } finally { page.off('request', record); }
});
