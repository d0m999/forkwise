import { expect, it } from 'vitest';
import type { ProjectState } from './api';
import { clipboardLibrary, parseClipboard, pastePlan, restoredCopyRefs } from './canvas-snapshot';

const pose = { x: 10, y: 20, width: 280, height: 160 };
const imagePose = { x: 320, y: 20, width: 60, height: 40, rotation: 0 as const };

it('剪贴板带上卡片和图片引用的标签与媒体，粘贴命令把这份材料交给目标项目', () => {
  const document = parseClipboard(JSON.stringify({
    kind: 'forkwise-canvas-snapshot', version: 1,
    objects: [
      {
        kind: 'card', sourceId: 'source-card', itemId: 'item-1', stack: 1, title: '市场观察',
        blocks: [
          { id: 'words', type: 'text', text: '需求增长' },
          { id: 'pic', type: 'image', assetId: 'src-asset', name: '图.png', mime: 'image/png', naturalWidth: 2, naturalHeight: 3 },
        ],
        tagIds: ['src-defi', 'src-ai'], appearance: null, pose,
      },
      {
        kind: 'image', sourceId: 'source-image', itemId: 'item-2', stack: 2,
        content: { assetId: 'src-asset', crop: { x: 0, y: 0, width: 1, height: 1 } }, pose: imagePose,
      },
    ],
    connectors: [],
  }));
  const state = {
    tags: [
      { id: 'src-ai', name: 'AI', color: '#f8dfc4', deleted: false, versionId: 'v1' },
      { id: 'src-defi', name: 'DeFi', color: '#f8dfc4', deleted: false, versionId: 'v2' },
      { id: 'other', name: '其他', color: '#f1f0ec', deleted: false, versionId: 'v3' },
    ],
  } as ProjectState;
  const library = clipboardLibrary(state, document, [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64: 'aaaa' }]);
  expect(library).toEqual({
    tags: [
      { id: 'src-defi', name: 'DeFi', color: '#f8dfc4' },
      { id: 'src-ai', name: 'AI', color: '#f8dfc4' },
    ],
    assets: [{ id: 'src-asset', name: '图.png', mime: 'image/png', base64: 'aaaa' }],
  });
  const carried = parseClipboard(JSON.stringify({ ...document, library }));
  const plan = pastePlan('q', carried, { x: 30, y: 40 });
  expect(plan.command.projectId).toBe('q');
  if (plan.command.type !== 'canvas.paste') throw new Error('粘贴命令类型错误');
  expect(plan.command.payload.library).toEqual(library);
  const card = plan.command.payload.objects.find(value => value.kind === 'card');
  expect(card && card.kind === 'card' ? card.tagIds : []).toEqual(['src-defi', 'src-ai']);
});

it('剪切信封标明源项目与剪切编号，副本命令不携带剪切标记，恢复选择取快照根身份', () => {
  const document = parseClipboard(JSON.stringify({
    kind: 'forkwise-canvas-snapshot', version: 1,
    cut: { cutId: 'cut-1', sourceProjectId: 'p' },
    objects: [{
      kind: 'card', sourceId: 'source-card', itemId: 'item-1', stack: 1, title: '市场观察',
      blocks: [{ id: 'words', type: 'text', text: '需求增长' }], tagIds: null, appearance: null, pose,
    }],
    connectors: [],
  }));
  expect(document.cut).toEqual({ cutId: 'cut-1', sourceProjectId: 'p' });
  expect(restoredCopyRefs(document)).toEqual([{ kind: 'card', copyId: 'item-1' }]);
  const plan = pastePlan('p', document, { x: 10, y: 10 });
  if (plan.command.type !== 'canvas.paste') throw new Error('粘贴命令类型错误');
  expect('cut' in plan.command.payload).toBe(false);
});

it('嵌套分区的剪切快照只为根生成恢复选择', () => {
  const document = parseClipboard(JSON.stringify({
    kind: 'forkwise-canvas-snapshot', version: 2, roots: ['frame-1'],
    containment: [{ itemId: 'item-1', parentItemId: 'frame-1' }],
    cut: { cutId: 'cut-2', sourceProjectId: 'p' },
    objects: [
      { kind: 'frame', sourceId: 'frame-1', itemId: 'frame-1', stack: 0, name: '分区', background: null, pose: { x: 0, y: 0, width: 400, height: 300 } },
      { kind: 'card', sourceId: 'card-1', itemId: 'item-1', stack: 1, title: '卡', blocks: [{ id: 'w', type: 'text', text: '内容' }], tagIds: null, appearance: null, pose },
    ],
    connectors: [],
  }));
  expect(restoredCopyRefs(document)).toEqual([{ kind: 'frame', copyId: 'frame-1' }]);
});
