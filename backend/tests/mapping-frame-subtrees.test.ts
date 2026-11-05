import { afterEach, expect, it } from 'vitest';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';
import { createFrameCommand } from './nested-frame-fixture.js';
import { captureSpatial, frameDrawMembers, spatialItems } from '../src/mapping/frame-spatial.js';

afterEach(closeGroupFixtures);
function overflowing(kind: 'shape' | 'group') {
  const f = groupFixture();
  for (const pose of [{ x: 0, y: 0, width: 500, height: 500 }, { x: 100, y: 100, width: 100, height: 100 }])
    f.execute(createFrameCommand(f.state(), [], pose));
  for (let i = 0; i < (kind === 'group' ? 2 : 1); i++) f.execute({ type: 'shape.create', expected: null,
    payload: { id: 's' + i, content: { shapeType: 'rectangle', shortText: '溢出内容' + i }, pose: { x: 120 + i * 30, y: 120, width: 20, height: 20 } } });
  const state = f.state(), parent = state.frames![0]!, child = state.frames![1]!;
  let root: string;
  if (kind === 'group') {
    const group = f.group(state.shapes!.map(v => v.item.id)), current = f.state(); root = group.itemId;
    f.execute({ type: 'group.move', placement: { expected: captureSpatial(current), point: { x: 150, y: 150 } },
      expected: { group: group.versionId, containment: f.structure().containment, poses: Object.fromEntries(spatialItems(current).map(v => [v.item.id, v.item.versionId])) }, payload: { id: group.id, dx: 230, dy: 0 } });
  } else {
    const shape = state.shapes![0]!; root = shape.item.id;
    f.execute({ type: 'shape.move', expected: shape.item.versionId, placement: { expected: captureSpatial(state), point: { x: 150, y: 150 } }, payload: { id: shape.id, x: 350, y: 120 } });
  }
  expect(f.state().containment!.find(v => v.id === root)?.parent).toEqual({ kind: 'frame', id: child.id });
  return { f, parent, child, root };
}
it.each(['shape', 'group'] as const)('父框resize释放子框时保留越界%s子树，不将后代吸成直接成员', kind => {
  const { f, parent, child, root } = overflowing(kind), before = f.state();
  const pose = { x: 300, y: 0, width: 150, height: 500 };
  f.execute({ type: 'frame.resize', placement: { expected: captureSpatial(before, { rect: pose, frameId: parent.id }) }, expected: parent.versionId, payload: { id: parent.id, pose } });
  const after = f.state();
  expect(after.containment!.find(v => v.id === child.id)?.parent).toBeNull();
  expect(after.containment!.find(v => v.id === root)?.parent).toEqual({ kind: 'frame', id: child.id });
  expect(after.frames!.find(v => v.id === parent.id)!.memberItemIds).toEqual([]);
  expect(after.shapes).toEqual(before.shapes);
  f.travel('history.undo'); expect(f.state().containment!.find(v => v.id === child.id)?.parent).toEqual({ kind: 'frame', id: parent.id });
  f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
});
it.each(['shape', 'group'] as const)('外层新draw只框住溢出%s而未框住其子Frame时不拆子树', kind => {
  const { f, parent, child, root } = overflowing(kind), before = f.state();
  const pose = { x: 330, y: 100, width: 100, height: 100 };
  const command = createFrameCommand(before, frameDrawMembers(before, pose), pose); f.execute(command);
  const after = f.state();
  expect(after.frames!.find(v => v.id === command.payload.id)!.memberItemIds).toEqual([]);
  expect(after.containment!.find(v => v.id === command.payload.id)?.parent).toEqual({ kind: 'frame', id: parent.id });
  expect(after.containment!.find(v => v.id === root)?.parent).toEqual({ kind: 'frame', id: child.id });
  expect(after.shapes).toEqual(before.shapes);
});

it.each(['shape', 'group'] as const)('draw/resize可从A→P→R的祖先A收纳完整%s，预览与公共执行一致', kind => {
  for (const method of ['draw', 'resize'] as const) {
    const f = groupFixture();
    f.execute(createFrameCommand(f.state(), [], { x: 0, y: 0, width: 1000, height: 700 }));
    f.execute(createFrameCommand(f.state(), [], { x: 100, y: 100, width: 500, height: 400 }));
    if (method === 'resize') f.execute(createFrameCommand(f.state(), [], { x: 400, y: 120, width: 100, height: 100 }));
    for (let i = 0; i < (kind === 'group' ? 2 : 1); i++) f.execute({ type: 'shape.create', expected: null,
      payload: { id: 'ancestor-' + i, content: { shapeType: 'rectangle', shortText: '祖先直接成员' }, pose: { x: 720 + i * 30, y: 150, width: 20, height: 20 } } });
    const root = kind === 'group' ? f.group(f.state().shapes!.map(v => v.item.id)) : f.state().shapes![0]!;
    const itemId = 'itemId' in root ? root.itemId : root.item.id;
    let s = f.state();
    if (kind === 'group') f.execute({ type: 'group.move', placement: { expected: captureSpatial(s), point: { x: 800, y: 150 } },
      expected: { group: root.versionId, containment: f.structure().containment, poses: Object.fromEntries(spatialItems(s).map(v => [v.item.id, v.item.versionId])) }, payload: { id: root.id, dx: -570, dy: 0 } });
    else f.execute({ type: 'shape.move', expected: s.shapes![0]!.item.versionId, placement: { expected: captureSpatial(s), point: { x: 800, y: 150 } }, payload: { id: root.id, x: 150, y: 150 } });
    s = f.state(); expect(s.containment!.find(v => v.id === itemId)?.parent).toEqual({ kind: 'frame', id: s.frames![0]!.id });
    const rect = { x: 130, y: 130, width: 120, height: 100 };
    const command = method === 'draw' ? createFrameCommand(s, frameDrawMembers(s, rect), rect)
      : { type: 'frame.resize', placement: { expected: captureSpatial(s, { rect, frameId: s.frames![2]!.id }) }, expected: s.frames![2]!.versionId, payload: { id: s.frames![2]!.id, pose: rect } };
    if (method === 'draw') expect(command.payload).toMatchObject({ itemIds: [itemId] });
    f.execute(command); const current = f.state(), r = current.frames!.at(-1)!;
    expect(current.containment!.find(v => v.id === itemId)?.parent).toEqual({ kind: 'frame', id: r.id });
    expect(current.containment!.find(v => v.id === r.id)?.parent).toEqual({ kind: 'frame', id: current.frames![1]!.id });
    expect(current.shapes).toEqual(s.shapes);
    if (kind === 'group') expect(current.groups![0]!.memberItemIds).toEqual(s.groups![0]!.memberItemIds);
    f.travel('history.undo'); expect(f.state().containment!.find(v => v.id === itemId)?.parent).toEqual({ kind: 'frame', id: s.frames![0]!.id });
    f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
  }
});

it('G内draw R可收G直接成员；外层draw完整收G子树且不双收后代', () => {
  const f = groupFixture();
  f.execute(createFrameCommand(f.state(), [], { x: 0, y: 0, width: 1000, height: 700 }));
  f.execute(createFrameCommand(f.state(), [], { x: 100, y: 100, width: 400, height: 300 }));
  f.execute({ type: 'shape.create', expected: null, payload: { id: 'inside', content: { shapeType: 'rectangle', shortText: '内层成员' }, pose: { x: 150, y: 150, width: 20, height: 20 } } });
  const before = f.state(), g = before.frames![1]!, x = before.shapes![0]!;
  const inner = { x: 140, y: 140, width: 100, height: 100 };
  expect(frameDrawMembers(before, inner)).toEqual([x.item.id]);
  f.execute(createFrameCommand(before, frameDrawMembers(before, inner), inner));
  expect(f.state().containment!.find(v => v.id === x.item.id)?.parent).toEqual({ kind: 'frame', id: f.state().frames![2]!.id });
  const whole = { x: 90, y: 90, width: 420, height: 320 }, state = f.state();
  expect(frameDrawMembers(state, whole)).toEqual([g.id]);
  f.execute(createFrameCommand(state, frameDrawMembers(state, whole), whole));
  const after = f.state();
  expect(after.frames!.at(-1)!.memberItemIds).toEqual([g.id]);
  expect(after.containment!.find(v => v.id === x.item.id)?.parent).toEqual(state.containment!.find(v => v.id === x.item.id)?.parent);
  f.travel('history.undo'); f.travel('history.redo'); const redone = f.state(); f.reopen(); expect(f.state()).toEqual(redone);
});
