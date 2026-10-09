export function currentEvaluations(objects, condition) {
  const rows = objects.filter(
    (e) =>
      e.kind === 'evaluation' &&
      e.data.condition.id === condition.id &&
      e.data.condition.versionId === condition.contentVersionId,
  );
  return {
    confirmed: rows.filter((e) => e.data.evaluator === 'human').at(-1),
    candidate: rows.filter((e) => e.data.evaluator !== 'human').at(-1),
  };
}
export function attachResearch({
  submitTask,
  api,
  run,
  message,
  getState,
  getSelected,
  write,
  jobs,
  useReason,
  useImpact,
  openImpactReviews,
  textReader,
}) {
  const $ = (s) => document.querySelector(s);
  const appendCitations = (parent, citations) => {
    const projectId = getState()?.project.id;
    for (const citation of citations ?? []) {
      const quote = document.createElement('blockquote'),
        read = document.createElement('button');
      quote.textContent = citation.quote;
      read.textContent = '定位这条引用';
      read.onclick = () => {
        if (getState()?.project.id === projectId) void textReader.open(citation);
      };
      parent.append(quote, read);
    }
  };
  $('#choose-task-materials').onclick = () => {
    const state = getState();
    if (!state) {
      message('请先选择项目', true);
      return;
    }
    const box = $('#task-materials');
    box.replaceChildren();
    for (const version of state.objects.filter(
      (e) => e.kind === 'source_version' && e.data.textLength > 0,
    )) {
      const source = state.objects.find((e) => e.id === version.data.sourceId),
        label = document.createElement('label'),
        input = document.createElement('input');
      input.type = 'checkbox';
      input.value = version.id;
      label.append(input, `${source?.data.title ?? version.id} · ${version.data.retrievedAt}`);
      box.append(label);
    }
  };
  $('#run-research-task').onclick = () =>
    run(async () => {
      const state = getState();
      if (!state) throw new Error('请先选择项目');
      const kind = $('#task-kind').value;
      const sourceVersionIds = [...document.querySelectorAll('#task-materials input:checked')].map(
        (e) => e.value,
      );
      if (!sourceVersionIds.length) throw new Error('请明确选择本任务使用的材料版本');
      const target = getSelected();
      if (!['initial', 'reconstruct'].includes(kind) && !target)
        throw new Error('请先在画布选择研究对象');
      const asOf = $('#research-as-of').value;
      const queries = $('#task-queries')
        .value.split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (queries.length > 8 || queries.some((s) => s.length > 200))
        throw new Error('请填写最多 8 个关键词，每个不超过 200 字符');
      const retrieval = queries.length ? { retrieval: { queries, maxCharacters: 80_000 } } : {};
      await submitTask(
        state.project.id,
        `/${kind === 'initial' ? 'initial-research' : 'research-tasks'}`,
        kind === 'initial'
          ? {
              sourceVersionIds,
              ...(asOf ? { asOf: new Date(asOf).toISOString() } : {}),
              ...retrieval,
            }
          : { kind, sourceVersionIds, targetIds: target ? [target] : [], ...retrieval },
      );
      message(
        kind === 'initial'
          ? '首次研究已创建：先梳理，再从维护目录取得公开依据并查证。阶段失败会保留已完成内容。'
          : '任务已创建，只处理选定材料与必要上下文；结果保留 AI 归属',
      );
      await jobs();
    });
  return function showJob(job) {
    const box = $('#task-result');
    box.closest('details').open = true;
    box.replaceChildren();
    const output = job.output;
    if (job.historyState === 'undone' || job.historyState === 'stopped') {
      const history = document.createElement('p');
      history.textContent =
        job.historyState === 'undone'
          ? '这次研究结果已从图谱撤销，下面保留原任务记录。'
          : '这次研究已停止执行，下面仅为已完成阶段的记录；继续查证请发起新的研究任务。';
      box.append(history);
    }
    if (job.kind === 'source.sec-history') {
      const note = document.createElement('p');
      note.textContent = output?.sourceVersionId
        ? `历史索引已保存：${output.history?.name ?? ''}；它记录申报元数据，不表示已取得申报正文。`
        : (job.error ?? '正在取得固定父索引列出的历史文件');
      box.append(note);
      if (output?.sourceVersionId) {
        const read = document.createElement('button'),
          projectId = job.projectId;
        read.textContent = '阅读历史索引原文';
        read.onclick = () => {
          if (getState()?.project.id === projectId) void textReader.open(output.sourceVersionId);
        };
        box.append(read);
      }
      return;
    }
    if (job.kind === 'source.sec-filing') {
      const note = document.createElement('p');
      note.textContent = output?.sourceVersionId
        ? `HTML 主文件已保存，正文解析：${{ complete: '已提取正文', partial: '部分完成', failed: '失败' }[output.parseStatus] ?? '等待处理'}。资料取得与观点查证分别处理。`
        : (job.error ??
          (output?.fileId ? '原文件已保存，正文解析尚未完成。' : '正在取得选定申报主文件。'));
      box.append(note);
      if (job.error && output?.sourceVersionId) {
        const error = document.createElement('p');
        error.textContent = job.error;
        box.append(error);
      }
      for (const gap of output?.gaps ?? []) {
        const p = document.createElement('p');
        p.textContent = gap;
        box.append(p);
      }
      if (output?.lineage) {
        const p = document.createElement('p');
        p.textContent = `申报编号：${output.lineage.accessionNumber}；索引披露日期：${output.lineage.filingDate ?? '未知'}；不据此推定完整财务期间或精确发布时间。`;
        box.append(p);
      }
      if (output?.sourceVersionId && output.parseStatus !== 'failed') {
        const read = document.createElement('button'),
          projectId = job.projectId;
        read.textContent = '查看保存的申报正文';
        read.onclick = () => {
          if (getState()?.project.id === projectId) void textReader.open(output.sourceVersionId);
        };
        box.append(read);
      }
      return;
    }
    if (job.kind === 'workflow.initial' && output) {
      const stages = {
        reconstruction: '梳理论证',
        planning: '规划查证资料',
        acquisition: '取得公开依据',
        history: '取得范围内历史索引',
        filings: '选取并取得申报正文',
        verification: '逐项查证',
        complete: '本次流程已结束',
      };
      const states = {
        pending: '等待处理',
        completed: '核查已返回',
        failed: '执行失败',
        uncovered: '依据未覆盖',
        stale: '目标已改变',
        available: '材料已取得',
        not_known: '当时未取得',
      };
      const add = (text) => {
        const p = document.createElement('p');
        p.textContent = text;
        box.append(p);
      };
      const child = (id, title) => {
        if (!id) return;
        const projectId = getState()?.project.id,
          button = document.createElement('button');
        button.textContent = title;
        button.onclick = () =>
          run(async () => {
            const next = await api(`/projects/${projectId}/jobs/${id}`);
            if (getState()?.project.id === projectId) showJob(next);
          });
        box.append(button);
      };
      add(stages[output.stage] ?? output.stage);
      if (job.error) add(job.error);
      add('核查完成仅表示已返回分析；未来预测只核对当前依据，个人判断需单独保存。');
      child(output.reconstructionJobId, '查看论证梳理结果');
      for (const acquisition of output.acquisitions ?? [])
        add(
          `SEC ${acquisition.request.cik} · ${acquisition.request.dataset}：${states[acquisition.state]}${acquisition.error ? '；' + acquisition.error : ''}`,
        );
      for (const acquisition of output.history?.acquisitions ?? []) {
        add(
          `历史分片 ${acquisition.request.fileName}：${states[acquisition.state]}${acquisition.error ? '；' + acquisition.error : ''}`,
        );
        child(acquisition.jobId, '查看历史分片结果');
        if (acquisition.sourceVersionId && acquisition.state === 'available') {
          const read = document.createElement('button'),
            projectId = job.projectId;
          read.textContent = '阅读本次历史索引';
          read.onclick = () => {
            if (getState()?.project.id === projectId)
              void textReader.open(acquisition.sourceVersionId);
          };
          box.append(read);
        }
      }
      for (const acquisition of output.filings?.acquisitions ?? []) {
        add(
          `申报正文 ${acquisition.request.accessionNumber}：${states[acquisition.state]}${acquisition.error ? '；' + acquisition.error : ''}`,
        );
        for (const gap of acquisition.gaps ?? []) add(gap);
        child(acquisition.jobId, '查看正文获取结果');
        if (acquisition.sourceVersionId && acquisition.state === 'available') {
          const read = document.createElement('button'),
            projectId = job.projectId;
          read.textContent = '阅读本次使用的正文';
          read.onclick = () => {
            if (getState()?.project.id === projectId)
              void textReader.open(acquisition.sourceVersionId);
          };
          box.append(read);
        }
      }
      for (const check of output.checks ?? []) {
        const target = output.targets?.find((t) => t.id === check.target.id),
          plan = output.plan?.targets.find((t) => t.target.id === check.target.id);
        add(
          `${target?.data.text ?? target?.data.reason ?? check.target.id}：${states[check.state]}${check.error ? '；' + check.error : ''}`,
        );
        if (plan?.period) add(`业务期间：${plan.period}`);
        if (plan?.verificationEvent) add(`待观察事件（AI 建议）：${plan.verificationEvent}`);
        for (const gap of plan?.gaps ?? []) add(gap);
        for (const selection of output.history?.selections?.filter(
          (s) => s.targetId === check.target.id,
        ) ?? []) {
          add(
            `历史目录选择：披露日期 ${selection.filter.filedFrom} 至 ${selection.filter.filedThrough}；选择 ${selection.fileNames.length} 个分片，${selection.excludedFiles === null ? '其余覆盖未确定' : `${selection.excludedFiles} 个目录范围不重叠，未读取`}。${selection.state === 'failed' ? '部分目录不能确定或读取。' : ''}`,
          );
          for (const gap of selection.gaps) add(gap);
        }
        for (const selection of output.filings?.selections?.filter(
          (s) => s.targetId === check.target.id,
        ) ?? []) {
          add(
            `自动选报：${selection.filter.forms.join('、')}；披露日期 ${selection.filter.filedFrom} 至 ${selection.filter.filedThrough}（含首尾）；${selection.matchedRecords === null ? '匹配数量未确定' : `当前索引匹配 ${selection.matchedRecords} 条`}，选取 ${selection.documents.length} 个主文件${selection.state === 'failed' ? '；选取存在未完成项' : ''}。披露日期与业务期间分别核对。`,
          );
          for (const gap of selection.gaps) add(gap);
        }
        child(check.jobId, '查看这项查证与依据');
        for (const prior of check.previousJobIds ?? []) child(prior, '查看此前材料下的查证');
      }
      for (const gap of output.gaps ?? []) add(gap);
      return;
    }
    if (!output?.result) {
      const note = document.createElement('p');
      note.textContent = job.error ?? '任务尚无可用结果';
      box.append(note);
      return;
    }
    const label = document.createElement('p');
    label.textContent = `${output.stale ? '对应旧内容版本；' : '当前任务结果；'}所选材料：${output.coverage.sourceVersionIds.length} 个版本。${output.coverage.networkQueries.length === 0 ? '本任务未执行联网查询。' : ''}`;
    box.append(label);
    if (output.coverage.retrieval) {
      const coverage = output.coverage.retrieval,
        note = document.createElement('p');
      note.textContent = `本次按关键词选取材料：${coverage.queries.join('、')}。已选取 ${coverage.selectedCharacters.toLocaleString()} 字符。${output.coverage.modelCalled === false ? '未取得可用片段，未调用模型。' : coverage.sources.every((s) => s.complete) ? '本次片段覆盖所选全文。' : '没有读取全文。'}`;
      box.append(note);
      for (const source of coverage.sources) {
        const state = getState(),
          version = state?.objects.find((e) => e.id === source.sourceVersionId),
          title =
            state?.objects.find((e) => e.id === version?.data.sourceId)?.data.title ?? '所选材料';
        const details = document.createElement('details'),
          summary = document.createElement('summary');
        summary.textContent = `${title}：本次 ${source.selectedCharacters.toLocaleString()} / 原文 ${source.totalCharacters.toLocaleString()} 字符；${source.complete ? '全文' : '局部覆盖'}`;
        details.append(summary);
        if (source.structure) {
          const note = document.createElement('p');
          note.textContent =
            source.structure.method === 'sec_submissions_v1'
              ? `按申报记录选取 ${source.structure.records.length} / 匹配 ${source.structure.matchedRecords} 条，仅包含申报索引；正文与附件未读取。另列 ${source.structure.historyFileCount ?? 0} 个历史索引文件，本次未读取其内容。`
              : `按财务记录选取 ${source.structure.records.length} / 匹配 ${source.structure.matchedRecords} 条，包含主体、科目和单位的原文。不同披露分别保留；单季或累计、与主张是否可比仍需核对。`;
          details.append(note);
        }
        const fragments =
          job.input?.materials?.filter((m) => m.id === source.sourceVersionId) ?? [];
        const appendFragment = (container, fragment) => {
          const pre = document.createElement('pre');
          if (fragment.structure) {
            const label = document.createElement('p');
            const roles = {
              subject: '主体',
              taxonomy: '分类',
              concept: '科目',
              label: '科目名称',
              description: '科目说明',
              unit: '单位',
              fact: '披露记录',
              filing: '申报标识',
              filing_field: '申报字段',
              history_index: '未读取的历史索引目录',
            };
            const columns = {
              accessionNumber: '申报标识',
              filingDate: '披露日期',
              reportDate: '报告期间日期',
              acceptanceDateTime: '接收时间（原值）',
              form: '申报类型',
              primaryDocument: '主文件名',
              primaryDocDescription: '主文件说明',
              size: '文件大小',
              isXBRL: 'XBRL 标记',
              isInlineXBRL: '内联 XBRL 标记',
              fileNumber: '档案号',
              filmNumber: '影像编号',
              items: '申报事项',
            };
            const column = fragment.structure.pointer.split('/').at(-2);
            label.textContent =
              fragment.structure.format === 'sec_submissions_v1'
                ? (columns[column] ?? roles[fragment.structure.role] ?? '索引原文')
                : `${roles[fragment.structure.role] ?? '原文'} · ${fragment.structure.pointer}`;
            container.append(label);
          }
          pre.textContent = fragment.text ?? '原文因权限或存档缺失不可查看';
          container.append(pre);
          if (typeof fragment.text === 'string')
            appendCitations(container, [
              {
                sourceVersionId: source.sourceVersionId,
                start: fragment.start,
                end: fragment.end,
                quote: fragment.text,
              },
            ]);
          const record = source.structure?.records.find(
            (r) => r.pointer === fragment.structure?.pointer,
          );
          if (record?.gaps.length) {
            const gap = document.createElement('p');
            gap.textContent = record.gaps.join('；');
            container.append(gap);
          }
        };
        if (source.structure?.method === 'sec_submissions_v1') {
          for (const fragment of fragments.filter((m) => !m.structure?.recordPointer))
            appendFragment(details, fragment);
          for (const record of source.structure.records) {
            const rows = fragments.filter((m) => m.structure?.recordPointer === record.pointer);
            const field = (name) => {
              const fragment = rows.find((m) => m.structure.pointer.split('/').at(-2) === name);
              try {
                const value = JSON.parse(fragment?.text);
                return typeof value === 'string' ? value : '';
              } catch {
                return '';
              }
            };
            const group = document.createElement('details'),
              heading = document.createElement('summary');
            group.dataset.submission = record.pointer;
            heading.textContent = `${field('form') || '申报类型未知'} · ${field('filingDate') || '日期未知'} · ${record.accessionNumber || '编号未知'}`;
            group.append(heading);
            for (const fragment of rows) appendFragment(group, fragment);
            if (
              typeof record.documentUrl === 'string' &&
              /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
                record.documentUrl,
              )
            ) {
              const link = document.createElement('a');
              link.href = record.documentUrl;
              link.target = '_blank';
              link.rel = 'noopener noreferrer';
              link.textContent = '打开 SEC 申报文件（外部网页）';
              group.append(link);
              if (/\.html?$/i.test(record.documentUrl)) {
                const fetchButton = document.createElement('button'),
                  projectId = state?.project.id;
                fetchButton.textContent = '获取正文并保存为材料';
                fetchButton.onclick = () =>
                  run(async () => {
                    if (getState()?.project.id !== projectId)
                      throw new Error('项目已切换，请在原项目取得正文');
                    fetchButton.disabled = true;
                    try {
                      await submitTask(projectId, '/public-data/filing', {
                        indexSourceVersionId: source.sourceVersionId,
                        accessionNumber: record.accessionNumber,
                      });
                      message('正文获取任务已保存；可在任务结果查看正文、解析状态和缺口。');
                      await jobs();
                    } finally {
                      fetchButton.disabled = false;
                    }
                  });
                group.append(fetchButton);
              }
            }
            details.append(group);
          }
        } else for (const fragment of fragments) appendFragment(details, fragment);
        const read = document.createElement('button'),
          projectId = state?.project.id;
        read.textContent = '查看完整保存原文';
        read.onclick = () => {
          if (getState()?.project.id === projectId) void textReader.open(source.sourceVersionId);
        };
        details.append(read);
        box.append(details);
      }
      const gaps = document.createElement('p');
      gaps.textContent = coverage.gaps.join('；');
      box.append(gaps);
    }
    for (const [i, proposal] of (output.result.proposals ?? []).entries()) {
      const p = document.createElement('p');
      p.textContent =
        (proposal.proposedText ? `建议改为：${proposal.proposedText}\n` : '') + proposal.reason;
      box.append(p);
      appendCitations(box, proposal.citations);
      if (job.kind === 'research.impact') {
        const review = document.createElement('button');
        review.textContent = '查看并处理影响建议';
        review.onclick = () => run(() => openImpactReviews(job.id));
        box.append(review);
        const button = document.createElement('button');
        button.textContent = '放入正文草稿并选择作用范围';
        button.onclick = () => {
          try {
            useImpact(job, i, proposal);
            message('建议已放入正文草稿。核对内容与作用范围后保存，个人立场需要重新判断');
          } catch (error) {
            message(error.message, true);
          }
        };
        box.append(button);
      }
      if (job.kind === 'research.stance_draft') {
        const button = document.createElement('button');
        button.textContent = '放入立场理由草稿';
        button.onclick = () => {
          try {
            useReason(job, i, proposal);
            message('已填入 AI 理由草稿，请自行选择立场后保存');
          } catch (error) {
            message(error.message, true);
          }
        };
        box.append(button);
      }
    }
    for (const check of output.result.checks ?? []) {
      const p = document.createElement('p');
      const aspects = {
        reported_fact: '已披露事实核对',
        current_basis: '预测的当前依据',
        inference_basis: '推导根据',
      };
      const relations = {
        supports: '支持依据',
        opposes: '相反依据',
        qualifies: '限定依据',
        background: '背景资料',
        insufficient: '证据不足',
      };
      p.textContent = `${aspects[check.aspect] ? aspects[check.aspect] + '；' : ''}${relations[check.relation] ?? check.relation}：${check.explanation}`;
      box.append(p);
      appendCitations(box, check.citations);
    }
    const gaps = document.createElement('p');
    gaps.textContent = (output.result.gaps ?? []).join('；');
    box.append(gaps);
    const state = getState();
    for (const entity of state?.objects.filter(
      (e) =>
        e.kind === 'evidence_link' &&
        e.data.participation === 'candidate' &&
        e.id.startsWith(`link_${job.id}_`),
    ) ?? []) {
      const button = document.createElement('button');
      button.textContent = `采用这条 ${entity.data.relation} 依据`;
      button.onclick = () => run(() => write([{ op: 'evidence.adopt', id: entity.id }]));
      box.append(button);
    }
  };
}
