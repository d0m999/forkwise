import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

export function imageFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue24-'));
  const host = openMapping(directory);
  const token = host.access.issue('human', ['*']);
  const human = host.access.authenticate(token);
  const run = (command: Record<string, unknown>) => host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  run({ type: 'project.create', expected: null, payload: { name: '独立图片' } });
  const base64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="600" height="800" fill="green"/><rect x="600" width="600" height="800" fill="red"/></svg>').toString('base64');
  run({ type: 'asset.save', expected: null, payload: { id: 'original', name: '原图.svg', mime: 'image/svg+xml', base64 } });
  return { host, directory, human, token, run, base64,
    read: () => host.read({ type: 'project', projectId: 'p' }, human),
    create: (id = 'picture', crop = { x: 0, y: 0, width: 1, height: 1 }) => run({ type: 'image.create', expected: null, payload: { id, content: { assetId: 'original', crop }, pose: { x: -100, y: 240, width: 360, height: 240, rotation: 0 } } }),
    close: () => { host.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
