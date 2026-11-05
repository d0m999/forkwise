import { afterEach, expect, it } from 'vitest';
import { closeGroupFixtures, groupFixture } from './group-fixture.js';

afterEach(closeGroupFixtures);

it('v2拒绝零成员group，不写内容/版本修订/历史或observe变化', () => {
  const f = groupFixture(), before = f.state(), history = f.history();
  expect(() => f.execute({ type: 'canvas.paste', expected: null, payload: { version: 2, roots: ['empty-group'], containment: [],
    translation: { x: 0, y: 0 }, objects: [{ kind: 'group', copyId: 'empty-group', stack: 1, pose: { x: 0, y: 0, width: 100, height: 100 } }], connectors: [] } })).toThrow();
  expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
  expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes).toEqual([]);
});

it.each([{ version: 1, explicit: false }, { version: 1, explicit: true }, { version: 2, explicit: false }, { version: 2, explicit: true }])(
  'v$version 拒绝将stroke作为bound端点，explicitItem=$explicit 且整批无写', ({ version, explicit }) => {
    const f = groupFixture(), source = f.stroke('source'), before = f.state(), history = f.history();
    expect(() => f.execute({ type: 'canvas.paste', expected: null, payload: {
      ...(version === 2 ? { version: 2, roots: ['stroke-copy'], containment: [] } : {}), translation: { x: 24, y: 24 },
      objects: [{ kind: 'stroke', copyId: 'stroke-copy', stack: 1, content: source.content, pose: source.item.pose }],
      connectors: [{ copyId: 'invalid-line', path: 'straight', start: { kind: 'bound', copyId: 'stroke-copy', side: 'top', ...(explicit ? { targetKind: 'item' } : {}) },
        end: { kind: 'free', point: { x: 900, y: 900 } } }],
    } })).toThrow();
    expect(f.state()).toEqual(before); expect(f.history()).toEqual(history);
    expect(f.mapping.observe({ projectId: 'p', afterRevision: before.project.revision }, f.human).changes).toEqual([]);
  },
);

it('v2单成员group可保留stroke成员，普通stroke复制与空Frame仍合法', () => {
  const f = groupFixture(), source = f.stroke('source');
  f.execute({ type: 'canvas.paste', expected: null, payload: { version: 2, roots: ['one-member', 'empty-frame', 'loose-stroke'],
    containment: [{ copyId: 'member-stroke', parentCopyId: 'one-member' }], translation: { x: 24, y: 24 }, objects: [
      { kind: 'group', copyId: 'one-member', stack: 1, pose: source.item.pose },
      { kind: 'stroke', copyId: 'member-stroke', stack: 1, content: source.content, pose: source.item.pose },
      { kind: 'stroke', copyId: 'loose-stroke', stack: 2, content: source.content, pose: { ...source.item.pose, x: 900 } },
      { kind: 'frame', copyId: 'empty-frame', stack: 0, name: '空框', background: null, pose: { x: 1500, y: 0, width: 100, height: 100 } },
    ], connectors: [] } });
  const after = f.state(), group = after.groups![0]!, member = after.strokes!.find(v => v.id === 'member-stroke')!;
  expect(group.memberItemIds).toEqual([member.item.id]);
  expect(group.bounds).toEqual({ x: 444, y: 44, width: 20, height: 10 });
  expect(after.strokes!.find(v => v.id === 'loose-stroke')!.content).toEqual(source.content);
  expect(after.frames![0]!.memberItemIds).toEqual([]);
});
