import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-mapping-test-'));
  directories.push(directory);
  return { directory, mapping: openMapping(directory) };
}
it('项目与独立标题、简单正文在关闭 SQLite 后以原身份重开', () => {
  const f = fixture();
  let mapping = f.mapping;
  const token = mapping.access.issue('human', ['*']);
  const actor = mapping.access.authenticate(token);
  const project = mapping.execute(
    {
      commandId: 'create-project',
      projectId: 'p1',
      type: 'project.create',
      expected: null,
      payload: { name: '芯片研究' },
    },
    actor,
  );
  const created = mapping.execute(
    {
      commandId: 'create-card',
      projectId: 'p1',
      type: 'thought.create',
      expected: null,
      payload: { id: 'card1', title: '独立标题', text: '正文第一行\n正文第二行', x: 120, y: 90 },
    },
    actor,
  );
  const before = mapping.read({ type: 'project', projectId: 'p1' }, actor);
  mapping.close();
  mapping = openMapping(f.directory);
  try {
    const reopenedActor = mapping.access.authenticate(token);
    expect(mapping.read({ type: 'project', projectId: 'p1' }, reopenedActor)).toEqual(before);
    expect(before).toMatchObject({
      project: { id: 'p1', name: '芯片研究', revision: 2 },
      cards: [
        {
          id: 'card1',
          title: '独立标题',
          body: { blocks: [{ type: 'text', text: '正文第一行\n正文第二行' }] },
          item: { pose: { x: 120, y: 90 } },
        },
      ],
    });
    expect(
      mapping
        .observe({ projectId: 'p1', afterRevision: 0 }, reopenedActor)
        .changes.map((c) => c.commandId),
    ).toEqual([project.commandId, created.commandId]);
  } finally {
    mapping.close();
  }
});
it('项目改名和卡片标题正文编辑各自保留其余内容与项目隔离', () => {
  const { mapping } = fixture();
  try {
    const actor = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    for (const projectId of ['p1', 'p2'])
      mapping.execute(
        {
          commandId: 'create',
          projectId,
          type: 'project.create',
          expected: null,
          payload: { name: '同名项目' },
        },
        actor,
      );
    mapping.execute(
      {
        commandId: 'card',
        projectId: 'p1',
        type: 'thought.create',
        expected: null,
        payload: { id: 'c', title: '标题', text: '正文', x: 30, y: 50 },
      },
      actor,
    );
    const before = mapping.read({ type: 'project', projectId: 'p1' }, actor);
    mapping.execute(
      {
        commandId: 'rename',
        projectId: 'p1',
        type: 'project.rename',
        expected: before.project.versionId,
        payload: { name: '改名项目' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'title',
        projectId: 'p1',
        type: 'thought.title',
        expected: before.cards[0]!.versionId,
        payload: { id: 'c', title: '新的标题' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'body',
        projectId: 'p1',
        type: 'body.edit',
        expected: before.cards[0]!.body.versionId,
        payload: { id: 'c', text: '新的正文\n保留原文' },
      },
      actor,
    );
    const after = mapping.read({ type: 'project', projectId: 'p1' }, actor);
    expect(after.project.name).toBe('改名项目');
    expect(after.cards[0]).toMatchObject({
      id: 'c',
      title: '新的标题',
      body: {
        id: before.cards[0]!.body.id,
        blocks: [{ id: before.cards[0]!.body.blocks[0]!.id, text: '新的正文\n保留原文' }],
      },
      item: before.cards[0]!.item,
    });
    expect(mapping.read({ type: 'project', projectId: 'p2' }, actor)).toMatchObject({
      project: { name: '同名项目', revision: 1 },
      cards: [],
    });
    expect(mapping.read({ type: 'projects' }, actor).map((p) => p.name)).toEqual([
      '改名项目',
      '同名项目',
    ]);
  } finally {
    mapping.close();
  }
});
it('丢失确认后跨重启重试原命令只写一次，并保留改前改后内容', () => {
  const f = fixture();
  let mapping = f.mapping;
  const token = mapping.access.issue('human', ['*']);
  let actor = mapping.access.authenticate(token);
  const create = {
    commandId: 'project',
    projectId: 'p',
    type: 'project.create',
    expected: null,
    payload: { name: '研究' },
  };
  const receipt = mapping.execute(create, actor);
  mapping.execute(
    {
      commandId: 'card',
      projectId: 'p',
      type: 'thought.create',
      expected: null,
      payload: { id: 'c', title: '', text: '原正文', x: 0, y: 0 },
    },
    actor,
  );
  const original = mapping.read({ type: 'project', projectId: 'p' }, actor).cards[0]!;
  const edit = {
    commandId: 'edit',
    projectId: 'p',
    type: 'body.edit',
    expected: original.body.versionId,
    payload: { id: 'c', text: '新正文' },
  };
  const edited = mapping.execute(edit, actor);
  mapping.close();
  mapping = openMapping(f.directory);
  actor = mapping.access.authenticate(token);
  try {
    expect(mapping.execute(create, actor)).toEqual(receipt);
    expect(mapping.execute(edit, actor)).toEqual(edited);
    expect(() =>
      mapping.execute({ ...edit, payload: { id: 'c', text: '另一正文' } }, actor),
    ).toThrow('命令编号');
    expect(mapping.read({ type: 'project', projectId: 'p' }, actor).project.revision).toBe(3);
    const changes = mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes;
    expect(changes).toMatchObject([
      {
        commandId: 'edit',
        before: original,
        after: { id: 'c', body: { blocks: [{ text: '新正文' }] } },
        actor: actor.actor,
      },
    ]);
  } finally {
    mapping.close();
  }
});
it('过期版本整体拒绝、失败命令可重试，未授权项目不可读取或回取回执', () => {
  const { mapping } = fixture();
  try {
    const actor = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    mapping.execute(
      {
        commandId: 'project',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: '研究' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'card',
        projectId: 'p',
        type: 'thought.create',
        expected: null,
        payload: { id: 'c', title: '', text: '', x: 0, y: 0 },
      },
      actor,
    );
    const before = mapping.read({ type: 'project', projectId: 'p' }, actor);
    const edit = {
      commandId: 'edit',
      projectId: 'p',
      type: 'thought.title',
      expected: 'stale',
      payload: { id: 'c', title: '修改' },
    };
    expect(() => mapping.execute(edit, actor)).toThrow('标题已更新');
    expect(mapping.read({ type: 'project', projectId: 'p' }, actor)).toEqual(before);
    expect(mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes).toEqual([]);
    mapping.execute({ ...edit, expected: before.cards[0]!.versionId }, actor);
    const denied = mapping.access.authenticate(mapping.access.issue('human', ['other']));
    expect(mapping.read({ type: 'projects' }, denied)).toEqual([]);
    expect(() => mapping.read({ type: 'project', projectId: 'p' }, denied)).toThrow('授权');
    expect(() =>
      mapping.execute({ ...edit, expected: before.cards[0]!.versionId }, denied),
    ).toThrow('授权');
    const agent = mapping.access.authenticate(mapping.access.issue('agent', ['p']));
    expect(mapping.read({ type: 'project', projectId: 'p' }, agent).cards[0]!.title).toBe('修改');
    expect(() => mapping.execute(edit, agent)).toThrow('本机会话');
    expect(() => mapping.execute({ ...edit, actor: { type: 'human' } }, actor)).toThrow();
  } finally {
    mapping.close();
  }
});
it('无内容变化的重复保存不创建新版本或编辑记录', () => {
  const { mapping } = fixture();
  try {
    const actor = mapping.access.authenticate(mapping.access.issue('human', ['*']));
    mapping.execute(
      {
        commandId: 'project',
        projectId: 'p',
        type: 'project.create',
        expected: null,
        payload: { name: '研究' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'card',
        projectId: 'p',
        type: 'thought.create',
        expected: null,
        payload: { id: 'c', title: '', text: '', x: 0, y: 0 },
      },
      actor,
    );
    const before = mapping.read({ type: 'project', projectId: 'p' }, actor);
    mapping.execute(
      {
        commandId: 'title',
        projectId: 'p',
        type: 'thought.title',
        expected: before.cards[0]!.versionId,
        payload: { id: 'c', title: '' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'body',
        projectId: 'p',
        type: 'body.edit',
        expected: before.cards[0]!.body.versionId,
        payload: { id: 'c', text: '' },
      },
      actor,
    );
    mapping.execute(
      {
        commandId: 'name',
        projectId: 'p',
        type: 'project.rename',
        expected: before.project.versionId,
        payload: { name: '研究' },
      },
      actor,
    );
    expect(mapping.read({ type: 'project', projectId: 'p' }, actor)).toEqual(before);
    expect(mapping.observe({ projectId: 'p', afterRevision: 2 }, actor).changes).toEqual([]);
  } finally {
    mapping.close();
  }
});
