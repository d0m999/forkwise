import { expect, it } from 'vitest';
import { attachmentCardTitle, droppedFilePlan, runDroppedFiles, type DropHost } from './canvas-drop';

function file(name: string, type = '') {
  return new File(['x'], name, { type });
}

it('图片和普通文件按各自规则排布，标题去掉扩展名', () => {
  expect(attachmentCardTitle('财报.pdf')).toBe('财报');
  expect(attachmentCardTitle('没有扩展名')).toBe('没有扩展名');
  expect(attachmentCardTitle('.gitignore')).toBe('.gitignore');
  const plan = droppedFilePlan([
    file('说明.pdf', 'application/pdf'),
    file('图.png', 'image/png'),
    file('甲.txt', 'text/plain'),
    file('乙.bin', 'application/octet-stream'),
    file('丙.pdf', 'application/pdf'),
  ], { x: 10, y: 20 });
  expect(plan.images.map(item => item.name)).toEqual(['图.png']);
  expect(plan.documents.map(item => ({ name: item.file.name, title: item.title, x: item.x, y: item.y }))).toEqual([
    { name: '说明.pdf', title: '说明', x: 10, y: 20 },
    { name: '甲.txt', title: '甲', x: 330, y: 20 },
    { name: '乙.bin', title: '乙', x: 650, y: 20 },
    { name: '丙.pdf', title: '丙', x: 10, y: 220 },
  ]);
});

function host(overrides: Partial<DropHost> = {}) {
  const calls: string[] = [];
  const base: DropHost = {
    claimDraft: async () => { calls.push('claimDraft'); return true; },
    saveFile: async (item) => { calls.push(`save:${item.name}`); return { assetId: `asset:${item.name}`, name: item.name }; },
    createCard: async (input) => { calls.push(`card:${input.title}:${input.assetId}:${input.name}`); },
    importImage: async (item) => { calls.push(`image:${item.name}`); },
    ...overrides,
  };
  return { calls, host: base };
}

it('草稿没能保存时整批拖入取消，不建卡也不导入图片', async () => {
  const { calls, host: deps } = host({ claimDraft: async () => { calls.push('claimDraft'); return false; } });
  const failures = await runDroppedFiles(droppedFilePlan([file('甲.pdf', 'application/pdf'), file('图.png', 'image/png')], { x: 0, y: 0 }), deps);
  expect(failures).toEqual(['草稿未保存，拖入已取消']);
  expect(calls).toEqual(['claimDraft']);
});

it('单个文件建卡失败不留下后续步骤，其余文件和图片照常处理', async () => {
  const { calls, host: deps } = host({
    createCard: async (input) => {
      calls.push(`card:${input.title}:${input.assetId}:${input.name}`);
      if (input.title === '甲') throw new Error('附件失败');
    },
  });
  const failures = await runDroppedFiles(droppedFilePlan([
    file('甲.pdf', 'application/pdf'),
    file('乙.pdf', 'application/pdf'),
    file('图.png', 'image/png'),
  ], { x: 0, y: 0 }), deps);
  expect(failures).toEqual(['甲.pdf：附件失败']);
  expect(calls).toEqual([
    'claimDraft',
    'save:甲.pdf', 'card:甲:asset:甲.pdf:甲.pdf',
    'save:乙.pdf', 'card:乙:asset:乙.pdf:乙.pdf',
    'image:图.png',
  ]);
});

it('图片导入失败单独记录，不影响已建好的卡片', async () => {
  const { calls, host: deps } = host({
    importImage: async (item) => {
      calls.push(`image:${item.name}`);
      throw new Error('图片读取失败');
    },
  });
  const failures = await runDroppedFiles(droppedFilePlan([file('甲.pdf', 'application/pdf'), file('图.png', 'image/png')], { x: 0, y: 0 }), deps);
  expect(failures).toEqual(['图.png：图片读取失败']);
  expect(calls).toEqual(['claimDraft', 'save:甲.pdf', 'card:甲:asset:甲.pdf:甲.pdf', 'image:图.png']);
});
