import { randomUUID } from 'node:crypto';
import { createApplication } from '../../src/app.js';
import { human, statement, inference, expectedOf } from '../helpers.js';
export function manualUpdateFixture() {
  const app = createApplication({
    database: ':memory:',
    origin: 'http://127.0.0.1:8787',
    researchModel: {
      async generate(schema, _purpose, raw) {
        const scope = raw as any;
        return {
          result: schema.parse({
            proposals: scope.targets.map((target: any) => ({
              target: { id: target.id, versionId: target.contentVersionId },
              proposedText: '需补充适用范围',
              reason: '合成披露有适用限制',
              citations: [
                { sourceVersionId: scope.materials[0].id, start: 0, end: 4, quote: '新增披露' },
              ],
              gaps: [],
            })),
            gaps: [],
          }),
          usage: null,
        };
      },
    },
  });
  const project = app.write.createProject(human, randomUUID(), { name: '更新隔离测试' });
  const state = () => app.repo.snapshot(project.id);
  const write = (commands: any[]) =>
    app.write.execute(project.id, human, randomUUID(), {
      expected: expectedOf(state().objects),
      commands,
    });
  write([
    statement('a'),
    statement('b'),
    inference('i', ['a'], 'b'),
    {
      op: 'source.create',
      id: 'source',
      data: { title: '本人提供的新披露', publisher: '测试', rights: 'authorized' },
    },
  ]);
  const input = {
    scopeLabel: '测试公司的经营变化',
    material: {
      kind: 'text' as const,
      sourceId: 'source',
      text: '新增披露显示部分范围受限。',
      retrievedAt: new Date().toISOString(),
      publishedAt: null,
      coverage: 'full' as const,
    },
    targetIds: ['a', 'i'],
  };
  return { app, project, state, write, input };
}
