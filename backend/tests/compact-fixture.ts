import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMapping } from '../src/mapping/storage.js';
import type { CommitOptions } from '../src/mapping/mapping.js';

const fixtures: { mapping: ReturnType<typeof openMapping>; directory: string }[] = [];
export function closeCompactFixtures() {
  for (const f of fixtures.splice(0)) {
    f.mapping.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
}

export function compactFixture(options: CommitOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-compact-'));
  const mapping = openMapping(directory, options);
  fixtures.push({ mapping, directory });
  const human = mapping.access.authenticate(mapping.access.issue('human', ['*']));
  const agent = mapping.access.authenticate(mapping.access.issue('agent', ['p']));
  mapping.execute(
    {
      commandId: 'project',
      projectId: 'p',
      type: 'project.create',
      expected: null,
      payload: { name: '地图' },
    },
    human,
  );
  const create = (id: string, text = '未展开的秘密正文') =>
    mapping.execute(
      {
        commandId: id,
        projectId: 'p',
        type: 'thought.create',
        expected: null,
        payload: { id, title: '标题 ' + id, text, x: 10, y: 20 },
      },
      human,
    );
  return { mapping, directory, human, agent, create };
}
