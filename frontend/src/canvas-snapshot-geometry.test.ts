import { expect, it } from 'vitest';
import { boundsCenter, nextPaste, pasteTranslation } from './canvas-snapshot-geometry';

it('粘贴中心对准落点，连续同一落点逐次加 24，落点或视口变化从当前落点重计', () => {
  expect(boundsCenter([{ x: 10, y: 20, width: 100, height: 80 }], [])).toEqual({ x: 60, y: 60 });
  expect(boundsCenter([], [{ x: 10, y: 20 }, { x: 30, y: 40 }])).toEqual({ x: 20, y: 30 });
  const center = { x: 60, y: 60 }, drop = { x: 200, y: 80 };
  expect(pasteTranslation(center, drop, 0)).toEqual({ x: 140, y: 20 });
  expect(pasteTranslation(center, drop, 1)).toEqual({ x: 164, y: 44 });
  expect(pasteTranslation(center, drop, 2)).toEqual({ x: 188, y: 68 });
  const keys = { clipboard: 'same', drop: '200:80', viewport: '0:0:1' };
  const first = nextPaste(null, keys);
  const second = nextPaste(first.sequence, keys);
  expect(first.index).toBe(0);
  expect(second.index).toBe(1);
  expect(nextPaste(second.sequence, { ...keys, drop: '210:80' }).index).toBe(0);
  expect(nextPaste(second.sequence, { ...keys, viewport: '0:0:1.2' }).index).toBe(0);
  expect(nextPaste(second.sequence, { ...keys, clipboard: 'next' }).index).toBe(0);
  expect(nextPaste(second.sequence, keys).index).toBe(2);
});
