import { it, expect } from 'vitest';
import type { CommandInput } from '../src/contracts/commands.js';
import { randomUUID } from 'node:crypto';
import { setup, statement, inference, human, agent } from './helpers.js';
import { expectedVersions } from '../web/operation-versions.js';

it('材料属于对象列表，移除只隐藏本对象，原文件、引用及其他对象保持，重复加入不制造版本', () => {
  const t = setup();
  try {
    t.write([
      statement('a'),
      statement('b'),
      inference('i', ['a'], 'b'),
      {
        op: 'source.create',
        id: 's',
        data: { title: '材料', publisher: '', rights: 'authorized' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 's',
        text: '可引用的原文',
        retrievedAt: '2026-01-01T00:00:00Z',
        publishedAt: null,
      },
    ]);
    const command: CommandInput = {
      op: 'material.attach',
      id: 'm',
      targetId: 'a',
      sourceVersionId: 'sv',
    };
    const execute = (
      commands: CommandInput[],
      actor = human,
      expected = expectedVersions(t.repo.snapshot(t.project.id).objects, commands),
    ) => t.service.execute(t.project.id, actor, randomUUID(), { commands, expected });
    const first = execute([command]);
    expect(first.upserted.find((e) => e.kind === 'material_membership')?.data).toEqual({
      targetId: 'a',
      sourceVersionId: 'sv',
      visibility: 'included',
    });
    expect(t.get('a').data).toMatchObject({ stance: { value: 'pending' } });
    expect(execute([command]).upserted).toEqual([]);
    execute([{ ...command, id: 'm2', targetId: 'i' }]);
    execute([
      {
        op: 'evidence.create',
        id: 'ev',
        data: { citation: { sourceVersionId: 'sv', start: 0, end: 6, quote: '可引用的原文' } },
      },
    ]);
    execute([{ op: 'material.hide', id: 'm' }]);
    expect(t.get('m').data).toMatchObject({ visibility: 'excluded' });
    expect(t.get('m2').data).toMatchObject({ visibility: 'included' });
    expect(t.repo.material(t.project.id, 'sv')).toBe('可引用的原文');
    expect(t.get('ev').kind).toBe('evidence');
    execute([command]);
    expect(t.get('m').data).toMatchObject({ visibility: 'included' });
    expect(() => execute([{ op: 'material.hide', id: 'm' }], agent)).toThrow('本人');
    expect(() => execute([{ ...command, id: 'another' }])).toThrow('复用');
    expect(() =>
      execute([{ op: 'material.hide', id: 'm' }], human, { m: 1, a: 1, sv: 1 }),
    ).toThrow();
  } finally {
    t.db.close();
  }
});

it('复制卡片继承可见材料；推导证据绑定前提内容，修改前提后不能直接改判关系', () => {
  const t = setup();
  try {
    t.write([
      statement('a'),
      statement('b'),
      inference('i', ['a'], 'b'),
      { op: 'source.create', id: 's', data: { title: '材料', publisher: '', rights: 'public' } },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 's',
        text: '依据',
        retrievedAt: '2026-01-01T00:00:00Z',
        publishedAt: null,
      },
      { op: 'material.attach', id: 'm', targetId: 'a', sourceVersionId: 'sv' },
      {
        op: 'evidence.create',
        id: 'e',
        data: { citation: { sourceVersionId: 'sv', start: 0, end: 2, quote: '依据' } },
      },
    ]);
    const write = (commands: CommandInput[]) =>
      t.service.execute(t.project.id, human, randomUUID(), {
        commands,
        expected: expectedVersions(t.repo.snapshot(t.project.id).objects, commands),
      });
    write([{ op: 'statement.copy', id: 'a', newId: 'copy' }]);
    expect(
      t.repo
        .snapshot(t.project.id)
        .objects.filter((e) => e.kind === 'material_membership' && e.data.targetId === 'copy'),
    ).toHaveLength(1);
    write([
      {
        op: 'evidence.link',
        id: 'l',
        data: {
          evidenceId: 'e',
          target: { id: 'i', versionId: t.get('i').contentVersionId },
          relation: 'unjudged',
          explanation: '保留待判断',
          origin: 'human',
          participation: 'adopted',
        },
      },
    ]);
    expect(t.get('l').data).toMatchObject({
      context: [
        { id: 'a', versionId: t.get('a').contentVersionId },
        { id: 'b', versionId: t.get('b').contentVersionId },
      ],
    });
    write([{ op: 'evidence.relate', id: 'l', relation: 'supports', explanation: '支持这一步' }]);
    write([{ op: 'statement.edit', id: 'a', text: '已改写的前提', scope: 'all' }]);
    expect(() =>
      write([{ op: 'evidence.relate', id: 'l', relation: 'opposes', explanation: '反对' }]),
    ).toThrow('前提');
  } finally {
    t.db.close();
  }
});
