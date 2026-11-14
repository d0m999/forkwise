import { expect, it } from 'vitest';
import { attachmentCardTitle, droppedFilePlan } from './canvas-drop';

it('图片和普通文件按各自规则排布，标题去掉扩展名', () => {
  expect(attachmentCardTitle('财报.pdf')).toBe('财报');
  expect(attachmentCardTitle('没有扩展名')).toBe('没有扩展名');
  expect(attachmentCardTitle('.gitignore')).toBe('.gitignore');
  const plan = droppedFilePlan([
    { name: '说明.pdf', type: 'application/pdf' },
    { name: '图.png', type: 'image/png' },
    { name: '甲.txt', type: 'text/plain' },
    { name: '乙.bin', type: 'application/octet-stream' },
    { name: '丙.pdf', type: 'application/pdf' },
  ], { x: 10, y: 20 });
  expect(plan.images.map(file => file.name)).toEqual(['图.png']);
  expect(plan.documents.map(file => ({ name: file.name, title: file.title, x: file.x, y: file.y }))).toEqual([
    { name: '说明.pdf', title: '说明', x: 10, y: 20 },
    { name: '甲.txt', title: '甲', x: 330, y: 20 },
    { name: '乙.bin', title: '乙', x: 650, y: 20 },
    { name: '丙.pdf', title: '丙', x: 10, y: 220 },
  ]);
});
