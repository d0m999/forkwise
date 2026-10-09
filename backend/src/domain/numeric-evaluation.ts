import type { Bodies, Entity } from '../contracts/entities.js';

export type Assessment = Pick<
  Bodies['evaluation'],
  'verdict' | 'reason' | 'evidenceIds' | 'citations' | 'missing' | 'tentative'
>;
export function combineMixed(numeric: Assessment, qualitative: Assessment): Assessment {
  const verdict = [numeric.verdict, qualitative.verdict].includes('not_satisfied')
    ? 'not_satisfied' : numeric.verdict === 'satisfied' ? qualitative.verdict : numeric.verdict;
  const missing = [...new Set([...numeric.missing, ...qualitative.missing])];
  return {
    verdict,
    reason: '数值要求与定性要求须共同满足；两部分的依据、理由和缺口分别保留。',
    evidenceIds: [...new Set([...numeric.evidenceIds, ...qualitative.evidenceIds])],
    citations: [...new Map([...numeric.citations, ...qualitative.citations].map(c => [JSON.stringify(c), c])).values()],
    missing: missing.length > 100 ? [...missing.slice(0, 99), '其他缺口见分项评估'] : missing,
    tentative: numeric.tentative || qualitative.tentative,
  };
}
export function evaluateNumeric(
  rule: NonNullable<Bodies['condition']['rule']>,
  evidence: Entity<'evidence'>[],
  now: string,
  metrics: string[],
): Assessment {
  const base = {
    evidenceIds: evidence.map((e) => e.id),
    citations: evidence.map((e) => e.data.citation),
    tentative: false,
  };
  const result = (
    verdict: Assessment['verdict'],
    reason: string,
    missing: string[] = [],
  ): Assessment => ({ ...base, verdict, reason, missing });
  if (!metrics.includes(rule.metric))
    return result('unknown', '此指标尚未加入本人配置的计算白名单', [rule.metric]);
  const facts = evidence.map((e) => e.data.fact);
  if (!facts.length || facts.some((f) => !f))
    return result('unknown', '缺少结构化输入', ['需要带完整口径的事实记录']);
  const available = facts.filter((f): f is NonNullable<typeof f> => Boolean(f));
  if (
    available.some(
      (f) => f.subject !== rule.subject || f.metric !== rule.metric || f.scope !== rule.scope,
    )
  )
    return result('not_comparable', '主体、指标或合并范围不一致');
  if (
    available.some(
      (f) =>
        f.periodKind !== rule.periodKind ||
        !rule.periods.some((p) => p.start === f.period.start && p.end === f.period.end),
    )
  )
    return result('not_comparable', '期间或累计口径不一致');
  if (available.some((f) => f.currency !== rule.currency || f.unit !== rule.unit))
    return result('not_comparable', '币种或单位不一致，尚未执行授权转换');
  const values: number[] = [];
  const missing: string[] = [];
  for (const period of rule.periods) {
    const group = available.filter(
      (f) => f.period.start === period.start && f.period.end === period.end,
    );
    if (!group.length || group.some((f) => f.value === null))
      missing.push(`${period.start} 至 ${period.end}`);
    else {
      const distinct = new Set(group.map((f) => f.value!));
      if (distinct.size !== 1)
        return result('unknown', '同一期间的输入值冲突，请选择所采用的材料版本', [period.start]);
      values.push(group[0]!.value!);
    }
  }
  if (rule.periods.some((p) => p.end > now.slice(0, 10)))
    return result('awaiting_observation', '观察窗口尚未结束', missing);
  if (missing.length) return result('unknown', '必需输入缺失，不按零或未满足处理', missing);
  const comparisons = {
    gt: (n: number) => n > rule.threshold,
    gte: (n: number) => n >= rule.threshold,
    lt: (n: number) => n < rule.threshold,
    lte: (n: number) => n <= rule.threshold,
    eq: (n: number) => n === rule.threshold,
  };
  const satisfied = values.every(comparisons[rule.operator]);
  return result(
    satisfied ? 'satisfied' : 'not_satisfied',
    `按 ${rule.periods.length} 个指定期间逐期比较，${satisfied ? '全部满足' : '至少一期未满足'}要求`,
  );
}
