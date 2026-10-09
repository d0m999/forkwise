export const verdicts = {
  satisfied: '满足',
  not_satisfied: '未满足',
  awaiting_observation: '等待观察',
  unknown: '未知／依据不足',
  not_comparable: '不可比',
};
export const modes = {
  qualitative: '定性判断',
  numeric: '确定性数值规则',
  mixed: '数值与定性共同判断',
};
export const labelOf = (e) =>
  e?.data.text ?? e?.data.reason ?? e?.data.description ?? e?.id ?? '已删除对象';
export function describeRule(parent, r) {
  element(
    parent,
    'p',
    r.subject +
      ' · ' +
      r.metric +
      ' · ' +
      { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=' }[r.operator] +
      ' ' +
      r.threshold +
      ' ' +
      r.unit +
      ' · ' +
      (r.currency || '币种不适用') +
      ' · ' +
      r.scope,
  );
  element(
    parent,
    'p',
    { single: '单期', cumulative: '累计', instant: '时点' }[r.periodKind] +
      '：' +
      r.periods.map((v) => v.start + ' 至 ' + v.end).join('；'),
  );
}
export function element(parent, tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}
export function button(parent, text, action) {
  const node = element(parent, 'button', text);
  node.type = 'button';
  node.onclick = action;
  return node;
}
function field(parent, name, label, value, type = 'text', options) {
  const row = element(parent, 'label', label);
  const input = element(row, options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  input.name = name;
  input.setAttribute('aria-label', label);
  if (options)
    for (const [key, title] of Object.entries(options)) input.add(new Option(title, key));
  else if (type !== 'textarea') input.type = type;
  input.value = value ?? '';
  return input;
}
function choices(parent, title, rows, selected) {
  const box = element(parent, 'fieldset');
  element(box, 'legend', title);
  for (const row of rows) {
    const label = element(box, 'label');
    const input = element(label, 'input');
    input.type = 'checkbox';
    input.value = row.id;
    input.checked = selected.includes(row.id);
    label.append(document.createTextNode(row.title));
  }
  const unavailable = selected.filter((id) => !rows.some((r) => r.id === id));
  if (unavailable.length)
    element(box, 'p', '以下选择已不可用，保存前请复核：' + unavailable.join('、'));
  return () => [...box.querySelectorAll('input:checked')].map((i) => i.value);
}
export function ruleDraft(condition, selected) {
  const data = condition?.data;
  return {
    description: data?.description ?? '',
    mode: data?.mode ?? 'qualitative',
    targetIds: data?.targetIds ?? (selected ? [selected] : []),
    scope: (data?.targetIds.length ?? 0) > 1 ? '' : 'all',
    rule: data?.rule
      ? structuredClone(data.rule)
      : {
          subject: '',
          metric: '',
          operator: '',
          threshold: '',
          unit: '',
          currency: '',
          scope: '',
          periodKind: '',
          periods: [{ start: '', end: '' }],
        },
  };
}
export function ruleForm(parent, condition, objects, values, keep, save) {
  const form = element(parent, 'form');
  form.className = 'condition-editor';
  const description = field(form, 'description', '判断标准', values.description, 'textarea');
  description.required = true;
  const mode = field(form, 'mode', '评估方式', values.mode, 'text', modes);
  const numeric = element(form, 'fieldset');
  element(numeric, 'legend', '数值要求：指定期间均须满足；指标白名单由本人配置');
  const fields = {};
  for (const [name, title] of [
    ['subject', '主体'],
    ['metric', '指标'],
    ['unit', '单位'],
    ['currency', '币种（不适用可留空）'],
    ['scope', '统计／合并范围'],
  ])
    fields[name] = field(numeric, name, title, values.rule[name]);
  fields.operator = field(numeric, 'operator', '比较方式', values.rule.operator, 'text', {
    '': '请选择',
    gt: '大于',
    gte: '不低于',
    lt: '小于',
    lte: '不高于',
    eq: '等于',
  });
  fields.threshold = field(numeric, 'threshold', '阈值', values.rule.threshold, 'number');
  fields.threshold.step = 'any';
  fields.periodKind = field(numeric, 'periodKind', '期间口径', values.rule.periodKind, 'text', {
    '': '请选择',
    single: '单期',
    cumulative: '累计',
    instant: '时点',
  });
  const periods = element(numeric, 'div'),
    periodRows = [];
  function addPeriod(value) {
    const row = element(periods, 'fieldset');
    element(row, 'legend', '观察期间');
    const start = field(row, 'start', '期间开始', value.start, 'date');
    const end = field(row, 'end', '期间结束', value.end, 'date');
    const item = { row, start, end };
    periodRows.push(item);
    button(row, '移除此期间', () => {
      row.remove();
      periodRows.splice(periodRows.indexOf(item), 1);
      keep(read());
    });
  }
  values.rule.periods.forEach(addPeriod);
  button(numeric, '添加观察期间', () => {
    if (periodRows.length < 24) {
      addPeriod({ start: '', end: '' });
      keep(read());
    }
  });
  const scope = condition
    ? field(form, 'scope', '本次修改范围', values.scope, 'text', {
        '': '请选择修改范围',
        all: '修改共享条件及其引用',
        selected: '仅选定引用使用新条件',
      })
    : null;
  const selectTargets = choices(
    form,
    '使用此条件的主张／推导',
    objects
      .filter((e) => ['statement', 'inference'].includes(e.kind))
      .map((e) => ({
        id: e.id,
        title: (e.kind === 'inference' ? '推导：' : '主张：') + labelOf(e),
      })),
    values.targetIds,
  );
  element(
    form,
    'p',
    '局部修改只允许选择原条件已有的引用；其他引用继续使用原规则。新增引用请选择修改共享条件。',
  );
  function read() {
    return {
      description: description.value,
      mode: mode.value,
      scope: scope?.value ?? 'all',
      targetIds: selectTargets(),
      rule: {
        ...Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value])),
        periods: periodRows.map(({ start, end }) => ({ start: start.value, end: end.value })),
      },
    };
  }
  numeric.hidden = mode.value === 'qualitative';
  form.oninput = form.onchange = () => {
    numeric.hidden = mode.value === 'qualitative';
    keep(read());
  };
  element(form, 'button', condition ? '保存条件修改' : '保存判断条件').type = 'submit';
  form.onsubmit = (event) => {
    event.preventDefault();
    save(read());
  };
  return form;
}
export function conditionData(values, lineage) {
  const data = {
    description: values.description.trim(),
    mode: values.mode,
    targetIds: values.targetIds,
    ...(lineage ? { lineage } : {}),
  };
  if (!data.description) throw new Error('请填写判断标准');
  if (values.mode !== 'qualitative') {
    const rule = values.rule;
    if (
      ['subject', 'metric', 'unit', 'scope', 'operator', 'periodKind', 'threshold'].some(
        (k) => String(rule[k]).trim() === '',
      )
    )
      throw new Error('请补齐数值规则；未知值不能按零保存');
    if (!Number.isFinite(Number(rule.threshold))) throw new Error('阈值必须是有限数值');
    if (!rule.periods.length || rule.periods.some((p) => !p.start || !p.end || p.start > p.end))
      throw new Error('请填写有效的观察期间');
    data.rule = { ...rule, threshold: Number(rule.threshold) };
  }
  return data;
}
export function assessmentForm(parent, objects, values, requestOnly, keep, save) {
  const form = element(parent, 'form');
  form.className = 'condition-assessment';
  let verdict, reason;
  if (!requestOnly) {
    verdict = field(form, 'verdict', '本人评估结论', values.verdict, 'text', verdicts);
    reason = field(form, 'reason', '本人评估理由', values.reason, 'textarea');
    reason.required = true;
  }
  const selected = choices(
    form,
    '本次使用的材料证据（请明确选择）',
    objects
      .filter((e) => e.kind === 'evidence')
      .map((e) => ({
        id: e.id,
        title:
          (e.data.citation.kind === 'image'
            ? `原图区域 ${e.data.citation.imageWidth}×${e.data.citation.imageHeight}`
            : `${e.data.citation.quote} · ${e.data.citation.start}–${e.data.citation.end}`) +
          ' · 材料 ' +
          e.data.citation.sourceVersionId,
      })),
    values.evidenceIds,
  );
  const citations = values.citations ?? [];
  const selectedCitations = choices(
    form,
    '候选直接引用的原文',
    citations.map((c, i) => ({
      id: String(i),
      title: (c.kind === 'image' ? '原图区域' : c.quote) + ' · ' + c.sourceVersionId,
    })),
    citations.map((_, i) => String(i)),
  );
  element(
    form,
    'p',
    requestOnly
      ? '只使用本次选定的证据。定性／混合评估会请求已配置模型；失败保留规则，不产生“未满足”。'
      : '本人确认独立保存，不改变主张或推导的个人立场。调整候选结论时须补充本人理由。',
  );
  function read() {
    return {
      verdict: verdict?.value ?? values.verdict,
      reason: reason?.value ?? '',
      evidenceIds: selected(),
      citations: selectedCitations().map((i) => citations[Number(i)]),
    };
  }
  form.oninput = form.onchange = () => keep(read());
  element(form, 'button', requestOnly ? '使用所选材料发起评估' : '保存本人条件判断').type =
    'submit';
  form.onsubmit = (event) => {
    event.preventDefault();
    save(read());
  };
  return form;
}
