import { afterEach, expect, it } from 'vitest';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';
import { createFrameCommand } from './nested-frame-fixture.js';
import { captureSpatial, frameDrawMembers } from '../src/mapping/frame-spatial.js';

afterEach(closeGroupFixtures);
it.each(['resize', 'draw'])('删Q释放到顶层的对象可由几何%s重新收纳，子框完整不双收后代', mode => {
  const f = groupFixture();
  for (const pose of [{ x: 0, y: 0, width: 1100, height: 800 }, { x: 100, y: 100, width: 250, height: 250 }, { x: 500, y: 100, width: 350, height: 350 }])
    f.execute(createFrameCommand(f.state(), [], pose));
  const base = f.state(), child = base.frames![1]!, removed = base.frames![2]!;
  for (const [id, x] of [['inside-child', 150], ['released', 550]] as const)
    f.execute({ type: 'shape.create', expected: null, payload: { id, content: { shapeType: 'rectangle', shortText: id }, pose: { x, y: 150, width: 50, height: 50 } } });
  const grouped = f.state(), released = grouped.shapes!.find(v => v.id === 'released')!;
  f.execute({ type: 'frame.delete', expected: { frame: removed.versionId,
    containment: Object.fromEntries(grouped.containment!.filter(v => v.id === removed.id || v.parent?.id === removed.id).map(v => [v.id, v.versionId])) }, payload: { id: removed.id } });
  const before = f.state(); expect(before.containment!.find(v => v.id === released.item.id)?.parent).toBeNull();
  const pose = { x: 90, y: 90, width: 700, height: 400 };
  let target = child.id;
  if (mode === 'resize') f.execute({ type: 'frame.resize', placement: { expected: captureSpatial(before, { rect: pose, frameId: child.id }) }, expected: child.versionId, payload: { id: child.id, pose } });
  else { const command = createFrameCommand(before, frameDrawMembers(before, pose), pose); target = command.payload.id; f.execute(command); }
  const after = f.state(), frame = after.frames!.find(v => v.id === target)!;
  expect(frame.memberItemIds).toContain(released.item.id);
  const nested = after.shapes!.find(v => v.id === 'inside-child')!;
  expect(after.containment!.find(v => v.id === nested.item.id)?.parent).toEqual({ kind: 'frame', id: child.id });
  if (mode === 'draw') { expect(frame.memberItemIds).toContain(child.id); expect(frame.memberItemIds).not.toContain(nested.item.id); }
  expect(after.shapes).toEqual(before.shapes);
  f.travel('history.undo'); expect(f.state().containment!.find(v => v.id === released.item.id)?.parent).toBeNull();
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
});
