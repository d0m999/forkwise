import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../src/app.js';
import { human, statement, inference, expectedOf } from './helpers.js';

import { manualUpdateFixture as fixture } from './fixtures/manual-update.js';

it('先预览材料和明确目标，再原子保存材料与排队；同一材料和范围复用任务，新增范围才补分析', async () => {
  const f = fixture();
  try {
    const before = f.state();
    const preview = f.app.manualUpdates.preview(f.project.id, f.input);
    expect(f.state()).toEqual(before);
    expect(f.app.jobs.list(f.project.id)).toEqual([]);
    expect(preview).toMatchObject({
      newMaterial: true,
      newTargetIds: ['a', 'i'],
      estimate: { newTaskCount: 1, estimatedCost: null },
    });
    const saved = f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
      ...f.input,
      previewHash: preview.previewHash,
    });
    expect(saved.createdJobId).toBeTruthy();
    expect(saved.changes.upserted.map((e: any) => e.kind)).toEqual(['source_version']);
    const result = await f.app.researchTasks.run(f.project.id, saved.createdJobId!);
    expect(result.state).toBe('succeeded');
    const again = f.app.manualUpdates.preview(f.project.id, {
      ...f.input,
      material: { ...f.input.material, retrievedAt: new Date().toISOString() },
    });
    expect(again.newTargetIds).toEqual([]);
    const repeated = f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
      ...f.input,
      previewHash: f.app.manualUpdates.preview(f.project.id, f.input).previewHash,
    });
    expect(repeated.createdJobId).toBeNull();
    expect(repeated.eventKey).toBe(saved.eventKey);
    expect(f.app.jobs.list(f.project.id)).toHaveLength(1);
    expect(f.state().objects.filter((e) => e.kind === 'source_version')).toHaveLength(1);
    const expanded = { ...f.input, targetIds: ['a', 'b', 'i'] };
    const more = f.app.manualUpdates.preview(f.project.id, expanded);
    expect(more.newTargetIds).toEqual(['b']);
    const extra = f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
      ...expanded,
      previewHash: more.previewHash,
    });
    expect(
      (f.app.jobs.get(f.project.id, extra.createdJobId!).input as any).targets.map(
        (e: any) => e.id,
      ),
    ).toEqual(['b']);
    expect(f.state().objects.filter((e) => ['statement', 'inference'].includes(e.kind))).toEqual(
      before.objects.filter((e) => ['statement', 'inference'].includes(e.kind)),
    );
  } finally {
    f.app.db.close();
  }
});

it('预览后的前提变化拒绝整批提交；失败可重试，取消后主动重开，来源身份和重述版本分开', async () => {
  const f = fixture();
  try {
    const preview = f.app.manualUpdates.preview(f.project.id, f.input);
    f.write([{ op: 'statement.edit', id: 'a', text: '前提已经改写', scope: 'all' }]);
    const before = f.state();
    expect(() =>
      f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
        ...f.input,
        previewHash: preview.previewHash,
      }),
    ).toThrow(/重新预览/);
    expect(f.state()).toEqual(before);
    expect(f.app.jobs.list(f.project.id)).toHaveLength(0);
    const submit = (input = f.input) =>
      f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
        ...input,
        previewHash: f.app.manualUpdates.preview(f.project.id, input).previewHash,
      });
    const first = submit();
    f.app.researchTasks.cancel(f.project.id, first.createdJobId!);
    const reopened = submit();
    expect(reopened.createdJobId).not.toBe(first.createdJobId);
    expect(f.app.jobs.get(f.project.id, reopened.createdJobId!).state).toBe('queued');
    expect(reopened.eventKey).toBe(first.eventKey);
    const restated = submit({
      ...f.input,
      material: { ...f.input.material, text: '新增披露修正了之前的范围。' },
    });
    expect(restated.eventKey).not.toBe(first.eventKey);
    f.write([
      {
        op: 'source.create',
        id: 'different-source',
        data: { title: '另一出处', publisher: '测试', rights: 'public' },
      },
    ]);
    const other = submit({
      ...f.input,
      material: { ...f.input.material, sourceId: 'different-source' },
    });
    expect(other.eventKey).not.toBe(first.eventKey);
    const existing = {
      scopeLabel: f.input.scopeLabel,
      material: { kind: 'existing', sourceVersionId: first.sourceVersionId },
      targetIds: f.input.targetIds,
    };
    expect(f.app.manualUpdates.preview(f.project.id, existing).newTargetIds).toEqual([]);
    const literal = submit({
      ...f.input,
      material: { ...f.input.material, text: '  新增披露保留原文空白。\n' },
    });
    expect(f.app.repo.material(f.project.id, literal.sourceVersionId)).toBe(
      '  新增披露保留原文空白。\n',
    );
  } finally {
    f.app.db.close();
  }
});

it('HTTP 预览无副作用，同键恢复只排队一次；更新按来源事件聚合并可分页读取任务', async () => {
  const f = fixture();
  try {
    const token = f.app.access.issue('human', ['*']);
    const call = async (path: string, method = 'GET', body?: unknown, key?: string) =>
      f.app.app.request(`http://127.0.0.1:8787/api/v1/projects/${f.project.id}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const p = await call('/manual-updates/preview', 'POST', f.input);
    expect(p.status).toBe(200);
    const preview = (await p.json()).data,
      key = randomUUID(),
      body = { ...f.input, previewHash: preview.previewHash };
    const first = await call('/manual-updates', 'POST', body, key),
      retry = await call('/manual-updates', 'POST', body, key);
    expect(first.status).toBe(200);
    expect(await retry.json()).toEqual(await first.clone().json());
    const saved = (await first.json()).data;
    await f.app.researchTasks.run(f.project.id, saved.createdJobId);
    const extra = { ...f.input, targetIds: ['b'] };
    f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
      ...extra,
      previewHash: f.app.manualUpdates.preview(f.project.id, extra).previewHash,
    });
    const events = await call('/manual-updates');
    expect(events.status).toBe(200);
    expect((await events.json()).data.items).toMatchObject([
      { eventKey: saved.eventKey, taskCount: 2, proposalCount: 2 },
    ]);
    const tasks = await call(`/manual-updates/${saved.eventKey}/tasks?limit=1`);
    expect(tasks.status).toBe(200);
    const page = (await tasks.json()).data;
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = (
      await (
        await call(
          `/manual-updates/${saved.eventKey}/tasks?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
        )
      ).json()
    ).data;
    expect(next.items[0].id).not.toBe(page.items[0].id);
    expect(JSON.stringify(page)).not.toContain(f.input.material.text);
    const foreign = f.app.access.issue('agent', ['different-project']);
    const denied = await f.app.app.request(
      `http://127.0.0.1:8787/api/v1/projects/${f.project.id}/manual-updates`,
      { headers: { Authorization: `Bearer ${foreign}` } },
    );
    expect(denied.status).toBe(403);
  } finally {
    f.app.db.close();
  }
});

it('存档恢复保留更新归集与已分析范围，伪造目标范围或材料归属原子拒绝', async () => {
  const { AssetService } = await import('../src/services/assets.js');
  const { ArchiveService } = await import('../src/services/archive.js');
  const f = fixture();
  const restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const p = f.app.manualUpdates.preview(f.project.id, f.input);
    const saved = f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
      ...f.input,
      previewHash: p.previewHash,
    });
    await f.app.researchTasks.run(f.project.id, saved.createdJobId!);
    const archive = new AssetService(f.app.repo, f.app.write).export(f.project.id);
    new ArchiveService(restored.write, restored.search).import(human, randomUUID(), archive);
    expect(restored.manualUpdates.preview(f.project.id, f.input).newTargetIds).toEqual([]);
    for (const corrupt of [
      (v: any) => {
        v.tasks[0].input.update.bindings = [];
      },
      (v: any) => {
        v.tasks[0].input.update.sourceId = 'forged';
      },
      (v: any) => {
        v.tasks[0].input.sourceVersionIds = ['forged'];
      },
      (v: any) => {
        v.tasks[0].input.targets[0].data.text = '伪造目标内容';
      },
      (v: any) => {
        v.tasks[0].input.context.push(v.tasks[0].input.context[0]);
      },
      (v: any) => {
        v.tasks[0].input.materials[0].version.data.parseMessage = '伪造材料元数据';
      },
    ]) {
      const other = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
      try {
        const broken = structuredClone(archive);
        corrupt(broken);
        expect(() =>
          new ArchiveService(other.write, other.search).import(human, randomUUID(), broken),
        ).toThrow();
        expect(other.repo.listProjects()).toHaveLength(0);
      } finally {
        other.db.close();
      }
    }
  } finally {
    f.app.db.close();
    restored.db.close();
  }
});

it('排队容量不足整批回滚，已有失败任务继续复用且可显式重试；个人立场变化不重复生成候选', async () => {
  const f = fixture();
  try {
    const p = f.app.manualUpdates.preview(f.project.id, f.input);
    const saved = f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
      ...f.input,
      previewHash: p.previewHash,
    });
    f.app.researchTasks.model!.generate = async () => {
      throw new Error('合成模型不可用');
    };
    expect((await f.app.researchTasks.run(f.project.id, saved.createdJobId!)).state).toBe('failed');
    expect(f.app.manualUpdates.preview(f.project.id, f.input).newTargetIds).toEqual([]);
    f.app.jobs.retry(f.project.id, saved.createdJobId!);
    f.write([{ op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '本人独立确认' } }]);
    expect(f.app.manualUpdates.preview(f.project.id, f.input).newTargetIds).toEqual([]);
    for (let i = 0; i < 99; i++)
      f.app.jobs.enqueue(f.project.id, 'fixture.backlog', {}, `fixture-${i}`);
    const next = { ...f.input, material: { ...f.input.material, text: '另一份未保存的合成披露' } };
    const preview = f.app.manualUpdates.preview(f.project.id, next),
      before = f.state();
    expect(() =>
      f.app.manualUpdates.request(f.project.id, human, randomUUID(), {
        ...next,
        previewHash: preview.previewHash,
      }),
    ).toThrow(/任务过多/);
    expect(f.state()).toEqual(before);
    expect(f.app.jobs.list(f.project.id)).toHaveLength(100);
  } finally {
    f.app.db.close();
  }
});
