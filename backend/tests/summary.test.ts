import { it, expect } from 'vitest';
import { setup, statement, inference, human } from './helpers.js';
import { AssetService } from '../src/services/assets.js';
it('Markdown 保留条件、独立人工确认、推导范围和来源时间；历史摘要不受当前修改影响', () => {
  const t = setup();
  try {
    t.write([
      statement('a', '订单增加'),
      statement('b', '收入增加'),
      inference('i', ['a'], 'b'),
      {
        op: 'source.create',
        id: 's',
        data: { title: '受限来源', publisher: '发布者', rights: 'restricted' },
      },
      {
        op: 'source.import',
        id: 'sv',
        sourceId: 's',
        text: '受限原始语句',
        publishedAt: '2025-01-01T00:00:00Z',
        retrievedAt: '2025-02-01T00:00:00Z',
      },
      {
        op: 'evidence.create',
        id: 'ev',
        data: { citation: { sourceVersionId: 'sv', start: 0, end: 6, quote: '受限原始语句' } },
      },
      {
        op: 'condition.create',
        id: 'cond',
        data: { description: '成本未出现显著恶化', mode: 'qualitative', targetIds: ['i'] },
      },
    ]);
    const c = t.get('cond');
    t.write([
      {
        op: 'evaluation.confirm',
        id: 'confirmation',
        condition: { id: c.id, versionId: c.contentVersionId },
        verdict: 'unknown',
        reason: '成本资料缺失',
        evidenceIds: ['ev'],
        citations: [],
      },
    ]);
    t.write(
      [
        {
          op: 'evaluation.propose',
          id: 'candidate',
          condition: { id: c.id, versionId: c.contentVersionId },
          verdict: 'awaiting_observation',
          reason: '等待新披露',
          evidenceIds: ['ev'],
          citations: [],
          missing: ['下一期报告'],
          tentative: false,
        },
      ],
      t.versions(),
      { id: 'agent', type: 'agent' },
    );
    const assets = new AssetService(t.repo, t.service),
      judgment = assets.recordJudgment(t.project.id, human, 'summary-judgment', '当时研究');
    t.write([{ op: 'statement.edit', id: 'a', text: '订单减少', scope: 'all' }]);
    const summary = assets.summary(t.project.id, judgment.id);
    expect(summary).toContain('订单增加');
    expect(summary).not.toContain('订单减少');
    expect(summary).toContain('人工确认：未知');
    expect(summary).toContain('AI 建议 / 等待观察');
    expect(summary).toContain('下一期报告');
    expect(summary).toContain('前提：a');
    expect(summary).toContain('结论：b');
    expect(summary).toContain('2025-01-01T00:00:00.000Z');
    expect(summary).toContain('2025-02-01T00:00:00.000Z');
    expect(summary).not.toContain('受限原始语句');
    expect(assets.judgments(t.project.id)).toHaveLength(1);
    expect(assets.summary(t.project.id)).toContain('订单减少');
  } finally {
    t.db.close();
  }
});
