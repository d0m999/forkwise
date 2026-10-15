import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openMapping } from '../src/mapping/storage.js';

it('表格列宽和行列结构作为一次正文动作保存、同revision读取并完整撤销及重开', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forkwise-table-code-'));
  let host = openMapping(directory);
  try {
    const human = host.access.authenticate(host.access.issue('human', ['*']));
    const run = (command: Record<string, unknown>) =>
      host.execute({ commandId: randomUUID(), projectId: 'p', ...command }, human);
    const read = () => host.read({ type: 'project', projectId: 'p' }, human);
    run({ type: 'project.create', expected: null, payload: { name: '表格代码' } });
    run({
      type: 'thought.create',
      expected: null,
      payload: { id: 'a', title: '表格', text: '', x: 0, y: 0 },
    });
    const before = read();
    const table = {
      id: 'table',
      type: 'table',
      header: true,
      columnWidths: [180, 320],
      rows: [
        [{ text: '期间' }, { text: '内容' }],
        [{ text: '2026\nQ1' }, { text: '字面', marks: [{ type: 'bold', start: 0, end: 2 }] }],
      ],
    };
    const receipt = run({
      type: 'body.edit',
      expected: before.cards[0]!.body.versionId,
      payload: { id: 'a', blocks: [table] },
    });
    expect(read().cards[0]!.body.blocks).toEqual([table]);
    const changes = host.observe({ projectId: 'p', afterRevision: before.project.revision }, human);
    expect(changes.changes.map((c) => c.revision)).toEqual([receipt.revision]);
    const index = host.read({ type: 'map', projectId: 'p', view: 'index' }, human);
    const preview = host.read(
      { type: 'map', projectId: 'p', view: 'body', cardId: 'a', snapshot: index.snapshot },
      human,
    );
    expect(preview.items[0]).toMatchObject({ text: '期间\t内容\n2026\nQ1\t字面' });
    const detail = host.read(
      { type: 'map', projectId: 'p', view: 'detail', cardId: 'a', snapshot: index.snapshot },
      human,
    );
    expect(detail.revision).toBe(receipt.revision);
    expect(JSON.parse(detail.items.map((c) => c.jsonText).join('')).blocks).toEqual([table]);
    run({ type: 'history.undo', expected: read().project.revision, payload: {} });
    expect(read().cards[0]!.body.blocks).toEqual(before.cards[0]!.body.blocks);
    run({ type: 'history.redo', expected: read().project.revision, payload: {} });
    host.close();
    host = openMapping(directory);
    expect(read().cards[0]!.body.blocks).toEqual([table]);
    for (const widths of [[180], [0, 320], [180, Infinity], ['180', 320]]) {
      const stable = read();
      expect(() =>
        run({
          type: 'body.edit',
          expected: stable.cards[0]!.body.versionId,
          payload: { id: 'a', blocks: [{ ...table, columnWidths: widths }] },
        }),
      ).toThrow();
      expect(read()).toEqual(stable);
    }
  } finally {
    host.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
