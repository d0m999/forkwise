import { openDatabase } from '../src/repositories/database.js';
import { ResearchRepository } from '../src/repositories/research.js';
import { GraphWriteService } from '../src/services/graph-write.js';
import type { Actor, AnyEntity } from '../src/contracts/entities.js';
import type { CommandInput } from '../src/contracts/commands.js';
import { randomUUID } from 'node:crypto';

export const human: Actor = { id: 'test-human', type: 'human' };
export const agent: Actor = { id: 'test-agent', type: 'agent' };
export const statement = (id: string, text = id): CommandInput => ({
  op: 'statement.create',
  id,
  data: {
    text,
    origin: 'user',
    participation: 'personal',
    stance: { value: 'pending', reason: '' },
    citations: [],
  },
});
export const inference = (
  id: string,
  premiseIds: string[],
  conclusionId: string,
  reason = '独立的理由',
): CommandInput => ({
  op: 'inference.create',
  id,
  data: {
    premiseIds,
    conclusionId,
    reason,
    combination: premiseIds.length > 1 ? 'joint_required' : 'independent',
    origin: 'user',
    participation: 'personal',
    stance: { value: 'pending', reason: '' },
    citations: [],
  },
});
export function setup(path = ':memory:') {
  const db = openDatabase(path);
  const repo = new ResearchRepository(db);
  const service = new GraphWriteService(repo);
  const project = service.createProject(human, randomUUID(), { name: '隔离测试项目' });
  const versions = (ids?: string[]) =>
    Object.fromEntries(
      repo
        .snapshot(project.id)
        .objects.filter((e) => !ids || ids.includes(e.id))
        .map((e) => [e.id, e.version]),
    );
  const write = (
    commands: CommandInput[],
    expected = versions(),
    actor = human,
    key: string = randomUUID(),
  ) => service.execute(project.id, actor, key, { expected, commands });
  const get = (id: string) => repo.snapshot(project.id).objects.find((e) => e.id === id)!;
  return { db, repo, service, project, versions, write, get };
}
export function expectedOf(objects: AnyEntity[]): Record<string, number> {
  return Object.fromEntries(objects.map((e) => [e.id, e.version]));
}
