import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';
import type { CommitOptions } from '../src/mapping/mapping.js';
import type { ConnectorEndpoint } from '../src/mapping/connector-contracts.js';

export function lifecycleFixture(options: CommitOptions = {}, projectName = '宿主删除闭包') {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-issue26-host-delete-'));
  let mapping = openMapping(directory, options);
  const token = mapping.access.issue('human', ['*']);
  let human = mapping.access.authenticate(token);
  const run = (command: Record<string, unknown>) => mapping.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
  const state = () => mapping.read({ type: 'project', projectId: 'p' }, human);
  const asset = (id: string) => mapping.read({ type: 'asset', projectId: 'p', id }, human);
  const history = () => mapping.read({ type: 'history', projectId: 'p' }, human);
  const reopen = () => { mapping.close(); mapping = openMapping(directory, options); human = mapping.access.authenticate(token); };
  const card = (id: string) => {
    run({ type: 'thought.create', expected: null, payload: { id, title: id, text: '保留正文', x: 20, y: 40 } });
    return state().cards.find(value => value.id === id)!;
  };
  const connector = (id: string, start: ConnectorEndpoint, end: ConnectorEndpoint) => {
    run({ type: 'connector.create', expected: null, payload: { id, start, end } });
    return state().connectors!.find(value => value.id === id)!;
  };
  const bound = (itemId: string, side: 'top' | 'right' | 'bottom' | 'left' = 'right'): ConnectorEndpoint => ({ kind: 'bound', itemId, side });
  const free = (x: number, y: number): ConnectorEndpoint => ({ kind: 'free', point: { x, y } });
  run({ type: 'project.create', expected: null, payload: { name: projectName } });
  return { run, state, history, asset, reopen, card, connector, bound, free, token,
    get mapping() { return mapping; }, get human() { return human; },
    close: () => { mapping.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
