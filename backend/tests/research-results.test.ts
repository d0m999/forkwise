import { it, expect } from 'vitest';
import { initialResearchFixture } from './fixtures/initial-research.js';
import { human, statement, inference, expectedOf } from './helpers.js';
import { ResearchOverview, ObjectResearchResults } from '../src/contracts/research-results.js';
import {
  readResearchOverview,
  readObjectResearchResults,
} from '../src/services/research-results.js';
import { readLayout } from '../src/repositories/layout.js';
// @ts-expect-error Browser JavaScript projection is exercised here against the real read model.
import { canvasSnapshot } from '../web/canvas-bridge.js';
import { createApplication } from '../src/app.js';
import { AssetService } from '../src/services/assets.js';
import { ArchiveService } from '../src/services/archive.js';

it('对象查证读取区分候选、采用、旧上下文与无命中，保持个人立场并限制项目访问', async () => {
  const f = initialResearchFixture();
  const { app, p } = f;
  const token = app.access.issue('human', ['*']);
  const write = (commands: any[]) =>
    app.write.execute(p.id, human, crypto.randomUUID(), {
      expected: expectedOf(app.repo.snapshot(p.id).objects),
      commands,
    });
  const read = async (suffix = '/research-results', bearer = token) => {
    const response = await app.app.request(
      `http://127.0.0.1:8787/api/v1/projects/${p.id}${suffix}`,
      {
        headers: { Authorization: `Bearer ${bearer}` },
      },
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    write([statement('a'), statement('b'), inference('i', ['a'], 'b')]);
    // A real queued/running/completed task with no matching material must be visible
    // even though it never creates evidence objects or invokes the model.
    const job = app.researchTasks.request(p.id, human, 'no-matches-query', {
      kind: 'verify',
      sourceVersionIds: ['sv'],
      targetIds: ['i'],
      retrieval: { queries: ['DefinitelyAbsentToken'], maxCharacters: 20_000 },
    });
    await app.researchTasks.run(p.id, job.id);
    expect(app.jobs.get(p.id, job.id).state).toBe('succeeded');
    let result = await read();
    expect(result.status).toBe(200);
    let overview = ResearchOverview.parse(result.body.data);
    expect(overview.targets.find((x) => x.target.id === 'i')).toMatchObject({
      checks: { current: 1 },
      latest: { relation: 'insufficient' },
      evidence: { candidate: 0, adopted: 0 },
    });
    expect(f.calls.verify).toBe(0);
    const target = app.repo.snapshot(p.id).objects.find((e) => e.id === 'i')!;
    write([
      {
        op: 'evidence.create',
        id: 'ev',
        data: { citation: { sourceVersionId: 'sv', start: 0, end: 5, quote: 'CIK 1' } },
      },
      {
        op: 'evidence.link',
        id: 'link',
        data: {
          evidenceId: 'ev',
          target: { id: 'i', versionId: target.contentVersionId },
          relation: 'background',
          explanation: '合成材料背景，未证明观点',
          origin: 'ai',
          participation: 'candidate',
        },
      },
    ]);
    overview = ResearchOverview.parse((await read()).body.data);
    expect(overview.targets.find((x) => x.target.id === 'i')?.evidence).toMatchObject({
      candidate: 1,
      adopted: 0,
    });
    write([
      { op: 'evidence.adopt', id: 'link' },
      { op: 'stance.set', id: 'a', stance: { value: 'accepted', reason: '' } },
    ]);
    overview = ResearchOverview.parse((await read()).body.data);
    expect(overview.targets.find((x) => x.target.id === 'i')).toMatchObject({
      evidence: { candidate: 0, adopted: 1 },
      checks: { current: 1 },
    });
    write([{ op: 'statement.edit', id: 'a', text: '改写后的前提', scope: 'all' }]);
    overview = ResearchOverview.parse((await read()).body.data);
    expect(overview.targets.find((x) => x.target.id === 'i')).toMatchObject({
      evidence: { adopted: 0, stale: 1 },
      checks: { current: 0, stale: 1 },
      latest: null,
    });
    const detail = ObjectResearchResults.parse(
      (await read('/objects/i/research-results')).body.data,
    );
    expect(detail.evidenceLinks).toEqual([{ id: 'link', applicability: 'stale' }]);
    expect(detail.checks[0]).toMatchObject({
      jobId: job.id,
      applicability: 'stale',
      check: { relation: 'insufficient' },
      coverage: { modelCalled: false },
    });
    expect(detail.checks[0]?.taskGaps.length).toBeGreaterThan(0);
    expect(app.repo.snapshot(p.id).objects.find((e) => e.id === 'i')?.data).toMatchObject({
      stance: { value: 'pending' },
    });
    const other = app.write.createProject(human, 'other-project-key', { name: '其他项目' });
    const otherToken = app.access.issue('agent', [other.id]);
    expect((await read('/research-results', otherToken)).status).toBe(403);
    expect((await read('/objects/i/research-results', otherToken)).status).toBe(403);
    expect((await read('/objects/missing/research-results')).status).toBe(404);
    expect((await read('/objects/i/research-results?cursor=invalid')).status).toBe(400);
  } finally {
    f.close();
  }
});

it('首次研究的查证投影不以验证节点代替依据；撤销/重做与资产恢复保留适用性', async () => {
  const f = initialResearchFixture();
  const restored = createApplication({ database: ':memory:', origin: 'http://127.0.0.1:8787' });
  try {
    const job = f.app.initialResearch.request(f.p.id, human, 'overview-initial', {
      sourceVersionIds: ['sv'],
    });
    expect((await f.app.initialResearch.run(f.p.id, job.id)).state).toBe('succeeded');
    const overview = readResearchOverview(f.app.repo, f.p.id);
    ResearchOverview.parse(overview);
    expect(overview.targets).toHaveLength(3);
    expect(
      overview.targets.every((t) => t.evidence.candidate === 1 && t.checks.current === 1),
    ).toBe(true);
    const prediction = overview.targets.find((t) => t.latest?.aspect === 'current_basis')!;
    const state = f.app.repo.snapshot(f.p.id),
      layout = readLayout(f.app.repo, f.p.id);
    const canvas = canvasSnapshot(state, layout, null, 1, overview);
    const card = canvas.cards.find((c: any) => c.id === prediction.target.id);
    expect(card).toMatchObject({ verification: '候选依据 1', stance: '待研究' });
    expect(card.verificationSummary).toContain('预测的当前依据');
    const staleCanvas = canvasSnapshot(
      { ...state, project: { ...state.project, revision: state.project.revision + 1 } },
      layout,
      null,
      1,
      overview,
    );
    expect(staleCanvas.cards.every((c: any) => c.verification === '查证摘要待更新')).toBe(true);
    const travel = (direction: 'undo' | 'redo') =>
      f.app.write.travel(f.p.id, human, crypto.randomUUID(), {
        direction,
        expectedRevision: f.app.repo.project(f.p.id).revision,
        expectedHistoryVersion: f.app.write.history(f.p.id).version,
        expectedLayoutVersion: readLayout(f.app.repo, f.p.id).version,
      });
    travel('undo');
    expect(readResearchOverview(f.app.repo, f.p.id).targets).toEqual([]);
    travel('redo');
    expect(readResearchOverview(f.app.repo, f.p.id).targets).toEqual(overview.targets);
    const archive = new AssetService(f.app.repo, f.app.write).export(f.p.id);
    new ArchiveService(restored.write, restored.search).import(human, 'results-restore', archive);
    expect(readResearchOverview(restored.repo, f.p.id).targets).toEqual(overview.targets);
    expect(
      readObjectResearchResults(restored.repo, f.p.id, prediction.target.id, {}).checks[0],
    ).toMatchObject({
      applicability: 'current',
      check: { aspect: 'current_basis' },
    });
  } finally {
    restored.db.close();
    f.close();
  }
});

it('分页游标在同一完成时点仍不重复或遗漏，不返回任务原文；历史上下文缺失不能算当前', async () => {
  const f = initialResearchFixture();
  try {
    f.app.write.execute(f.p.id, human, 'pagination-targets', {
      expected: {},
      commands: [statement('a'), statement('b'), inference('i', ['a'], 'b')],
    });
    const ids: string[] = [];
    for (const token of ['AbsentOne', 'AbsentTwo', 'AbsentThree']) {
      const job = f.app.researchTasks.request(f.p.id, human, token, {
        kind: 'verify',
        sourceVersionIds: ['sv'],
        targetIds: ['i'],
        retrieval: { queries: [token] },
      });
      await f.app.researchTasks.run(f.p.id, job.id);
      f.app.db
        .prepare('UPDATE jobs SET updated_at=? WHERE id=?')
        .run('2026-10-09T00:00:00.000Z', job.id);
      ids.push(job.id);
    }
    let cursor: string | undefined,
      seen: string[] = [];
    do {
      const page = readObjectResearchResults(f.app.repo, f.p.id, 'i', {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.checks).toHaveLength(1);
      seen.push(page.checks[0]!.jobId);
      expect(JSON.stringify(page)).not.toContain('CIK 1 本季营收增长');
      if (page.nextCursor)
        expect(() =>
          readObjectResearchResults(f.app.repo, f.p.id, 'a', { cursor: page.nextCursor }),
        ).toThrow(/分页/);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...ids].sort().reverse());
    f.app.db
      .prepare("UPDATE jobs SET input=json_set(input,'$.context',json('[]')) WHERE id=?")
      .run(ids[0]);
    expect(
      readResearchOverview(f.app.repo, f.p.id).targets.find((x) => x.target.id === 'i')?.checks,
    ).toMatchObject({ current: 2, unbound: 1 });
    expect(
      readObjectResearchResults(f.app.repo, f.p.id, 'i', {}).checks.find((x) => x.jobId === ids[0])
        ?.applicability,
    ).toBe('unbound');
  } finally {
    f.close();
  }
});

it('整次任务因其他目标变化而未应用，未变目标的核对也不能冒充已应用结果', async () => {
  const f = initialResearchFixture();
  try {
    const initial = f.app.initialResearch.request(f.p.id, human, 'late-overview-initial', {
      sourceVersionIds: ['sv'],
    });
    await f.app.initialResearch.run(f.p.id, initial.id);
    const state = f.app.repo.snapshot(f.p.id);
    const targets = state.objects.filter((e) => e.kind === 'statement');
    const material = state.objects.find((e) => e.kind === 'source_version' && e.id !== 'sv')!;
    const job = f.app.researchTasks.request(f.p.id, human, 'late-two-targets', {
      kind: 'verify',
      sourceVersionIds: [material.id],
      targetIds: targets.map((x) => x.id),
    });
    f.hooks.duringVerify = async () => {
      f.app.write.execute(f.p.id, human, 'change-one-target', {
        expected: expectedOf(f.app.repo.snapshot(f.p.id).objects),
        commands: [
          { op: 'statement.edit', id: targets[0]!.id, text: '任务执行期间改写', scope: 'all' },
        ],
      });
    };
    await f.app.researchTasks.run(f.p.id, job.id);
    expect(f.app.jobs.get(f.p.id, job.id).output).toMatchObject({ stale: true, changes: null });
    const result = readObjectResearchResults(f.app.repo, f.p.id, targets[1]!.id, {});
    expect(result.checks.find((x) => x.jobId === job.id)?.applicability).toBe('stale');
  } finally {
    f.close();
  }
});
