import { afterEach, expect, it } from 'vitest';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';
import { createFrameCommand } from './nested-frame-fixture.js';
import { captureSpatial } from '../src/mapping/frame-spatial.js';

afterEach(closeGroupFixtures);
it.each([false, true])('无关联A/B移动分别成功，已有Frame=%s', framed => {
  const f = groupFixture();
  if (framed) f.execute(createFrameCommand(f.state(), [], { x: 0, y: 0, width: 1000, height: 700 }));
  const a = f.shape('a'), b = f.shape('b'), snapshot = f.state();
  const move = (id: string, expected: string, x: number) => ({ type: 'shape.move', expected, placement: { expected: captureSpatial(snapshot), point: { x: 450, y: 100 } }, payload: { id, x, y: 50 } });
  f.execute(move(b.id, b.item.versionId, 350));
  f.execute(move(a.id, a.item.versionId, 500));
  expect(f.state().shapes!.map(v => [v.id, v.item.pose.x])).toEqual([['a', 500], ['b', 350]]);
});

it('移动对象原来无归属记录，随后入组时旧drop原子拒绝且不拆新组', () => {
  const f = groupFixture(), a = f.shape('a'), b = f.shape('b'), snapshot = f.state();
  const command = { type: 'shape.move', expected: a.item.versionId, placement: { expected: captureSpatial(snapshot), point: { x: 700, y: 700 } }, payload: { id: a.id, x: 600, y: 600 } };
  const group = f.group([a.item.id, b.item.id]); const before = f.state(), history = f.history();
  expect(() => f.execute(command)).toThrowError(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history); expect(f.state().groups![0]!.memberItemIds).toEqual(group.memberItemIds);
});
