/* 临时原型的只读浮窗内容。窗口、事件与研究状态由主页面管理。 */
(() => {
  'use strict';

  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const values = collection => Object.values(collection || {});
  const objects = graph => [...values(graph?.nodes), ...values(graph?.edges)];
  const graphFor = study => study.mode === 'author' ? study.author : study.mine;
  const item = (graph, id) => graph?.nodes?.[id] || graph?.edges?.[id];
  const kind = object => object.type === 'inference' ? '推导关系' : object.role || '主张';
  const text = object => escape(object?.text || '对应内容暂缺');
  const meta = (study, object) => {
    const edited = OpenStudy.isEdited(object), corrected = (object.correctionHistory || []).length > 0;
    const use = OpenStudy.researchUse?.(object) || object.researchUse;
    const status = study.directCanvas
      ? [edited ? '我已编辑' : use === 'reference' ? OpenStudy.originKind(object) === 'ai' ? 'AI 候选' : '参考内容' : use === 'research' ? '已记录研究操作' : '', corrected ? '整理已校正' : '', '立场单独记录'].filter(Boolean).join(' · ')
      : edited ? '我已编辑' : '';
    return `<p class="fw-panel-meta">内容起点 ${escape(OpenStudy.originLabel(object))}${status ? ` · ${escape(status)}` : ''} · ${escape(kind(object))} · v${escape(object.version ?? '未记录')}</p>`;
  };
  const heading = (title, note) => `<header class="fw-panel-heading"><h2>${title}</h2><p class="fw-panel-note">${note}</p></header>`;

  // 与 OpenStudy.signature 使用同一字段顺序；前提改写也会令推导查证过期。
  function signature(graph, object) {
    const dependency = id => {
      const node = graph?.nodes?.[id];
      return node ? [id, node.version, node.text] : [id, null, null];
    };
    return JSON.stringify([
      object.id, object.version, object.text,
      object.type === 'inference' ? (object.premises || []).map(dependency) : null,
      object.type === 'inference' ? [...dependency(object.conclusion), object.combination] : null
    ]);
  }

  function anchor(study, reference, label = '查看原文') {
    if (!reference) return '';
    const source = (study.sources || []).find(value => value.id === reference.source && value.version === reference.version);
    const validRange = Number.isInteger(reference.start) && Number.isInteger(reference.end)
      && reference.start >= 0 && reference.end > reference.start;
    const available = validRange && source?.version === reference.version
      && typeof source.text === 'string'
      && reference.end <= source.text.length
      && source.text.slice(reference.start, reference.end) === reference.quote;
    const information = `<p class="fw-panel-meta">${escape(source?.title || '来源暂无法取得')} · 材料 v${escape(reference.version ?? '未记录')}${validRange ? ` · 字符 ${reference.start + 1}–${reference.end}` : ''}</p>`;
    const quote = reference.quote ? `<blockquote class="fw-panel-quote">${escape(reference.quote)}</blockquote>` : '';
    const button = available
      ? `<button type="button" class="fw-panel-source" data-lab="anchor" data-ref="${escape(JSON.stringify(reference))}">${escape(label)}</button>`
      : '<p class="fw-panel-gap">原材料版本暂无法定位；保留当时引用。</p>';
    return `<div class="fw-panel-reference">${quote}${information}${button}</div>`;
  }

  function checkItem(study, graph, object) {
    const result = object.verification;
    const stale = Boolean(result && result.signature !== signature(graph, object));
    const status = !result ? '尚未查证' : stale ? '需重新查证' : result.status || '查证结果未记录';
    let detail = !result
      ? '<p class="fw-panel-gap">这项内容尚无公开资料查证结果。没有结果不表示成立或不成立。</p>'
      : `<p>${escape(stale ? '表述或依赖已改变。下列旧结果属于当时版本，不能作为当前版本的查证结论。' : result.explanation || result.reason || '结果尚未附具体说明。')}</p>`;
    if (result) {
      detail += `<p class="fw-panel-meta">${escape(result.origin || '查证意见')} · 目标 v${escape(result.targetVersion ?? '未记录')}</p>`;
      if (stale) detail += `<p class="fw-panel-old-result">旧结果：${escape(result.status)}${result.reason ? ` · ${escape(result.reason)}` : ''}</p>`;
      else if (result.reason) detail += `<p class="fw-panel-gap">${escape(result.reason)}</p>`;
      if (result.signal) detail += `<p class="fw-panel-signal">${stale ? '当时信号' : '同时保留的信号'}：${escape(result.signal)}</p>`;
      if (result.scope) detail += `<p class="fw-panel-meta">${stale ? '原查证范围' : '查证范围'}：${escape(result.scope)}</p>`;
      detail += `<p class="fw-panel-meta">${(result.basis || []).length} 条${stale ? '旧版' : '查证'}依据 · 个人立场：${escape(object.stance || '待研究')}</p>`;
    }
    return `<article class="fw-check-row${stale ? ' fw-check-stale' : ''}">${meta(study, object)}<h3>${text(object)}</h3><p class="fw-check-status">${escape(status)}</p>${detail}<button type="button" data-lab="check-item" data-id="${escape(object.id)}">查看这${object.type === 'inference' ? '一步' : '项'}的依据与详情</button></article>`;
  }

  function checks(study) {
    const graph = graphFor(study), list = objects(graph);
    const intro = heading(study.directCanvas ? '当前研究画布的查证结果' : study.mode === 'author' ? '候选链的查证结果' : '个人论证的查证结果',
      '查看不会重新查证，也不会更改你的判断。本原型尚未接入真实模型与公开数据源；已有自动查证结果来自标注的模拟样本。');
    if (!list.length) return `<div class="fw-panel fw-panel-checks">${intro}<p class="fw-panel-empty">当前画布还没有主张或推导。输入观点后，候选链与查证结果会在这里列出。</p></div>`;
    const groups = [
      ['主张与前提', values(graph.nodes)],
      ['整步推导', values(graph.edges)]
    ].filter(([, entries]) => entries.length);
    return `<div class="fw-panel fw-panel-checks">${intro}${groups.map(([title, entries]) => `<section class="fw-panel-section"><h3>${title}</h3><div class="fw-check-list">${entries.map(object => checkItem(study, graph, object)).join('')}</div></section>`).join('')}</div>`;
  }

  function editHistory(study, object) {
    const revisions = [...(object?.history || []), object];
    const corrections = [...(object?.correctionHistory || [])].reverse();
    const changes = revisions.slice(1).map((after, index) => ({ before: revisions[index], after }))
      .filter(({ before, after }) => !corrections.some(correction => correction.fromVersion === before.version && correction.toVersion === after.version && correction.before === before.text && correction.after === after.text)).reverse();
    // 推导旧快照只保留端点 ID，不能用当前主张的文字冒充当时表述。
    const reference = id => id ? `主张 ID：${escape(id)}` : '未记录';
    const content = (saved, structureChanged) => `${text(saved)}${structureChanged ? `<dl class="fw-edit-structure"><dt>前提</dt><dd>${(saved.premises || []).map(reference).join('；') || '未记录'}</dd><dt>结论</dt><dd>${reference(saved.conclusion)}</dd><dt>组合方式</dt><dd>${escape(saved.combination || '未说明')}</dd></dl>` : ''}`;
    const renderChange = ({ before, after }, latest) => {
      const structureChanged = after.type === 'inference' && (
        JSON.stringify(before.premises || []) !== JSON.stringify(after.premises || [])
        || before.conclusion !== after.conclusion || before.combination !== after.combination
      );
      const at = after.edit?.at ? new Date(after.edit.at) : null;
      const time = at && Number.isFinite(at.getTime())
        ? `<time datetime="${escape(at.toISOString())}">${escape(at.toLocaleString('zh-CN'))}</time>`
        : '保存时间未记录';
      const reason = String(after.edit?.reason ?? after.changeReason ?? '').trim();
      return `<article class="fw-edit-change">${latest ? `<h4>${study.directCanvas ? '最近一次个人改写' : '最近一次保存'}</h4>` : ''}<p class="fw-panel-meta">${time}</p><div class="fw-edit-pair"><section class="fw-edit-before"><h5>改前</h5><div class="fw-edit-content">${content(before, structureChanged)}</div></section><span class="fw-edit-direction" aria-label="改为">→</span><section class="fw-edit-after"><h5>改后</h5><div class="fw-edit-content">${content(after, structureChanged)}</div></section></div>${reason ? `<p class="fw-edit-reason">修改理由：${escape(reason)}</p>` : ''}</article>`;
    };
    const body = changes.length
      ? `${renderChange(changes[0], true)}${changes.length > 1 ? `<details class="fw-edit-earlier"><summary>更早的修改</summary>${changes.slice(1).map(change => renderChange(change, false)).join('')}</details>` : ''}`
      : `<p class="fw-panel-empty">${study.directCanvas ? '这项内容尚无个人正文或推导结构改写。' : '这项内容还没有保存过修改。'}</p>`;
    const correctionBody = corrections.length ? `<section class="fw-correction-history"><h4>来源整理校正</h4><p class="fw-panel-note">这些记录修正系统对来源的整理，独立于个人改写；材料原文与初始整理保留。</p>${corrections.map(correction => {
      const at = correction.at ? new Date(correction.at) : null;
      const time = at && Number.isFinite(at.getTime()) ? `<time datetime="${escape(at.toISOString())}">${escape(at.toLocaleString('zh-CN'))}</time>` : '保存时间未记录';
      const correctionContent = (saved, fallback) => saved && typeof saved === 'object'
        ? content(saved, Array.isArray(saved.premises) || 'conclusion' in saved || 'combination' in saved)
        : escape(fallback);
      const endpointChange = correction.correctedPremise
        ? `<p class="fw-panel-note">本次校正对应的前提引用：${reference(correction.correctedPremise.before)} → ${reference(correction.correctedPremise.after)}。这里展示当时保存的端点 ID。</p>` : '';
      return `<article class="fw-edit-change" data-correction-version="${escape(correction.toVersion)}"><p class="fw-panel-meta">${time} · v${escape(correction.fromVersion)} → v${escape(correction.toVersion)}</p><div class="fw-edit-pair"><section class="fw-edit-before"><h5>校正前的整理</h5><div class="fw-edit-content">${correctionContent(correction.beforeContent, correction.before)}</div></section><span class="fw-edit-direction" aria-label="校正为">→</span><section class="fw-edit-after"><h5>校正后的整理</h5><div class="fw-edit-content">${correctionContent(correction.afterContent, correction.after)}</div></section></div>${endpointChange}${correction.reason ? `<p class="fw-edit-reason">校正理由：${escape(correction.reason)}</p>` : ''}${anchor(study, correction.sourceRef, '查看校正依据的原文')}</article>`;
    }).join('')}</section>` : '';
    return `<details class="fw-edit-history" data-history-id="${escape(object?.id)}"><summary>修改记录</summary>${body}${correctionBody}</details>`;
  }

  function history(study) {
    const log = study.log || [], list = objects(study.mine).filter(object => (object.history || []).length || (object.correctionHistory || []).length);
    const intro = heading('研究记录', study.directCanvas ? '这里保留本次研究的操作；具体改动回到对应主张或推导查看。研究记录随当前工作区保存在本机，以顶部保存状态为准。' : '这里保留本次研究的操作；具体改动回到对应主张或推导查看。刷新后本次页面内容清空。');
    const actions = `<section class="fw-panel-section"><h3>实际操作</h3>${log.length ? `<ol class="fw-history-log" reversed start="${log.length}">${[...log].reverse().map(entry => `<li>${escape(entry)}</li>`).join('')}</ol>` : '<p class="fw-panel-empty">尚未留下研究操作记录。</p>'}</section>`;
    const personal = `<section class="fw-panel-section"><h3>${study.directCanvas ? '改写或校正过的主张与推导' : '改过的主张与推导'}</h3>${list.length ? `<div class="fw-history-items">${list.map(object => `<article class="fw-history-item">${meta(study, object)}<h4>${text(object)}</h4><button type="button" data-lab="history-item" data-id="${escape(object.id)}">查看修改记录</button></article>`).join('')}</div>` : '<p class="fw-panel-empty">尚未保存主张或推导的修改。</p>'}</section>`;
    return `<div class="fw-panel fw-panel-history">${intro}${actions}${personal}</div>`;
  }

  function original(study, object, label) {
    if (!object) return '<article class="fw-baseline-card"><p class="fw-panel-gap">这项原版内容暂缺。</p></article>';
    return `<article class="fw-baseline-card">${label ? `<h4>${escape(label)}</h4>` : ''}${meta(study, object)}<p class="fw-panel-statement">${text(object)}</p>${object.sourceRef ? anchor(study, object.sourceRef, '定位原版出处') : `<p class="fw-panel-gap">${object.origin === 'AI 推断' ? study.directCanvas ? 'AI 补充候选，原文未明确表达；继续研究和编辑仍保留 AI 归属。' : 'AI 补充，原文未明确表达。收录后仍保留 AI 归属。' : '原版未记录可回查引用。'}</p>`}</article>`;
  }

  function selectedComparison(study, graph) {
    const current = item(study.mine, study.selected);
    if (!current) return `<p class="fw-panel-note">${study.directCanvas ? '可选中研究画布中的主张或推导，再在这里查看对应变化。' : '可选中个人主张或推导，再在这里查看对应变化。'}</p>`;
    let before = item(graph, current.id);
    if (study.directCanvas && !before) {
      // A scoped edit creates a new node, while its original comparison stays
      // under the source node. Follow that chain without inventing a baseline.
      const seen = new Set(); let cursor = current;
      while (cursor && !seen.has(cursor.id) && !before) {
        seen.add(cursor.id);
        before = item(graph, cursor.id);
        if (!before) {
          const sourceId = cursor.adoptedFrom || cursor.base?.id;
          before = sourceId ? objects(graph).find(object => object.adoptedFrom === sourceId || object.id === sourceId) : null;
        }
        cursor = item(study.mine, cursor.localOf || cursor.localVersionOf);
      }
      before ||= current.base || null;
    }
    if (!before) return `<section class="fw-baseline-comparison"><h3>当前选中项</h3>${meta(study, current)}<p class="fw-panel-statement">${text(current)}</p><p class="fw-panel-gap">${study.directCanvas ? '这项内容没有初始整理对照项；个人补充不归给作者。' : '这项内容没有收录时的原版对照项；个人补充不归给作者。'}</p></section>`;
    const changedStructure = current.type === 'inference' && (
      JSON.stringify(current.premises || []) !== JSON.stringify(before.premises || [])
      || current.conclusion !== before.conclusion || current.combination !== before.combination
    );
    const corrected = (current.correctionHistory || []).length > 0, edited = OpenStudy.isEdited(current);
    const difference = before.text === current.text
      ? `当前表述保留原版${changedStructure ? '，推导结构已有变化' : ''}。`
      : study.directCanvas && corrected ? edited ? '当前版本包含来源整理校正和个人改写，两类记录分别保留。' : '当前整理表述已校正；这次校正不属于个人改写，初始整理仍保留。'
        : study.directCanvas && !edited ? '当前表述与初始对照不同，具体变化见修改记录。' : '个人表述已修改，原版仍保留。';
    return `<section class="fw-baseline-comparison"><h3>当前选中项的变化</h3><div class="fw-baseline-comparison-columns"><article><h4>${study.directCanvas ? '初始整理对照' : '收录时原版'} · v${escape(before.version)}</h4>${meta(study, before)}<p class="fw-panel-statement">${text(before)}</p></article><article><h4>${study.directCanvas ? '当前研究版' : '我的当前版'} · v${escape(current.version)}</h4>${meta(study, current)}<p class="fw-panel-statement">${text(current)}</p><p>个人立场：${escape(current.stance || '待研究')}${current.reason ? `；理由：${escape(current.reason)}` : ''}</p>${current.changeReason ? `<p>修改理由：${escape(current.changeReason)}</p>` : ''}</article></div><p class="fw-panel-note">${difference}</p>${changedStructure ? `<p>原版前提：${escape((before.premises || []).map(id => item(graph, id)?.text || id).join('；'))}<br>当前前提：${escape((current.premises || []).map(id => item(study.mine, id)?.text || id).join('；'))}<br>原版组合：${escape(before.combination || '未说明')}；当前组合：${escape(current.combination || '未说明')}</p>` : ''}</section>`;
  }

  function baseline(study) {
    const graph = study.baseline, list = objects(graph);
    const intro = heading(study.directCanvas ? '整理原版与初始对照' : '收录时的原版链条', study.directCanvas ? '这里只读展示开始研究时保留的初始整理，主画布继续保留当前研究。初始对照不随改写、校正或来源更新替换；查看和编辑都不表示认可。' : '这里只读展示收录时保留的原版，主画布继续保留个人论证。基线不随当前候选或作者更新替换；查看不表示认可。');
    if (!list.length) return `<div class="fw-panel fw-panel-baseline">${intro}<p class="fw-panel-empty">${study.directCanvas ? '尚未保存初始整理对照。不会用后来的材料或整理结果补成旧版本，也不会为个人补充制造作者原版。' : '尚未保存收录时的原版链条。不会用当前作者候选替代，也不会为个人补充制造作者原版。'}</p>${selectedComparison(study, graph)}</div>`;
    const connected = new Set(), steps = values(graph.edges).map((edge, index) => {
      (edge.premises || []).forEach(id => connected.add(id));
      connected.add(edge.conclusion);
      return `<article class="fw-baseline-step"><header><h3>第 ${index + 1} 步推导</h3><p class="fw-panel-meta">${escape(edge.combination || '前提组合未说明')}</p></header><div class="fw-baseline-chain"><section class="fw-baseline-premises"><h4>依赖的前提</h4>${(edge.premises || []).length ? edge.premises.map(id => original(study, item(graph, id))).join('') : '<p class="fw-panel-gap">原版未记录前提。</p>'}</section><p class="fw-baseline-direction" aria-label="前提通过推导关系支持结论">→</p><section class="fw-baseline-relation">${original(study, edge, '这一步如何推导')}</section><p class="fw-baseline-direction" aria-hidden="true">→</p><section class="fw-baseline-conclusion">${original(study, item(graph, edge.conclusion), '支持的结论')}</section></div></article>`;
    });
    const unlinked = values(graph.nodes).filter(object => !connected.has(object.id));
    const sample = (study.sources || []).some(source => /模拟/.test(`${source.title || ''} ${source.author || ''} ${source.access || ''}`))
      ? `<p class="fw-panel-note">标注为模拟的作者与公开披露是示例材料；${study.directCanvas ? '这里保留的是本次研究的初始整理结果。' : '这里保留的是你的实际收录内容。'}</p>` : '';
    return `<div class="fw-panel fw-panel-baseline">${intro}${sample}${selectedComparison(study, graph)}<section class="fw-panel-section"><h3>原版完整链条</h3>${steps.join('') || '<p class="fw-panel-empty">原版尚未记录推导关系。</p>'}${unlinked.length ? `<section class="fw-baseline-unlinked"><h3>原版中尚未连入推导的主张</h3>${unlinked.map(object => original(study, object)).join('')}</section>` : ''}</section></div>`;
  }

  window.ForkwisePanels = { checks, history, baseline, editHistory };
})();
