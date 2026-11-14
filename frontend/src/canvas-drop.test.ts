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
    createCard: async (input) => { calls.push(`card:${input.title}`); return { cardId: `card:${input.title}`, revision: 7 }; },
    attach: async (input) => { calls.push(`attach:${input.cardId}`); },
    retractCard: async (cardId) => { calls.push(`retract:${cardId}`); },
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

it('单个文件挂附件失败只撤回那张新卡，其余文件和图片照常处理', async () => {
  const { calls, host: deps } = host({
    attach: async (input) => {
      calls.push(`attach:${input.cardId}`);
      if (input.cardId === 'card:甲') throw new Error('附件失败');
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
    'save:甲.pdf', 'card:甲', 'attach:card:甲', 'retract:card:甲',
    'save:乙.pdf', 'card:乙', 'attach:card:乙',
    'image:图.png',
  ]);
});

it('撤回新卡也失败时如实报出，后续文件不受影响', async () => {
  const { calls, host: deps } = host({
    attach: async () => { throw new Error('附件失败'); },
    retractCard: async () => { throw new Error('撤销失败'); },
  });
  const failures = await runDroppedFiles(droppedFilePlan([file('甲.pdf', 'application/pdf'), file('乙.pdf', 'application/pdf')], { x: 0, y: 0 }), deps);
  expect(failures).toEqual(['甲.pdf：附件没有挂上，新建卡片也未能撤回', '乙.pdf：附件没有挂上，新建卡片也未能撤回']);
  expect(calls.filter(call => call.startsWith('card:'))).toEqual(['card:甲', 'card:乙']);
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
  expect(calls).toEqual(['claimDraft', 'save:甲.pdf', 'card:甲', 'attach:card:甲', 'image:图.png']);
});
