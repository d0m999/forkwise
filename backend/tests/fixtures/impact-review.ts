import type { CommandInput } from '../../src/contracts/commands.js';
import { randomUUID } from 'node:crypto';
import { createApplication } from '../../src/app.js';
import { human, statement, inference, expectedOf } from '../helpers.js';

export async function impactReviewFixture(
  origin = 'http://127.0.0.1:8787',
  database = ':memory:',
  rights: 'public' | 'restricted' = 'public',
) {
  const app = createApplication({
    database,
    origin,
    researchModel: {
      async generate(schema, _purpose, raw) {
        const scope = raw as any;
        return {
          result: schema.parse({
            proposals: scope.targets.map((target: any) => ({
              target: { id: target.id, versionId: target.contentVersionId },
              proposedText: '依据新材料补充适用限制',
              reason: '新材料显示范围有限',
              gaps: [],
              citations: [{ sourceVersionId: 'sv', start: 0, end: 4, quote: '新增披露' }],
            })),
            gaps: [],
          }),
          usage: null,
        };
      },
    },
  });
  const project = app.write.createProject(human, randomUUID(), { name: '复核隔离测试' });
  const state = () => app.repo.snapshot(project.id);
  const write = (commands: any[], actor = human, expected = expectedOf(state().objects)) =>
    app.write.execute(project.id, actor, randomUUID(), { expected, commands });
  write([
    statement('a'),
    statement('b'),
    inference('i', ['a'], 'b'),
    {
      op: 'source.create',
      id: 'source',
      data: { title: '合成新披露', publisher: '测试', rights },
    },
    {
      op: 'source.import',
      id: 'sv',
      sourceId: 'source',
      text: '新增披露显示仅部分范围有效。',
      retrievedAt: new Date().toISOString(),
      publishedAt: null,
    },
  ]);
  write([{ op: 'stance.set', id: 'i', stance: { value: 'accepted', reason: '原有理由' } }]);
  const task = app.researchTasks.request(project.id, human, randomUUID(), {
    kind: 'impact',
    targetIds: ['i', 'a'],
    sourceVersionIds: ['sv'],
  });
  const done = await app.researchTasks.run(project.id, task.id);
  if (done.state !== 'succeeded') throw new Error(done.error ?? done.state);
  const get = (id: string) => state().objects.find((e) => e.id === id)!;
  const command = (
    disposition: 'maintained' | 'revised' | 'later' = 'maintained',
    reason = '已核对新材料，原判断仍适用',
  ): Extract<CommandInput, { op: 'impact.review' }> => ({
    op: 'impact.review',
    id: 'review',
    jobId: task.id,
    proposalIndex: 0,
    target: { id: 'i', versionId: get('i').versionId },
    context: ['a', 'b'].map((id) => ({ id, versionId: get(id).contentVersionId })),
    disposition,
    reason,
  });
  return { app, project, state, write, task, get, command };
}
