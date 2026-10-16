import { expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openMapping } from '../src/mapping/storage.js';

it('旧HEX预设色仅大小写不同仍是同色noop，原有色值写法在改名和重开后也保真', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-tags-legacy-noop-'));
  let m = openMapping(directory);
  const token = m.access.issue('human', ['*']); let a = m.access.authenticate(token);
  m.execute({ commandId: 'p', projectId: 'p', type: 'project.create', expected: null, payload: { name: '项目' } }, a);
  m.execute({ commandId: 't', projectId: 'p', type: 'tag.create', expected: null, payload: { id: 't', name: 'AI' } }, a);
  const original = m.read({ type: 'project', projectId: 'p' }, a).tags![0]!;
  m.close();
  // Explicit synthetic legacy input, with the host stopped. Assertions below
  // use Mapping only; no production migration or database-layout assertion.
  const db = new Database(join(directory, 'workspace.sqlite'));
  const legacy = { ...original, color: '#D9E7F1', versionId: crypto.randomUUID() };
  try { db.transaction(() => { db.prepare('UPDATE mapping_tags SET value=? WHERE id=?').run(JSON.stringify(legacy), 't'); db.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run('p', 'tag', 't', legacy.versionId, JSON.stringify(legacy)); })(); }
  finally { db.close(); }
  m = openMapping(directory); a = m.access.authenticate(token);
  const read = () => m.read({ type: 'project', projectId: 'p' }, a);
  try {
    const before = read(), history = m.read({ type: 'history', projectId: 'p' }, a);
    const noop = m.execute({ commandId: 'same-blue', projectId: 'p', type: 'tag.update', expected: legacy.versionId, payload: { id: 't', color: '#d9e7f1' } }, a);
    expect(noop.changedIds).toEqual([]); expect(read()).toEqual(before); expect(m.read({ type: 'history', projectId: 'p' }, a)).toEqual(history);
    m.execute({ commandId: 'rename', projectId: 'p', type: 'tag.update', expected: legacy.versionId, payload: { id: 't', name: 'Ai', color: '#d9e7f1' } }, a);
    expect(read().tags![0]).toMatchObject({ name: 'Ai', color: '#D9E7F1' });
    m.close(); m = openMapping(directory); a = m.access.authenticate(token);
    expect(read().tags![0]).toMatchObject({ name: 'Ai', color: '#D9E7F1' });
  } finally { m.close(); }
});
