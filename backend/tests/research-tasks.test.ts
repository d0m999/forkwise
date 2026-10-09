import { it, expect } from 'vitest';
import { z } from 'zod';
import { createApplication } from '../src/app.js';
import type { StructuredModel } from '../src/services/research-tasks.js';
import { human, statement } from './helpers.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';

const citation = { sourceVersionId: 'sv', start: 0, end: 5, quote: '订单增长。' };
function fixture(result: unknown) {
  const model: StructuredModel = {
    async generate<S extends z.ZodType>(schema: S) {
      return { result: schema.parse(result) as z.infer<S>, usage: { cost: null, inputTokens: 10 } };
    },
  };
  const app = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    researchModel: model,
  });
  const p = app.write.createProject(human, 'research-project', { name: '任务研究' });
  app.write.execute(p.id, human, 'research-material', {
    expected: {},
    commands: [
      statement('target'),
      {
        op: 'source.create',
        id: 's',
        data: { title: '测试材料', publisher: '', rights: 'authorized' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 's',
        text: '订单增长。收入可能增加。',
        retrievedAt: '2025-01-01T00:00:00Z',
        publishedAt: null,
      },
    ],
  });
  return { app, p };
}
it('重建只产生可溯源参考/AI 候选，多条独立理由分别保留，幂等任务不重复写入', async () => {
  const output = {
    statements: [
      { key: 'a', text: '订单增长', origin: 'author', citations: [citation], gaps: [] },
      { key: 'b', text: '利润可能增长', origin: 'ai', citations: [], gaps: ['成本未知'] },
    ],
    inferences: [
      {
        key: 'i',
        premiseKeys: ['a'],
        conclusionKey: 'b',
        reason: '订单可能带来收入',
        combination: 'independent',
        origin: 'ai',
        citations: [],
        gaps: [],
      },
    ],
    gaps: [],
  };
  const { app, p } = fixture(output);
  try {
    const input = { kind: 'reconstruct', sourceVersionIds: ['sv'], targetIds: [] };
    const job = app.researchTasks.request(p.id, human, 'reconstruct-key', input);
    await app.researchTasks.drain();
    expect(app.jobs.get(p.id, job.id).state).toBe('succeeded');
    const objects = app.repo.snapshot(p.id).objects.filter((e) => e.id.startsWith('candidate_'));
    expect(objects).toHaveLength(3);
    expect(
      objects.every((e) => (e.data as { stance: { value: string } }).stance.value === 'pending'),
    ).toBe(true);
    expect(app.researchTasks.request(p.id, human, 'another-request-key', input).id).toBe(job.id);
    await app.researchTasks.drain();
    expect(
      app.repo.snapshot(p.id).objects.filter((e) => e.id.startsWith('candidate_')),
    ).toHaveLength(3);
  } finally {
    app.db.close();
  }
});
it('伪造引文的重建整批拒绝，不损失材料或写入一半图谱', async () => {
  const { app, p } = fixture({
    statements: [
      {
        key: 'a',
        text: '虚构',
        origin: 'author',
        citations: [{ ...citation, quote: '不在原文' }],
        gaps: [],
      },
    ],
    inferences: [],
    gaps: [],
  });
  try {
    const before = app.repo.snapshot(p.id);
    const job = app.researchTasks.request(p.id, human, 'invalid-citation', {
      kind: 'reconstruct',
      sourceVersionIds: ['sv'],
      targetIds: [],
    });
    await app.researchTasks.drain();
    expect(app.jobs.get(p.id, job.id).error).toContain('INVALID_CITATION');
    expect(app.repo.snapshot(p.id)).toEqual(before);
  } finally {
    app.db.close();
  }
});
it('AI 理由不自动写立场；本人使用时固定目标版本与 AI 来历，导出后仍可回查任务', async () => {
  const output: { proposals: unknown[]; gaps: string[] } = { proposals: [], gaps: [] };
  const { app, p } = fixture(output);
  const b = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const target = app.repo.snapshot(p.id).objects.find((e) => e.id === 'target')!;
    output.proposals = [
      {
        target: { id: 'target', versionId: target.contentVersionId },
        reason: '材料只涉及订单，需要继续核对成本',
        citations: [citation],
        gaps: ['成本未知'],
      },
    ];
    const job = app.researchTasks.request(p.id, human, 'draft-reason-key', {
      kind: 'stance_draft',
      sourceVersionIds: ['sv'],
      targetIds: ['target'],
    });
    await app.researchTasks.drain();
    expect(app.repo.snapshot(p.id).objects.find((e) => e.id === 'target')).toEqual(target);
    app.write.execute(p.id, human, 'confirm-reason-key', {
      expected: { target: 1 },
      commands: [
        {
          op: 'stance.set',
          id: 'target',
          stance: {
            value: 'questioned',
            reason: '材料只涉及订单，需要继续核对成本',
            reasonProvenance: { jobId: job.id, proposalIndex: 0, modified: false },
          },
        },
      ],
    });
    const exported = new AssetService(app.repo, app.write).export(p.id);
    new ArchiveService(b.write, b.search).import(human, 'import-with-task', exported);
    expect(b.jobs.get(p.id, job.id).output).toEqual(app.jobs.get(p.id, job.id).output);
    expect(b.repo.snapshot(p.id)).toEqual(app.repo.snapshot(p.id));
  } finally {
    app.db.close();
    b.db.close();
  }
});
it('目标在模型运行时改变，晚到核查保留旧版本结果，不能关联成当前依据', async () => {
  let complete!: (value: unknown) => void;
  const { app, p } = fixture({});
  const tasks = app.researchTasks;
  Object.assign(tasks, {
    model: {
      generate: () =>
        new Promise((resolve) => {
          complete = (value) => resolve({ result: value, usage: { cost: null } });
        }),
    },
  });
  try {
    const target = app.repo.snapshot(p.id).objects.find((e) => e.id === 'target')!;
    const job = tasks.request(p.id, human, 'stale-check-key', {
      kind: 'verify',
      sourceVersionIds: ['sv'],
      targetIds: ['target'],
    });
    const running = tasks.run(p.id, job.id);
    app.write.execute(p.id, human, 'edit-during-check', {
      expected: { target: 1 },
      commands: [{ op: 'statement.edit', id: 'target', text: '新目标', scope: 'all' }],
    });
    complete({
      checks: [
        {
          target: { id: 'target', versionId: target.contentVersionId },
          relation: 'supports',
          explanation: '旧目标核查',
          citations: [citation],
          gaps: [],
        },
      ],
      gaps: [],
    });
    await running;
    expect(app.jobs.get(p.id, job.id).output).toMatchObject({ stale: true, changes: null });
    expect(app.repo.snapshot(p.id).objects.some((e) => e.kind === 'evidence_link')).toBe(false);
  } finally {
    app.db.close();
  }
});

it('影响建议采用须本人确认和显式范围，局部采用固定旧版本与 AI 来历；旧证据不复制', async () => {
  const output: { proposals: unknown[]; gaps: string[] } = { proposals: [], gaps: [] };
  const { app, p } = fixture(output);
  const imported = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const { inference } = await import('./helpers.js');
    app.write.execute(p.id, human, 'impact-related', {
      expected: { target: 1 },
      commands: [
        statement('b'),
        statement('c'),
        inference('i', ['target'], 'b'),
        inference('j', ['target'], 'c'),
      ],
    });
    const target = app.repo.snapshot(p.id).objects.find((e) => e.id === 'target')!;
    output.proposals = [
      {
        target: { id: target.id, versionId: target.contentVersionId },
        proposedText: '订单增长但成本仍未知',
        reason: '新材料只确认订单',
        citations: [citation],
        gaps: ['成本未知'],
      },
    ];
    const job = app.researchTasks.request(p.id, human, 'impact-candidate', {
      kind: 'impact',
      sourceVersionIds: ['sv'],
      targetIds: ['target'],
    });
    await app.researchTasks.drain();
    expect(app.repo.snapshot(p.id).objects.find((e) => e.id === 'target')).toEqual(target);
    const command = {
      op: 'impact.adopt',
      id: 'target',
      jobId: job.id,
      proposalIndex: 0,
      text: '订单增长但成本仍未知',
      scope: 'selected',
      newId: 'local',
      inferenceIds: ['i'],
    };
    expect(() =>
      app.write.execute(p.id, { id: 'agent', type: 'agent' }, 'agent-adopt-impact', {
        expected: { target: 1, i: 1 },
        commands: [command],
      }),
    ).toThrow('本人');
    const adopted = app.write.execute(p.id, human, 'human-adopt-impact', {
      expected: { target: 1, i: 1 },
      commands: [command],
    });
    const local = adopted.upserted.find((e) => e.id === 'local')!;
    expect(local.data).toMatchObject({
      text: command.text,
      citations: [citation],
      stance: { value: 'pending' },
      editProvenance: {
        jobId: job.id,
        proposalIndex: 0,
        previous: { id: 'target', versionId: target.versionId },
        scope: 'selected',
        modified: false,
      },
    });
    expect(app.repo.snapshot(p.id).objects.find((e) => e.id === 'target')).toEqual(target);
    expect(app.repo.snapshot(p.id).objects.find((e) => e.id === 'j')?.data).toMatchObject({
      premiseIds: ['target'],
    });
    expect(app.repo.snapshot(p.id).objects.find((e) => e.id === 'i')?.data).toMatchObject({
      premiseIds: ['local'],
    });
    const archive = new AssetService(app.repo, app.write).export(p.id);
    new ArchiveService(imported.write, imported.search).import(
      human,
      'import-impact-archive',
      archive,
    );
    expect(imported.repo.snapshot(p.id)).toEqual(app.repo.snapshot(p.id));
    app.write.execute(p.id, human, 'change-impact-target', {
      expected: { target: 1, j: 1 },
      commands: [{ op: 'statement.edit', id: 'target', scope: 'all', text: '另一个内容版本' }],
    });
    expect(() =>
      app.write.execute(p.id, human, 'stale-impact-adopt', {
        expected: { target: 2, j: 1 },
        commands: [{ ...command, scope: 'all', newId: undefined, inferenceIds: [] }],
      }),
    ).toThrow('旧内容版本');
  } finally {
    app.db.close();
    imported.db.close();
  }
});
