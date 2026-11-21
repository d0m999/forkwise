import { AssetService } from '../src/services/assets.js';
import { redactRestrictedBackup } from '../src/services/redact-backup.js';
import { it, expect } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../src/app.js';
import { human, agent } from './helpers.js';
import type { VisionModel } from '../src/services/transcription.js';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jNioAAAAASUVORK5CYII=';
async function fixture(
  model?: VisionModel,
  rights: 'authorized' | 'restricted' = 'authorized',
  database = ':memory:',
) {
  const app = createApplication({
    database,
    origin: 'http://127.0.0.1:8787',
    ...(model ? { visionModel: model } : {}),
  });
  const p = app.write.createProject(human, 'vision-project', { name: '转写测试' });
  app.write.execute(p.id, human, 'vision-source', {
    expected: {},
    commands: [
      {
        op: 'source.create',
        id: 's',
        data: { title: '测试像素（转写内容由 fixture 提供）', rights, publisher: '' },
      },
    ],
  });
  const uploaded = app.files.upload(p.id, human, 'vision-upload', {
    sourceId: 's',
    expectedSourceVersion: 1,
    name: 'fixture.png',
    mime: 'image/png',
    base64: png,
    publishedAt: '2026-01-01T00:00:00Z',
  });
  await app.files.drain();
  return {
    app,
    p,
    sourceVersionId: (app.jobs.get(p.id, uploaded.job.id).output as { sourceVersionId: string })
      .sourceVersionId,
  };
}
it('多模态转写保留原图与未核对区域；人工校正另存版本，旧引用保持有效', async () => {
  let images: string[] | undefined;
  const model: VisionModel = {
    async generate<S extends z.ZodType>(
      schema: S,
      _purpose: string,
      _data: unknown,
      _signal: AbortSignal,
      inputImages?: string[],
    ) {
      images = inputImages;
      return {
        result: schema.parse({
          blocks: [
            { text: '收入 12', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: false },
          ],
          gaps: [],
        }),
        usage: { inputTokens: 4 },
      };
    },
  };
  const { app, p, sourceVersionId } = await fixture(model);
  try {
    const job = app.transcription.request(p.id, agent, 'vision-request', {
      sourceVersionId,
      page: 1,
    });
    await app.transcription.drain();
    const finished = app.jobs.get(p.id, job.id);
    expect(finished.state).toBe('succeeded');
    expect(images).toEqual([png]);
    const result = finished.output as { sourceVersionId: string };
    const artifact = app.files.artifact(p.id, result.sourceVersionId);
    expect(artifact.regions[0]).toMatchObject({
      verification: 'unverified',
      page: 1,
      coordinateSystem: 'normalized-image',
    });
    app.write.execute(p.id, human, 'old-transcription-evidence', {
      expected: {},
      commands: [
        {
          op: 'evidence.create',
          id: 'e',
          data: {
            citation: {
              sourceVersionId: result.sourceVersionId,
              start: 0,
              end: 5,
              quote: '收入 12',
              visualRegionId: 'r1',
            },
          },
        },
      ],
    });
    const input = {
      sourceVersionId: result.sourceVersionId,
      page: 1,
      blocks: [{ text: '收入 13', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: false }],
      reason: '测试人工校正',
      confirmedAgainstImage: true,
    };
    expect(() => app.transcription.correct(p.id, agent, 'reject-agent-correction', input)).toThrow(
      '本人',
    );
    const corrected = app.transcription.correct(p.id, human, 'correct-transcription', input);
    expect(corrected.artifact.regions[0]).toMatchObject({ verification: 'human_verified' });
    expect(app.repo.material(p.id, result.sourceVersionId)).toBe('收入 12\n');
    expect(app.repo.material(p.id, corrected.sourceVersionId)).toBe('收入 13\n');
    expect(
      app.repo.snapshot(p.id).objects.find((e) => e.id === corrected.sourceVersionId)?.data,
    ).toMatchObject({
      derivedFrom: result.sourceVersionId,
      publishedAt: '2026-01-01T00:00:00Z',
      textOrigin: 'human_correction',
    });
    expect(app.transcription.correct(p.id, human, 'correct-transcription', input)).toEqual(
      corrected,
    );
  } finally {
    app.db.close();
  }
});
it.each(['partial', 'queued'] as const)(
  '停用视觉模型后，旧 %s 转写任务的原结果、文字版本和用量保留',
  async (oldState) => {
    const directory = mkdtempSync(join(tmpdir(), 'forkwise-vision-retired-'));
    const database = join(directory, 'research.sqlite');
    const origin = 'http://127.0.0.1:8787';
    const usage = { provider: 'ollama-local', inputTokens: 12, outputTokens: 7, cost: null };
    const model: VisionModel = {
      async generate(schema) {
        return {
          result: schema.parse({
            blocks: [
              { text: '旧转写', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: true },
            ],
            gaps: ['旧图模糊'],
          }),
          usage,
        };
      },
    };
    let reopened: ReturnType<typeof createApplication> | undefined;
    const { app, p, sourceVersionId } = await fixture(model, 'authorized', database);
    try {
      const job = app.transcription.request(p.id, human, 'historical-transcription', {
        sourceVersionId,
        page: 1,
      });
      await app.transcription.drain();
      const before = app.jobs.get(p.id, job.id);
      expect(before).toMatchObject({ state: 'partial', attempt: 1, usage });
      const version = (before.output as { sourceVersionId: string }).sourceVersionId;
      if (oldState === 'queued') app.jobs.retry(p.id, job.id);
      app.db.close();
      reopened = createApplication({ database, origin });
      reopened.jobs.recover();
      await reopened.transcription.drain();
      const token = reopened.access.issue('human', ['*']);
      const response = await reopened.app.request(
        `${origin}/api/v1/projects/${p.id}/jobs/${job.id}/retry`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': 'retry-after-retirement',
          },
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'MODEL_RETRY_UNAVAILABLE' });
      const actual = reopened.jobs.get(p.id, job.id);
      if (oldState === 'partial') expect(actual).toEqual(before);
      else
        expect(actual).toMatchObject({
          state: 'interrupted',
          attempt: before.attempt,
          output: before.output,
          usage,
        });
      expect(
        reopened.jobs.summaries(p.id).find((row) => row.id === job.id)?.retryBlockedByModel,
      ).toBe(true);
      expect(reopened.repo.material(p.id, version)).toBe('旧转写\n');
    } finally {
      if (app.db.open) app.db.close();
      reopened?.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
it('模型未配置明确失败，仍允许本人对照截图补交文字', async () => {
  const { app, p, sourceVersionId } = await fixture();
  try {
    const task = app.transcription.request(p.id, human, 'vision-unconfigured', {
      sourceVersionId,
      page: 1,
    });
    await app.transcription.drain();
    expect(app.jobs.get(p.id, task.id).error).toContain('VISION_NOT_CONFIGURED');
    const corrected = app.transcription.correct(p.id, human, 'manual-image-text', {
      sourceVersionId,
      page: 1,
      blocks: [
        { text: '本人补交转写', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: true },
      ],
      reason: '仍有模糊处',
      confirmedAgainstImage: true,
    });
    expect(corrected.artifact.status).toBe('partial');
    expect(corrected.artifact.regions[0]?.uncertain).toBe(true);
  } finally {
    app.db.close();
  }
});

it('受限转写原文在 JSON 导出与备份任务输出中均被移除', async () => {
  const model: VisionModel = {
    async generate<S extends z.ZodType>(schema: S) {
      return {
        result: schema.parse({
          blocks: [
            {
              text: 'PRIVATE_OCR_RAW',
              region: { x: 0, y: 0, width: 1, height: 1 },
              uncertain: false,
            },
          ],
          gaps: [],
        }),
        usage: null,
      };
    },
  };
  const { app, p, sourceVersionId } = await fixture(model, 'restricted');
  try {
    app.transcription.request(p.id, human, 'restricted-image-text', { sourceVersionId, page: 1 });
    await app.transcription.drain();
    expect(JSON.stringify(new AssetService(app.repo, app.write).export(p.id))).not.toContain(
      'PRIVATE_OCR_RAW',
    );
    redactRestrictedBackup(app.db);
    expect(JSON.stringify(app.db.prepare('SELECT input,output FROM jobs').all())).not.toContain(
      'PRIVATE_OCR_RAW',
    );
  } finally {
    app.db.close();
  }
});

it('校正后自动分析当前受影响内容，引用新转写；旧证据、人工确认与无关对象保持', async () => {
  const { app, p, sourceVersionId } = await fixture();
  try {
    const input = {
      sourceVersionId,
      page: 1,
      blocks: [{ text: '收入 12', region: { x: 0, y: 0, width: 1, height: 1 }, uncertain: false }],
      reason: '初次补交',
      confirmedAgainstImage: true,
    };
    const prior = app.transcription.correct(p.id, human, 'initial-human-text', input);
    const oldCitation = {
      sourceVersionId: prior.sourceVersionId,
      start: 0,
      end: 5,
      quote: '收入 12',
    };
    const { statement, inference } = await import('./helpers.js');
    app.write.execute(p.id, human, 'refer-prior-text', {
      expected: {},
      commands: [
        statement('a'),
        statement('b'),
        statement('unrelated'),
        inference('i', ['a'], 'b'),
        { op: 'evidence.create', id: 'ev', data: { citation: oldCitation } },
      ],
    });
    const a = app.repo.snapshot(p.id).objects.find((e) => e.id === 'a')!;
    app.write.execute(p.id, human, 'reference-old-evidence', {
      expected: { a: 1, ev: 1, i: 1 },
      commands: [
        {
          op: 'evidence.link',
          id: 'link',
          data: {
            evidenceId: 'ev',
            target: { id: 'a', versionId: a.contentVersionId },
            relation: 'supports',
            explanation: '旧转写依据',
            origin: 'human',
            participation: 'adopted',
          },
        },
        {
          op: 'condition.create',
          id: 'cond',
          data: { description: '收入符合条件', mode: 'qualitative', targetIds: ['i'] },
        },
      ],
    });
    const cond = app.repo.snapshot(p.id).objects.find((e) => e.id === 'cond')!;
    app.write.execute(p.id, human, 'confirm-old-condition', {
      expected: { cond: 1, ev: 1 },
      commands: [
        {
          op: 'evaluation.confirm',
          id: 'confirmed',
          condition: { id: 'cond', versionId: cond.contentVersionId },
          verdict: 'satisfied',
          reason: '当时核对',
          evidenceIds: ['ev'],
          citations: [oldCitation],
        },
      ],
    });
    const before = app.repo.snapshot(p.id);
    const correction = {
      ...input,
      sourceVersionId: prior.sourceVersionId,
      blocks: [{ ...input.blocks[0], text: '收入 13' }],
      reason: '数字识别错误',
    };
    const jobsBefore = app.jobs.list(p.id);
    const manual = app.transcription.correct(p.id, human, 'correct-without-model', correction);
    expect(manual.impactAnalysis.targetIds.sort()).toEqual(['a', 'i']);
    expect(manual.impactAnalysis.conditionIds).toEqual(['cond']);
    expect(manual.impactAnalysis.jobIds).toEqual([]);
    expect(manual.impactAnalysis.gap).toContain('本机模型已停用');
    expect(app.files.artifact(p.id, manual.sourceVersionId).impactAnalysis).toEqual(
      manual.impactAnalysis,
    );
    expect(app.repo.material(p.id, manual.sourceVersionId)).toBe('收入 13\n');
    expect(app.jobs.list(p.id)).toEqual(jobsBefore);
    let received: any;
    Object.assign(app.researchTasks, {
      model: {
        async generate(schema: any, _purpose: string, scope: any) {
          received = scope;
          return {
            result: schema.parse({
              proposals: [
                {
                  target: { id: 'a', versionId: a.contentVersionId },
                  proposedText: '收入为 13',
                  reason: '依据本人校正后的文字',
                  citations: [
                    {
                      sourceVersionId: scope.trigger.correctedSourceVersionId,
                      start: 0,
                      end: 5,
                      quote: '收入 13',
                    },
                  ],
                  gaps: [],
                },
              ],
              gaps: [],
            }),
            usage: null,
          };
        },
      },
    });
    const corrected = app.transcription.correct(p.id, human, 'correct-key-number', correction);
    expect(corrected.impactAnalysis.targetIds.sort()).toEqual(['a', 'i']);
    expect(corrected.impactAnalysis.conditionIds).toEqual(['cond']);
    expect(corrected.impactAnalysis.jobIds).toHaveLength(1);
    await app.researchTasks.drain();
    expect(received.trigger.correctedSourceVersionId).toBe(corrected.sourceVersionId);
    expect(received.targets.map((e: any) => e.id).sort()).toEqual(['a', 'i']);
    expect(app.jobs.get(p.id, corrected.impactAnalysis.jobIds[0]!).state).toBe('succeeded');
    for (const e of before.objects)
      expect(app.repo.snapshot(p.id).objects.find((x) => x.id === e.id)).toEqual(e);
    expect(
      app.transcription.correct(p.id, human, 'correct-key-number', {
        ...input,
        sourceVersionId: prior.sourceVersionId,
        blocks: [{ ...input.blocks[0], text: '收入 13' }],
        reason: '数字识别错误',
      }).impactAnalysis.jobIds,
    ).toEqual(corrected.impactAnalysis.jobIds);
  } finally {
    app.db.close();
  }
});
