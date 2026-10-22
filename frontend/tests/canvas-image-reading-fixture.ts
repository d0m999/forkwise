import type { Page } from '@playwright/test';
import type { Workspace } from './writing-board-fixture';
export async function croppedCanvasImage(page: Page, workspace: Workspace) {
  const projectId = (await workspace.state()).project.id;
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="300" height="800" fill="#0000ff"/><rect x="300" width="300" height="800" fill="#00ff00"/><rect x="600" width="300" height="800" fill="#ff0000"/><rect x="900" width="300" height="800" fill="#ffff00"/></svg>';
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'asset.save', expected: null,
    payload: { id: 'crop-original', name: '已裁剪拉伸.svg', mime: 'image/svg+xml', base64: Buffer.from(source).toString('base64') } });
  await workspace.execute(page, { commandId: crypto.randomUUID(), projectId, type: 'image.create', expected: null,
    payload: { id: 'cropped-image', content: { assetId: 'crop-original', crop: { x: 0.25, y: 0.125, width: 0.5, height: 0.5 } },
      pose: { x: 350, y: 280, width: 320, height: 120, rotation: 0 } } });
  await page.reload();
  return { projectId, source, image: (await workspace.state()).images![0]! };
}
