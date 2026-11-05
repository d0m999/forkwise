import { test, expect } from './writing-board-fixture';
import { createFrameCommand } from '../../backend/tests/nested-frame-fixture';

for (const kind of ['thought', 'shape', 'stroke', 'text', 'image'] as const) {
  test(`${kind}创建空间冲突可明确放弃并重新创建，未知结果仍原请求重试`, async ({ page, workspace }) => {
    const field = kind === 'thought' ? 'cards' : `${kind}s` as 'shapes' | 'strokes' | 'texts' | 'images';
    const attempts: { command: any; status: number }[] = [];
    const assets: any[] = [];
    const retryName = kind === 'text' ? '重试文字保存' : kind === 'image' ? '重试图片保存' : '重试保存';
    const abandonName = kind === 'image' ? '取消图片导入' : kind === 'text' ? '放弃本次文字创建' : '放弃本次创建';
    const create = async () => {
      if (kind === 'image') {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: '图片', exact: true }).click();
        await (await chooser).setFiles({ name: '空间冲突.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="green"/></svg>') });
      } else if (kind === 'stroke') {
        await page.getByRole('button', { name: '画笔', exact: true }).click();
        await page.getByRole('menuitem', { name: '普通笔', exact: true }).click();
        const box = (await page.locator('.react-flow').boundingBox())!;
        await page.mouse.move(box.x + 300, box.y + 300); await page.mouse.down();
        await page.mouse.move(box.x + 340, box.y + 320, { steps: 3 }); await page.mouse.up();
      } else {
        await page.getByRole('button', { name: kind === 'thought' ? '卡片' : kind === 'shape' ? '形状' : '文字', exact: true }).click();
        if (kind === 'shape') await page.getByRole('menuitem', { name: '矩形', exact: true }).click();
        await page.locator('.react-flow__pane').click({ position: { x: 300, y: 300 } });
      }
    };
    await page.route('**/api/mapping/execute', async route => {
      const command = route.request().postDataJSON();
      if (command.type === 'asset.save') assets.push(command);
      if (command.type !== `${kind}.create`) return route.continue();
      if (!attempts.length) {
        attempts.push({ command, status: 503 });
        return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: '创建结果未知' } });
      }
      if (attempts.length === 1) await workspace.execute(page, createFrameCommand(await workspace.state(), [], { x: 1200, y: 800, width: 200, height: 120 }));
      const response = await route.fetch(); attempts.push({ command, status: response.status() });
      if (attempts.length === 3 && response.ok()) return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: '已创建但ACK未送达' } });
      return route.fulfill({ response });
    });
    try {
      await create();
      await expect(page.getByRole('alert').filter({ hasText: '创建结果未知' }).first()).toBeVisible();
      expect((await workspace.state())[field]).toEqual([]);
      if (kind === 'image') await expect(page.getByRole('button', { name: abandonName, exact: true })).toBeDisabled();
      else await expect(page.getByRole('button', { name: abandonName, exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: retryName, exact: true }).click();
      await expect.poll(() => attempts.length).toBe(2);
      expect(attempts[1]!.command).toEqual(attempts[0]!.command);
      expect(attempts[1]!.status).toBe(409);
      expect((await workspace.state())[field]).toEqual([]);
      const abandon = page.getByRole('button', { name: abandonName, exact: true });
      await expect(abandon).toBeEnabled({ timeout: 3000 });
      if (kind === 'text' || kind === 'image') {
        let refused = false;
        await page.route('**/api/mapping/projects/*/map?**', async route => {
          if (!refused && new URL(route.request().url()).searchParams.get('view') === 'index') {
            refused = true; return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: '刷新暂时失败' } });
          }
          return route.continue();
        });
        await abandon.click();
        await expect.poll(() => refused).toBe(true);
        await expect(abandon).toBeEnabled();
        expect((await workspace.state())[field]).toEqual([]);
        expect(attempts).toHaveLength(2);
        await expect(page.getByRole('button', { name: retryName, exact: true })).toBeVisible();
      }
      await abandon.click();
      await expect(page.getByRole('button', { name: retryName, exact: true })).toHaveCount(0);
      if (kind === 'stroke') await expect(page.getByRole('img', { name: '笔迹预览', exact: true })).toHaveCount(0);
      if (kind === 'image') {
        const asset = await page.request.get(`${workspace.origin}/api/mapping/projects/${assets[0].projectId}/assets/${assets[0].payload.id}`);
        expect(asset.status()).toBe(200);
      }
      await create();
      await expect.poll(async () => (await workspace.state())[field]?.length).toBe(1);
      await expect(page.getByRole('alert').filter({ hasText: '已创建但ACK未送达' }).first()).toBeVisible();
      if (kind === 'image') await expect(page.getByRole('button', { name: abandonName, exact: true })).toBeDisabled();
      else await expect(page.getByRole('button', { name: abandonName, exact: true })).toHaveCount(0);
      expect(attempts[2]!.status).toBe(200);
      expect(attempts[2]!.command.commandId).not.toBe(attempts[0]!.command.commandId);
      const committed = (await workspace.state())[field];
      await page.getByRole('button', { name: retryName, exact: true }).click();
      await expect.poll(() => attempts.length).toBe(4);
      await expect(page.getByRole('button', { name: retryName, exact: true })).toHaveCount(0);
      expect(attempts[3]!.command).toEqual(attempts[2]!.command);
      const confirmed = (await workspace.state())[field];
      if (kind === 'thought') {
        expect(confirmed).toHaveLength(1);
        expect(confirmed![0]).toMatchObject({ id: committed![0]!.id, ...('title' in committed![0]! ? { title: committed![0]!.title, body: committed![0]!.body } : {}),
          item: { id: committed![0]!.item.id, pose: { x: committed![0]!.item.pose.x, y: committed![0]!.item.pose.y } } });
      } else expect(confirmed).toEqual(committed);
      const history = await (await page.request.get(`${workspace.origin}/api/mapping/projects/${attempts[0]!.command.projectId}/history`)).json();
      expect(history.undo.filter((action: any) => action.label === `${kind}.create`)).toHaveLength(1);
    } finally { await page.unrouteAll({ behavior: 'wait' }); }
  });
}
