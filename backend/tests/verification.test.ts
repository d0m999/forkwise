import { it, expect } from 'vitest';
import { human, agent, statement, inference, setup } from './helpers.js';
import type { AnyEntity, Entity } from '../src/contracts/entities.js';
import type { CommandInput } from '../src/contracts/commands.js';
import { verificationContext, verificationCurrent } from '../src/domain/verification.js';
import { currentVerification, verificationScope } from '../web/verification.js';
import { expectedVersions } from '../web/operation-versions.js';
import { createApplication } from '../src/app.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';

const details = {
  event: '下一财年年度报告披露',
  goal: '核对全年利润是否翻倍',
  period: '下一财年',
  date: null,
};
function scope(objects: AnyEntity[], targetId: string) {
  const target = objects.find((e) => e.id === targetId)!;
  return {
    target: { id: target.id, versionId: target.contentVersionId },
    context: verificationContext(new Map(objects.map((e) => [e.id, e])), target),
  };
}
it('AI 节点建议与本人确认分别保存；确认不修改立场、内容版本或产生评估任务，重复确认无新历史', () => {
  const t = setup();
  try {
    t.write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
    const binding = scope(t.repo.snapshot(t.project.id).objects, 'i');
    const propose: CommandInput = {
      op: 'verification.propose',
      id: 'candidate',
      ...binding,
      details,
      gaps: ['披露日期未知'],
    };
    t.write([propose], t.versions(), agent);
    const before = t.get('i');
    const confirm: CommandInput = {
      op: 'verification.confirm',
      id: 'confirmed',
      ...binding,
      details,
      basedOn: { id: 'candidate', versionId: t.get('candidate').versionId },
    };
    expect(() => t.write([confirm], t.versions(), agent)).toThrow(/本人确认/);
    t.write([confirm]);
    expect(t.get('candidate').data).toMatchObject({ status: 'candidate' });
    expect(t.get('confirmed').data).toMatchObject({
      status: 'confirmed',
      basedOn: confirm.basedOn,
    });
    expect(t.get('i').contentVersionId).toBe(before.contentVersionId);
    expect(t.get('i').data).toEqual(before.data);
    const revision = t.repo.project(t.project.id).revision;
    expect(t.write([confirm]).upserted).toEqual([]);
    expect(t.repo.project(t.project.id).revision).toBe(revision);
    expect(t.repo.history(t.project.id, 'confirmed')).toHaveLength(1);
    t.write([{ ...confirm, details: { ...details, date: '2027-03-15' } }]);
    expect(t.repo.history(t.project.id, 'confirmed')).toHaveLength(2);
    expect(t.db.prepare('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 0 });
  } finally {
    t.db.close();
  }
});

it('内容/端点改写让旧节点需复核，立场修改不使节点过期；同批次失败原子回滚', () => {
  const t = setup();
  try {
    t.write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
    const binding = scope(t.repo.snapshot(t.project.id).objects, 'i');
    t.write([{ op: 'verification.confirm', id: 'node', ...binding, details }]);
    const current = () =>
      verificationCurrent(
        new Map(t.repo.snapshot(t.project.id).objects.map((e) => [e.id, e])),
        t.get('node') as Entity<'verification_node'>,
      );
    expect(current()).toBe(true);
    t.write([{ op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '' } }]);
    expect(current()).toBe(true);
    t.write([{ op: 'statement.edit', id: 'a', text: '改变前提', scope: 'all' }]);
    expect(current()).toBe(false);
    const before = t.repo.snapshot(t.project.id);
    expect(() =>
      t.write([
        statement('should_rollback'),
        { op: 'verification.confirm', id: 'node', ...binding, details },
      ]),
    ).toThrow(/内容或前提已变化/);
    expect(t.repo.snapshot(t.project.id)).toEqual(before);
    const renewed = scope(before.objects, 'i');
    expect(() =>
      t.write(
        [{ op: 'verification.confirm', id: 'node', ...renewed, details }],
        t.versions(['node', 'i']),
      ),
    ).toThrow(/缺少相关对象/);
    t.write([{ op: 'verification.confirm', id: 'node', ...renewed, details }]);
    expect(current()).toBe(true);
    expect(t.repo.history(t.project.id, 'node')).toHaveLength(2);
  } finally {
    t.db.close();
  }
});

it('确认必须有事件和目标，未知期间/日期可保存；并发确认不能创建第二份当前节点', () => {
  const t = setup();
  try {
    t.write([statement('a')]);
    const binding = scope(t.repo.snapshot(t.project.id).objects, 'a');
    const command: CommandInput = {
      op: 'verification.confirm',
      id: 'node',
      ...binding,
      details: { ...details, period: null },
    };
    expect(() => t.write([{ ...command, details: { ...details, goal: null } }])).toThrow(/补明/);
    t.write([command]);
    expect(() => t.write([{ ...command, id: 'another_node' }])).toThrow(/已有本人节点/);
    expect(() => t.write([{ op: 'object.delete', id: 'node' }])).toThrow(/历史保留/);
    t.write([{ op: 'statement.copy', id: 'a', newId: 'copy' }]);
    expect(
      t.repo.snapshot(t.project.id).objects.filter((e) => e.kind === 'verification_node'),
    ).toHaveLength(1);
    const cmds: CommandInput[] = [{ op: 'object.delete', id: 'a' }];
    const objects = t.repo.snapshot(t.project.id).objects;
    expect(expectedVersions(objects, cmds)).toMatchObject({ a: t.get('a').version, node: 1 });
    expect(t.write(cmds, expectedVersions(objects, cmds)).deletedIds.sort()).toEqual(['a', 'node']);
    expect(t.repo.history(t.project.id, 'node').at(-1)?.deletedAt).not.toBeNull();
  } finally {
    t.db.close();
  }
});

it('前后端按同一内容版本和直接端点选取当前节点，缺少端点不能误显示已确认', () => {
  const t = setup();
  try {
    t.write([statement('z'), statement('a'), statement('b'), inference('i', ['z', 'a'], 'b')]);
    let objects = t.repo.snapshot(t.project.id).objects;
    expect(verificationScope(objects, t.get('i'))).toEqual(scope(objects, 'i'));
    const command: CommandInput = {
      op: 'verification.confirm',
      id: 'node',
      ...scope(objects, 'i'),
      details,
    };
    expect(expectedVersions(objects, [command])).toEqual({ i: 1, a: 1, b: 1, z: 1 });
    t.write([command]);
    objects = t.repo.snapshot(t.project.id).objects;
    expect(currentVerification(objects, t.get('i')).matches(t.get('node'))).toBe(true);
    expect(
      currentVerification(
        objects.filter((e) => e.id !== 'z'),
        t.get('i'),
      ).matches(t.get('node')),
    ).toBe(false);
  } finally {
    t.db.close();
  }
});

it('节点及候选版本随完整资产恢复；历史摘要保留当时安排，导入拒绝错误的固定上下文', () => {
  const app = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  const restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  const broken = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = app.write.createProject(human, 'verification-archive', { name: '节点历史' });
    const write = (commands: CommandInput[]) =>
      app.write.execute(p.id, human, crypto.randomUUID(), {
        commands,
        expected: Object.fromEntries(app.repo.snapshot(p.id).objects.map((e) => [e.id, e.version])),
      });
    write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
    const binding = scope(app.repo.snapshot(p.id).objects, 'i');
    write([{ op: 'verification.confirm', id: 'node', ...binding, details }]);
    const assets = new AssetService(app.repo, app.write);
    const judgment = assets.recordJudgment(p.id, human, 'verification-judgment', '旧节点');
    write([
      {
        op: 'verification.confirm',
        id: 'node',
        ...binding,
        details: { ...details, event: '修订后的报告事件' },
      },
    ]);
    expect(assets.summary(p.id, judgment.id)).toContain('下一财年年度报告披露');
    expect(assets.summary(p.id, judgment.id)).not.toContain('修订后的报告事件');
    const archive = assets.export(p.id);
    new ArchiveService(restored.write, restored.search).import(human, 'node-restore-key', archive);
    expect(restored.repo.history(p.id, 'node')).toEqual(app.repo.history(p.id, 'node'));
    const changed = structuredClone(archive);
    for (const version of changed.versions)
      if (version.snapshot.kind === 'verification_node') version.snapshot.data.context = [];
    for (const object of changed.objects)
      if (object.kind === 'verification_node') object.data.context = [];
    expect(() =>
      new ArchiveService(broken.write, broken.search).import(human, 'bad-node-restore', changed),
    ).toThrow(/上下文/);
    expect(broken.repo.listProjects()).toHaveLength(0);
  } finally {
    app.db.close();
    restored.db.close();
    broken.db.close();
  }
});
