import { createCanvas } from '../../backend/node_modules/@napi-rs/canvas/index.js';
import type { Page } from '@playwright/test';
import { createFrameCommand, createFrameSelectionCommand } from '../src/canvas-frame-commands';
import { place, type Workspace } from './writing-board-fixture';

export async function seedCanvasExportSample(page: Page, workspace: Workspace) {
  await place(page, '底层研究卡', 100, 180);
  await place(page, '上层研究卡', 220, 290);
  let state = await workspace.state();
  const projectId = state.project.id;
  const bottom = state.cards.find(card => card.title === '底层研究卡')!;
  const top = state.cards.find(card => card.title === '上层研究卡')!;
  const surface = createCanvas(80, 60);
  const context = surface.getContext('2d');
  context.fillStyle = '#22c55e';
  context.fillRect(0, 0, 80, 60);
  context.fillStyle = '#166534';
  context.fillRect(12, 12, 28, 24);
  const imageBase64 = surface.toBuffer('image/png').toString('base64');
  const execute = (command: Record<string, unknown>) => workspace.execute(page, { commandId: crypto.randomUUID(), projectId, ...command });

  await execute({ type: 'asset.save', expected: null, payload: { id: 'export-image', name: '绿色媒体.png', mime: 'image/png', base64: imageBase64 } });
  await execute({ type: 'asset.save', expected: null, payload: { id: 'export-file', name: '财报原件.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.4\n').toString('base64'), kind: 'file' } });
  await execute({ type: 'body.edit', expected: bottom.body.versionId, payload: { id: bottom.id, requiredAssetIds: ['export-image'], blocks: [
    { id: 'long-text', type: 'text', text: '这是已保存的长正文，包含研究背景、证据解释以及需要继续观察的条件。'.repeat(4) },
    { id: 'body-image', type: 'image', assetId: 'export-image', name: '绿色媒体.png', mime: 'image/png', naturalWidth: 80, naturalHeight: 60, caption: '绿色媒体图注', alt: '绿色几何媒体' },
  ] } });
  await execute({ type: 'card.attachment.add', expected: { attachments: null }, payload: { id: bottom.id, assetId: 'export-file', name: '财报原件.pdf' } });
  let cardTagsVersion: string | null = null;
  for (const [id, name] of [
    ['export-tag', '核心观察'],
    ['export-tag-capex', '卡面省略的资本开支标签'],
    ['export-tag-margin', '卡面省略的毛利率标签'],
    ['export-tag-inventory', '卡面省略的库存周期标签'],
  ] as const) {
    await execute({ type: 'tag.create', expected: { cardTags: cardTagsVersion }, payload: { id, name, cardId: bottom.id } });
    state = await workspace.state();
    cardTagsVersion = state.cards.find(card => card.id === bottom.id)!.cardTags!.versionId;
  }
  await execute({ type: 'card.appearance', expected: bottom.appearance?.versionId ?? null, payload: { id: bottom.id, titleColor: '#f3dfe5', showPreview: true } });
  await execute({ type: 'card.appearance', expected: top.appearance?.versionId ?? null, payload: { id: top.id, titleColor: '#dceee2', showPreview: true } });
  await execute({ type: 'text.create', expected: null, payload: { id: 'export-annotation', content: { runs: [{ text: '附着批注' }], fontSize: 18, lineHeight: 1.5, align: 'left', widthMode: 'fixed', width: 150 }, pose: { x: 800, y: 130, width: 150, height: 54 } } });
  await execute({ type: 'image.create', expected: null, payload: { id: 'export-independent-image', content: { assetId: 'export-image', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: { x: 560, y: 200, width: 120, height: 90, rotation: 0 } } });

  state = await workspace.state();
  const annotation = state.texts!.find(value => value.id === 'export-annotation')!;
  const independentImage = state.images!.find(value => value.id === 'export-independent-image')!;
  const outer = createFrameCommand(state, [bottom.item.id, top.item.id, independentImage.item.id], { x: 60, y: 100, width: 700, height: 520 });
  await workspace.execute(page, outer);
  state = await workspace.state();
  const inner = createFrameSelectionCommand(state, { targets: [{ kind: 'item', itemId: top.item.id }], enteredGroupId: null })!;
  await workspace.execute(page, inner);
  state = await workspace.state();
  const attachmentTarget = state.cards.find(card => card.id === bottom.id)!;
  await execute({ type: 'attachment.attach', expected: { attachment: null, target: { itemId: attachmentTarget.item.id, versionId: attachmentTarget.item.versionId }, containment: null }, payload: { itemId: annotation.item.id, targetItemId: bottom.item.id } });
  await execute({ type: 'connector.create', expected: null, payload: { id: 'export-connector', start: { kind: 'bound', itemId: bottom.item.id, side: 'right' }, end: { kind: 'bound', itemId: top.item.id, side: 'left' }, path: 'straight' } });
  state = await workspace.state();
  await execute({ type: 'connector.label', expected: state.connectors![0]!.versionId, payload: { id: 'export-connector', label: { text: '后续观察', position: 0.5, fontSize: 16, color: '#626e81', bold: false } } });

  await page.reload();
  await page.getByRole('status').filter({ hasText: '已保存到本机' }).waitFor();
  state = await workspace.state();
  return { state, bottom: state.cards.find(card => card.id === bottom.id)!, top, annotation, independentImage, outerId: outer.payload.id, innerId: inner.payload.id };
}
