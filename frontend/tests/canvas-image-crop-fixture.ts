import type { Page } from '@playwright/test';
import { expect, type Workspace } from './writing-board-fixture';
import type { CanvasImage } from '../../backend/src/mapping/image-contracts';
export async function seedCrop(page: Page, workspace: Workspace, options: { crop?: CanvasImage['content']['crop']; pose?: CanvasImage['item']['pose'] } = {}) {
  const projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="blue"/><rect x="100" y="75" width="200" height="150" fill="green"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'crop-original', name: '裁剪交互.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'crop-image', content: { assetId: 'crop-original', crop: options.crop ?? { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } },
      pose: options.pose ?? { x: 200, y: 155, width: 200, height: 150, rotation: 0 } } });
  await page.reload();
  const history = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/history`)).json();
  const asset = async () => (await page.request.get(`${workspace.origin}/api/mapping/projects/${projectId}/assets/crop-original/content`)).body();
  const visual = page.getByRole('img', { name: '裁剪交互.svg', exact: true });
  const enter = async () => {
    await visual.click();
    await page.getByRole('toolbar', { name: '图片操作', exact: true }).getByRole('button', { name: '裁剪', exact: true }).click();
    const crop = page.getByRole('region', { name: '图片裁剪', exact: true });
    await expect(crop).toBeVisible(); return crop;
  };
  return { projectId, source, history, asset, visual, enter };
}
