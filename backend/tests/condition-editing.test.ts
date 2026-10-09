import { describe, expect, it } from 'vitest';
import { setup, statement, inference } from './helpers.js';
import type { Entity } from '../src/contracts/entities.js';

describe('条件共享编辑与独立人工判断', () => {
  it('局部派生只改接选定引用，保留原版本、人工结论及对象立场', () => {
    const t = setup();
    try {
      t.write([statement('a'), statement('b'), inference('i', ['a'], 'b'),
        { op: 'condition.create', id: 'c', data: { description: '需求持续改善', mode: 'qualitative', targetIds: ['a', 'i'] } }]);
      const original = t.get('c') as Entity<'condition'>;
      t.write([{ op: 'evaluation.confirm', id: 'human', condition: { id: 'c', versionId: original.contentVersionId }, verdict: 'unknown', reason: '需要补充渠道材料', evidenceIds: [], citations: [] }]);
      const before = t.repo.snapshot(t.project.id);
      const command = { op: 'condition.derive' as const, id: 'c', newId: 'local', targetIds: ['i'], data: { description: '需求改善且库存下降', mode: 'qualitative' as const, targetIds: ['i'] } };
      expect(() => t.write([command], t.versions(['c']))).toThrow();
      expect(t.repo.snapshot(t.project.id)).toEqual(before);
      const changes = t.write([command], t.versions(['c', 'i']));
      expect(changes.upserted.map(e => e.id).sort()).toEqual(['c', 'local']);
      expect((t.get('c') as Entity<'condition'>).data.targetIds).toEqual(['a']);
      expect(t.get('c').contentVersionId).toBe(original.contentVersionId);
      expect((t.get('local') as Entity<'condition'>).data.lineage).toEqual({ id: 'c', versionId: original.versionId });
      expect((t.get('human') as Entity<'evaluation'>).data.condition.id).toBe('c');
      expect(t.get('a')).toEqual(before.objects.find(e => e.id === 'a'));
      expect(t.get('i')).toEqual(before.objects.find(e => e.id === 'i'));
      const local = t.get('local') as Entity<'condition'>;
      const noChange = t.write([{ op: 'condition.edit', id: local.id, scope: 'all', data: local.data }]);
      expect(noChange.upserted).toEqual([]);
    } finally { t.db.close(); }
  });
  it('引用列表与派生范围明确一致，重复或被静默忽略的目标会拒绝', () => {
    const t = setup();
    try {
      t.write([statement('a'), statement('b'), { op: 'condition.create', id: 'c', data: { description: '标准', mode: 'qualitative', targetIds: ['a', 'b'] } }]);
      expect(() => t.write([{ op: 'condition.create', id: 'dup', data: { description: '标准', mode: 'qualitative', targetIds: ['a', 'a'] } }])).toThrow();
      expect(() => t.write([{ op: 'condition.derive', id: 'c', newId: 'bad', targetIds: ['a'], data: { description: '新标准', mode: 'qualitative', targetIds: ['b'] } }])).toThrow('一致');
      expect((t.get('c') as Entity<'condition'>).data.targetIds).toEqual(['a', 'b']);
    } finally { t.db.close(); }
  });
  it('人工可独立记录；调整候选结论必须补充理由，并保留候选来历', () => {
    const t = setup();
    try {
      t.write([{ op: 'condition.create', id: 'c', data: { description: '需求持续改善', mode: 'qualitative', targetIds: [] } }]);
      const condition = { id: 'c', versionId: t.get('c').contentVersionId };
      t.write([{ op: 'evaluation.propose', id: 'ai', condition, verdict: 'satisfied', reason: '渠道材料显示改善', evidenceIds: [], citations: [], missing: ['待核对库存'], tentative: true }]);
      const confirmation = { op: 'evaluation.confirm' as const, id: 'human', condition, evaluationId: 'ai', verdict: 'not_satisfied' as const, reason: '渠道材料显示改善', evidenceIds: [], citations: [] };
      expect(() => t.write([confirmation])).toThrow('本人理由');
      t.write([{ ...confirmation, reason: '订单恢复尚不足以满足持续改善的要求' }]);
      expect((t.get('human') as Entity<'evaluation'>).data.basedOn?.id).toBe('ai');
      expect((t.get('ai') as Entity<'evaluation'>).data.tentative).toBe(true);
      t.write([{ op: 'evaluation.confirm', id: 'independent', condition, verdict: 'unknown', reason: '本人尚无足够材料', evidenceIds: [], citations: [] }]);
      expect((t.get('independent') as Entity<'evaluation'>).data.basedOn).toBeUndefined();
    } finally { t.db.close(); }
  });
});
