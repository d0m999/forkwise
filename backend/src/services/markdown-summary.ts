import { verificationContext } from '../domain/verification.js';
import { digest } from '../domain/canonical.js';
import type { AnyEntity, Project } from '../contracts/entities.js';
import { Citation, isImageCitation } from '../contracts/entities.js';
import type { z } from 'zod';
import { verificationCurrent } from '../domain/verification.js';

const safe = (value: unknown) => String(value).replace(/[\\`*_{}\[\]<>()#|!]/g, '\\$&');
const stance = { pending: '待研究', accepted: '认可', questioned: '质疑', rejected: '不认可' };
const verdict = {
  satisfied: '已满足',
  not_satisfied: '未满足',
  awaiting_observation: '等待观察',
  unknown: '未知',
  not_comparable: '不可比',
};
const origins = { user: '用户原始内容', author: '作者表达', ai: 'AI 推断' };
const relations = {
  supports: '支持',
  opposes: '相反',
  qualifies: '限定',
  background: '背景',
  unjudged: '尚未判断',
};

export function markdownSummary(
  project: Project,
  objects: AnyEntity[],
  exportedAt: string,
  judgment?: { id: string; title: string; createdAt: string },
) {
  const map = new Map(objects.map((e) => [e.id, e]));
  const blocks = [
    `# ${safe(judgment?.title ?? project.name)}`,
    `项目：${safe(project.name)}（${project.id}）`,
    judgment
      ? `历史判断：${judgment.id}；记录时间：${judgment.createdAt}。内容使用当次固定版本；项目名称为当前名称。`
      : `当前研究快照；项目修订 ${project.revision}。本次导出未创建历史判断。`,
    `导出时间：${exportedAt}`,
    safe(project.question),
  ];
  const ref = (id: string) => {
    const e = map.get(id);
    return `${id}${e ? `（v${e.version}；内容版本 ${e.contentVersionId}）` : '（未包含）'}`;
  };
  const cite = (c: z.infer<typeof Citation>) => {
    const version = map.get(c.sourceVersionId);
    const source = version?.kind === 'source_version' ? map.get(version.data.sourceId) : undefined;
    const restricted = source?.kind === 'source' && source.data.rights === 'restricted';
    return `来源：${safe(source?.kind === 'source' ? source.data.title : '未包含来源')}；版本 ${c.sourceVersionId}；${isImageCitation(c) ? `原图第一帧 ${c.imageWidth}×${c.imageHeight}；区域 ${JSON.stringify(c.region)}` : `字符 ${c.start}–${c.end}${c.visualRegionId ? `；图像区域 ${c.visualRegionId}` : ''}`}${restricted ? '；权利受限，仅保留定位索引' : c.unavailableReason ? '；原文缺失，无法复核' : ''}${version?.kind === 'source_version' && version.data.textOrigin === 'ocr' ? '；模型转写，原图仍须核对' : ''}`;
  };
  for (const e of objects) {
    if (e.kind === 'statement' || e.kind === 'inference') {
      blocks.push(
        `## ${e.kind === 'statement' ? '主张' : '推导'} ${e.id}`,
        safe(e.kind === 'statement' ? e.data.text : e.data.reason || '推导理由待补充'),
        `固定内容起点：${origins[e.data.origin]}；参与：${{ reference: '参考内容', candidate: 'AI 候选', personal: '个人研究项' }[e.data.participation]}；个人立场：${stance[e.data.stance.value]}`,
        `对象版本：${ref(e.id)}；最近记录：${e.updatedAt}`,
      );
      if (e.data.stance.reason) blocks.push(`立场理由：${safe(e.data.stance.reason)}`);
      if (e.data.stance.reasonProvenance)
        blocks.push(
          `理由来自 AI 任务 ${e.data.stance.reasonProvenance.jobId}；${e.data.stance.reasonProvenance.modified ? '本人曾改写' : '采用时未改写'}。`,
        );
      if (e.data.editProvenance)
        blocks.push(
          `当前修改参考 AI 任务 ${e.data.editProvenance.jobId} 的建议 ${e.data.editProvenance.proposalIndex + 1}；${e.data.editProvenance.scope === 'selected' ? '局部采用' : '全部引用采用'}；采用前版本 ${e.data.editProvenance.previous.versionId}。`,
        );
      if (e.kind === 'statement' && e.data.lineage)
        blocks.push(`派生来历：${e.data.lineage.id}，固定版本 ${e.data.lineage.versionId}`);
      if (e.kind === 'inference')
        blocks.push(
          `前提：${e.data.premiseIds.map(ref).join('、')} → 结论：${ref(e.data.conclusionId)}；组合：${{ independent: '单一前提', joint_required: '共同依赖', unspecified: '组合尚未说明' }[e.data.combination]}`,
        );
      blocks.push(...e.data.citations.map(cite));
      if (!e.data.citations.length) blocks.push('正文尚未附原文引用。');
      const materials = objects.filter(
        (x) =>
          x.kind === 'material_membership' &&
          x.data.targetId === e.id &&
          x.data.visibility === 'included',
      );
      if (materials.length)
        blocks.push(
          '对象材料（未表示证据作用或个人立场）：' +
            materials
              .map((x) => (x.kind === 'material_membership' ? x.data.sourceVersionId : ''))
              .join('、'),
        );
    }
    if (e.kind === 'condition') {
      blocks.push(
        `## 条件 ${e.id}`,
        safe(e.data.description),
        `规则版本：${e.contentVersionId}；模式：${{ numeric: '确定性数值', qualitative: '定性判断', mixed: '数值与定性' }[e.data.mode]}；适用对象：${e.data.targetIds.map(ref).join('、') || '尚未关联'}`,
      );
      if (e.data.rule) {
        const r = e.data.rule;
        blocks.push(
          `数值规则：${safe(r.subject)} / ${safe(r.metric)} ${r.operator} ${r.threshold} ${safe(r.unit)}；币种：${safe(r.currency) || '未指定'}；范围：${safe(r.scope)}；期间口径：${r.periodKind}；观察期间：${r.periods.map((p) => `${p.start}–${p.end}`).join('、')}`,
        );
      }
      const rows = objects.filter(
        (x) =>
          x.kind === 'evaluation' &&
          x.data.condition.id === e.id &&
          x.data.condition.versionId === e.contentVersionId,
      );
      const human = rows
        .filter((x) => x.kind === 'evaluation' && x.data.evaluator === 'human')
        .at(-1);
      blocks.push(
        human?.kind === 'evaluation'
          ? `当前规则的人工确认：${verdict[human.data.verdict]}；${human.data.evaluatedAt}；${safe(human.data.reason)}`
          : '当前规则尚无人工确认。',
      );
      for (const evaluation of rows)
        if (evaluation.kind === 'evaluation') {
          const d = evaluation.data;
          blocks.push(
            `评估 ${evaluation.id}：${{ human: '人工', ai: 'AI 建议', rule: '确定性规则' }[d.evaluator]} / ${verdict[d.verdict]}${d.tentative ? ' / 依据有限的倾向意见' : ''}；${d.evaluatedAt}`,
            safe(d.reason),
          );
          if (d.missing.length) blocks.push(`缺口：${d.missing.map(safe).join('；')}`);
          if (d.components)
            for (const [kind, part] of Object.entries(d.components)) {
              blocks.push(
                `${kind === 'numeric' ? '确定性数值结果' : 'AI 定性意见'}：${verdict[part.verdict]}${part.tentative ? ' / 依据有限' : ''}`,
                safe(part.reason),
              );
              if (part.missing.length)
                blocks.push(`分项缺口：${part.missing.map(safe).join('；')}`);
            }
          blocks.push(...d.citations.map(cite));
          if (d.evidenceIds.length) blocks.push(`依据对象：${d.evidenceIds.map(ref).join('、')}`);
        }
      const old = objects.filter(
        (x) =>
          x.kind === 'evaluation' &&
          x.data.condition.id === e.id &&
          x.data.condition.versionId !== e.contentVersionId,
      );
      if (old.length)
        blocks.push(
          `另有 ${old.length} 条旧规则评估，保留在完整 JSON 及历史中，不作为当前规则确认。`,
        );
    }
    if (e.kind === 'evidence_link') {
      const d = e.data,
        evidence = map.get(d.evidenceId),
        target = map.get(d.target.id);
      blocks.push(
        `## 证据关联 ${e.id}`,
        `目标：${d.target.id} / ${d.target.versionId}${target?.contentVersionId !== d.target.versionId || !target || digest(verificationContext(map, target)) !== digest(d.context ?? []) ? '（旧内容或前提版本，须重新核对）' : ''}；作用：${relations[d.relation]}；提出者：${d.origin === 'ai' ? 'AI' : '本人'}；${d.participation === 'candidate' ? '候选，尚未采用' : '已明确采用'}`,
        safe(d.explanation),
      );
      if (evidence?.kind === 'evidence') blocks.push(cite(evidence.data.citation));
    }
    if (e.kind === 'note')
      blocks.push(`## 笔记 ${e.id}`, `关联：${ref(e.data.targetId)}`, safe(e.data.text));
    if (e.kind === 'review') {
      blocks.push(
        `## 影响建议复核 ${e.id}`,
        `建议：${e.data.jobId} / ${e.data.proposalIndex + 1}；当次处理：${{ revised: '修订判断', maintained: '维持原判断', later: '稍后处理' }[e.data.disposition]}`,
        `复核时间：${e.data.reviewedAt}；固定目标版本：${e.data.target.id} / ${e.data.target.versionId}`,
        safe(e.data.reason || '未填写稍后处理理由'),
        '此记录仅对应当次建议与固定版本；不自动更改个人立场，也不表示其他建议已处理。',
      );
    }
    if (e.kind === 'verification_node') {
      blocks.push(
        `## 验证节点 ${e.id}`,
        `目标：${e.data.target.id} / ${e.data.target.versionId}；${e.data.status === 'confirmed' ? '本人已确认节点' : 'AI 建议，尚未确认'}${verificationCurrent(map, e) ? '' : '；对应旧内容或前提，需复核'}`,
        `观察事件：${safe(e.data.event ?? '待明确')}；核对目标：${safe(e.data.goal ?? '待明确')}`,
        `业务期间：${safe(e.data.period ?? '待明确')}；披露日期：${e.data.date ?? '未知'}`,
        '节点确认不代表预测成立，不改变个人立场或启用定时任务。',
      );
      if (e.data.context.length)
        blocks.push(
          `固定上下文：${e.data.context.map((r) => `${r.id} / ${r.versionId}`).join('、')}`,
        );
      if (e.data.basedOn)
        blocks.push(`依据候选：${e.data.basedOn.id} / ${e.data.basedOn.versionId}`);
      if (e.data.sourceTask) blocks.push(`来源任务：${e.data.sourceTask}`);
      if (e.data.gaps.length) blocks.push(`缺口：${e.data.gaps.map(safe).join('；')}`);
    }
  }
  blocks.push(
    '## 材料版本索引',
    '下列时间分别记录披露和取得材料的时点；正文引用定位不等于查证已完成。',
  );
  for (const e of objects)
    if (e.kind === 'source_version') {
      const source = map.get(e.data.sourceId);
      blocks.push(
        `### ${safe(source?.kind === 'source' ? source.data.title : e.data.sourceId)} / ${e.id}`,
        `发布时间：${e.data.publishedAt ?? '未记录'}；获取时间：${e.data.retrievedAt}${e.data.businessPeriod ? `；业务期间：${e.data.businessPeriod.start}–${e.data.businessPeriod.end}` : ''}`,
        `内容指纹：${e.data.contentHash}；解析状态：${e.data.parseStatus}；文本起点：${e.data.textOrigin ?? '导入文本'}${e.data.derivedFrom ? `；依据版本：${e.data.derivedFrom}` : ''}`,
        `保存范围：${{ full: '标注为全文（未独立核验完整性）', excerpt: '摘录', unknown: '未说明' }[e.data.coverage ?? 'unknown']}`,
      );
      if (source?.kind === 'source')
        blocks.push(
          `出版者：${safe(source.data.publisher) || '未记录'}；权利：${source.data.rights}${source.data.reprintOf ? `；转载自：${source.data.reprintOf}，不算独立佐证` : ''}`,
          source.data.url ? `原始入口：${safe(source.data.url)}` : '',
        );
    }
  return blocks.filter(Boolean).join('\n\n') + '\n';
}
