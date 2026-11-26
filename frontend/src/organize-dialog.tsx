import { useLayoutEffect, useEffect, useRef, useState } from 'react';
import { api, MappingError, type Card, type Command } from './api';
import { organizeTextBlocks } from '../../backend/src/mapping/organize-blocks';
import { canRetryOrganize } from '../../backend/src/mapping/organize-state';
import type { OrganizeRequest, OrganizeStatus, OrganizeSummary, OrganizeTask, OrganizeTaskView } from '../../backend/src/mapping/organize-contracts';
import { VerificationQuery } from '../../backend/src/mapping/verification-contracts';
import { emptyVerificationDraft, VerificationForm, VerificationReview, VerificationScope } from './verification-review';

const states: Record<OrganizeTask['state'], string> = {
  running: '正在整理', succeeded: '可以审阅', partial: '部分完成', failed: '整理失败',
  cancelled: '已取消', interrupted: '运行已中断',
};
const modeName = (mode: OrganizeTask['mode']) => mode === 'real' ? '模型整理' : '模拟整理';
const taskReadError = '暂时无法读取任务状态，正在重新连接';
const blockNames: Record<string, string> = {
  text: '段落', heading: '正文标题', listItem: '列表项', quote: '引用', code: '代码块', table: '表格',
};

function ReviewGaps({ gaps, heading = '资料缺口' }: { gaps: readonly string[]; heading?: string }) {
  if (!gaps.length) return null;
  return <section aria-label={heading}>
    <h3>{heading}</h3>
    <ul>{gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>
  </section>;
}

export function OrganizeDialog({ projectId, source, verification, cards, pendingCancellations, isCancellationSaved, onPendingCancellationChange, close, onAdded }: {
  projectId: string;
  source?: Card;
  verification: boolean;
  cards: Card[];
  pendingCancellations: OrganizeRequest[];
  isCancellationSaved: (requestId: string) => boolean;
  onPendingCancellationChange: (request: OrganizeRequest, status: 'pending' | 'settled') => boolean;
  close: () => void;
  onAdded: (candidateId: string | undefined) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelStartButton = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const [queryDraft, setQueryDraft] = useState(emptyVerificationDraft);
  const [title, setTitle] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState<OrganizeStatus>();
  const [history, setHistory] = useState<OrganizeSummary[]>([]);
  const [task, setTask] = useState<OrganizeTaskView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [startingInput, setStartingInput] = useState(pendingCancellations[0]);
  const [cancellingStart, setCancellingStart] = useState(false);
  const startingRequest = useRef(startingInput ? { input: startingInput, cancelRequested: true } : null);
  const startRequest = useRef<{ key: string; id: string }>(null);
  const addRequest = useRef<{ key: string; command: Extract<Command, { type: 'organize.add' }> }>(null);
  const retryRequest = useRef<{ key: string; id: string }>(null);
  const cardId = task?.cardId ?? startingInput?.cardId ?? source?.id;
  const current = cards.find(card => card.id === cardId);
  const blocks = source ? organizeTextBlocks(source.body.blocks) : [];
  const chosen = blocks.filter(block => selected.includes(block.id));
  const length = (title ? source?.title.length ?? 0 : 0) + chosen.reduce((count, block) => count + block.text.length, 0);
  const freshness = !current ? 'deleted' : task
    ? current.versionId === task.input.thoughtVersionId && current.body.versionId === task.input.bodyVersionId ? task.freshness : 'changed'
    : current.versionId === source?.versionId && current.body.versionId === source.body.versionId ? 'current' : 'changed';
  const stale = !!(source || task) && freshness !== 'current';
  const addKey = task ? `${task.id}/${task.attempt}` : null;
  const pendingAdd = addRequest.current?.key === addKey;
  const starting = startingInput !== undefined;
  const cancellationRequested = starting && startingRequest.current?.cancelRequested === true;
  const unsavedCancellation = cancellationRequested && !cancellingStart && !isCancellationSaved(startingInput.requestId);
  const cancelStartBlocked = busy && cancellationRequested;
  const canRetry = !!task && canRetryOrganize(task);
  const model = modelStatus?.model;
  const retryBlockedReason = task?.retryBlockedReason ?? (!verification && task?.mode === 'real' &&
    model !== undefined && task.model !== model ? '这条记录使用的模型当前不可用，无法重试。' : undefined);
  const checkingRetry = verification && canRetry && !stale && task?.retryBlockedReason === undefined;
  const showDisclosure = !verification && (task
    ? task.mode === 'real' && task.model?.startsWith('openai/') && canRetry && !retryBlockedReason && model === task.model && !stale
    : model?.startsWith('openai/') && source && !starting);
  const query = verification ? VerificationQuery.safeParse({
    ...queryDraft, periodStart: queryDraft.periodStart || null,
  }) : null;
  const actionName = verification ? '公开查证' : 'AI 整理';
  const recordName = verification ? '查证记录' : '整理记录';
  const previousVerification = task?.verification && task.output && task.outputAttempt !== task.attempt;
  const latestVerificationOutput = previousVerification ? task.attempts.at(-1)?.output : undefined;
  const latestVerification = latestVerificationOutput?.verification;
  const stateName = (state: OrganizeTask['state']) => !verification ? states[state]
    : state === 'running' ? '正在查证' : state === 'failed' ? '查证失败' : states[state];

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    if (verification && source && !startingInput) element?.querySelector('input')?.focus();
    return () => element?.close();
  }, []);

  useLayoutEffect(() => {
    if (starting && !cancelStartBlocked) cancelStartButton.current?.focus();
    else if (!busy && !dialog.current?.contains(document.activeElement)) closeButton.current?.focus();
  }, [starting, busy, cancelStartBlocked]);

  useEffect(() => {
    let active = true;
    void Promise.all([api.organizeStatus(projectId, verification), api.organizeList(projectId, source?.id, verification)]).then(async ([status, list]) => {
      if (!active) return;
      setHistory(previous => [...previous, ...list.filter(item => !previous.some(saved => saved.id === item.id))]);
      const latest = list[0] && !startingRequest.current ? await api.organizeTask(projectId, list[0].id) : null;
      if (!active) return;
      setModelStatus(status);
      if (!startingRequest.current) setTask(previous => previous ?? latest);
    }).catch(() => {
      if (active) setError(`无法读取${actionName}设置和任务，请关闭后重新打开`);
    });
    return () => { active = false; };
  }, [projectId, source?.id, verification, actionName]);

  useEffect(() => {
    if (!task || (task.state !== 'running' && !checkingRetry) || busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.organizeTask(projectId, task.id);
        if (!active) return;
        setTask(next);
        setError(previous => previous === taskReadError ? '' : previous);
        if (next.state !== 'running') return;
      } catch {
        if (!active) return;
        setError(previous => previous || taskReadError);
      }
      timer = setTimeout(() => void poll(), 650);
    };
    timer = setTimeout(() => void poll(), 200);
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, task?.id, task?.attempt, task?.state, checkingRetry, busy]);

  async function start(mode: OrganizeRequest['mode']) {
    if (!source || composing.current || (verification && (!query?.success || modelStatus?.blockedReason))) return;
    const input = {
      mode, cardId: source.id, thoughtVersionId: source.versionId, bodyVersionId: source.body.versionId,
      includeTitle: title, blockIds: chosen.map(block => block.id),
      ...(query?.success ? { verification: query.data } : {}),
    };
    const key = JSON.stringify(input);
    if (startRequest.current?.key !== key) startRequest.current = { key, id: crypto.randomUUID() };
    const flight = { input: { requestId: startRequest.current.id, ...input }, cancelRequested: false };
    if (mode === 'real') {
      startingRequest.current = flight;
      setStartingInput(flight.input);
    }
    setBusy(true);
    setError('');
    try {
      const next = await api.organizeStart(projectId, flight.input);
      if (!flight.cancelRequested) acceptStart(next);
    } catch (cause) {
      if (!flight.cancelRequested)
        setError(cause instanceof MappingError ? cause.message : '任务回执未确认，可以按相同范围重试');
    } finally {
      if (!flight.cancelRequested) {
        startingRequest.current = null;
        setStartingInput(undefined);
        setBusy(false);
      }
    }
  }

  function acceptStart(next: OrganizeTask) {
    setTask(next);
    setHistory(list => [next, ...list.filter(item => item.id !== next.id)]);
    startRequest.current = null;
  }

  async function cancelStart() {
    const flight = startingRequest.current;
    if (!flight || cancelStartBlocked) return;
    flight.cancelRequested = true;
    const saved = onPendingCancellationChange(flight.input, 'pending') || isCancellationSaved(flight.input.requestId);
    setCancellingStart(true);
    setBusy(true);
    setError('');
    let settled = false;
    try {
      acceptStart(await api.organizeCancelStart(projectId, flight.input));
      settled = true;
    } catch (cause) {
      settled = cause instanceof MappingError && ['ORGANIZE_SOURCE_STALE', 'ORGANIZE_INVALID_SCOPE',
        'IDEMPOTENCY_MISMATCH', 'ORGANIZE_MODEL_UNCONFIGURED'].includes(cause.code);
      if (cause instanceof MappingError) setError(cause.message);
      else if (saved) setError('未确认取消结果，请重试取消');
    } finally {
      if (settled) {
        const cleared = onPendingCancellationChange(flight.input, 'settled');
        if (!cleared && saved) {
          const warning = '当前标签页无法清除旧记录，刷新后可能再次显示“取消结果未确认”。';
          setError(previous => previous ? `${previous} ${warning}` : warning);
        }
        startingRequest.current = null;
        setStartingInput(undefined);
      }
      setCancellingStart(false);
      setBusy(false);
    }
  }

  async function selectRecord(id: string) {
    setError('');
    if (!id) { setTask(null); return; }
    const pending = !source && pendingCancellations.find(request => `cancel:${request.requestId}` === id);
    if (pending) {
      startingRequest.current = { input: pending, cancelRequested: true };
      setStartingInput(pending);
      setTask(null);
      return;
    }
    setBusy(true);
    try {
      const next = await api.organizeTask(projectId, id);
      startingRequest.current = null;
      setStartingInput(undefined);
      setTask(next);
    } catch {
      setError('无法读取该任务，请重试');
    } finally {
      setBusy(false);
    }
  }

  async function change(action: 'retry' | 'cancel') {
    if (!task) return;
    setBusy(true);
    setError('');
    try {
      if (action === 'retry') {
        const key = `${task.id}/${task.attempt}`;
        if (retryRequest.current?.key !== key) retryRequest.current = { key, id: crypto.randomUUID() };
        setTask(await api.organizeRetry(projectId, task.id, task.attempt, retryRequest.current.id));
      } else {
        setTask(await api.organizeCancel(projectId, task.id, task.attempt));
      }
    } catch (cause) {
      setError(cause instanceof MappingError ? cause.message : '未确认操作结果，请重试');
      if (cause instanceof MappingError && cause.code === 'ORGANIZE_ATTEMPT_CHANGED')
        void api.organizeTask(projectId, task.id).then(setTask, () => {});
    } finally {
      setBusy(false);
    }
  }

  async function add(copyWhileCut?: true) {
    if (!task || !addKey) return;
    if (addRequest.current?.key !== addKey) {
      if (!current || stale) return;
      addRequest.current = { key: addKey, command: {
        commandId: crypto.randomUUID(), projectId, type: 'organize.add', expected: null,
        payload: { taskId: task.id, attempt: task.attempt,
          x: current.item.pose.x + current.item.pose.width + 24, y: current.item.pose.y,
          ...(task.verification && task.outputAttempt ? { outputAttempt: task.outputAttempt } : {}),
          ...(copyWhileCut ? { copyWhileCut } : {}) },
      } };
    }
    setError('');
    setBusy(true);
    try {
      const receipt = await api.execute(addRequest.current.command);
      const latest = await api.organizeTask(projectId, task.id);
      await onAdded(receipt.changedIds[0]);
      addRequest.current = null;
      setTask(latest);
    } catch (cause) {
      setError(cause instanceof MappingError ? cause.message : '未确认画布更新，请重试或重新打开项目核对');
      if (cause instanceof MappingError && ['ORGANIZE_SOURCE_STALE', 'ORGANIZE_RESULT_UNAVAILABLE'].includes(cause.code)) {
        addRequest.current = null;
        void api.organizeTask(projectId, task.id).then(setTask, () => {});
      }
    } finally {
      setBusy(false);
    }
  }

  return <dialog className="organize-dialog" aria-labelledby="organize-heading" ref={dialog}
    onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}
    onCancel={event => {
      event.preventDefault();
      if (composing.current) return;
      if (starting) void cancelStart();
      else if (!busy) close();
    }}>
    <header>
      <div>
        <h2 id="organize-heading">{source ? actionName : `${actionName}记录`}</h2>
        {(source || cardId) && <p className="organize-source">
          <span>{source ? '当前卡片' : '原卡：'}</span>
          <strong>{(source ?? current)?.title || (source || current ? '未命名卡片' : '原卡已删除')}</strong>
        </p>}
      </div>
      <button type="button" ref={closeButton} disabled={busy} onClick={close} aria-label={`关闭 ${actionName}`}>关闭</button>
    </header>
    <div className="organize-content">
      {stale && <p role="status">{freshness === 'deleted' ? '原卡已删除，仍可查看旧结果。' : '原卡内容已更新。关闭后重新打开，可选择当前内容。'}</p>}
      {(error || unsavedCancellation) && <p role="alert" className="organize-error">
        {error}{error && unsavedCancellation && <br />}
        {unsavedCancellation && '当前标签页无法保存这次取消请求，请保持页面打开并重试取消。'}
      </p>}
      {(history.length > 0 || (!source && pendingCancellations.length > 0)) && <label className="organize-history">{recordName}
        <select value={task?.id ?? (!source && startingInput ? `cancel:${startingInput.requestId}` : '')}
          disabled={busy || (!!source && starting)} onChange={event => void selectRecord(event.currentTarget.value)}>
          <option value="" disabled={!source}>{source ? (verification ? '重新查证' : '新建整理') : '选择任务'}</option>
          {!source && pendingCancellations.map(request => {
            const card = cards.find(item => item.id === request.cardId);
            return <option key={request.requestId} value={`cancel:${request.requestId}`}>
              取消结果未确认 · {card?.title || `${card ? '原卡无标题' : '原卡已删除'}（${request.cardId.slice(0, 8)}）`}
            </option>;
          })}
          {history.map(item => <option key={item.id} value={item.id}>
            {verification ? (item.verificationFixture ? '模拟查证' : actionName) : modeName(item.mode)} {new Date(item.createdAt).toLocaleString()}{!source && ` · ${cards.find(card => card.id === item.cardId)?.title || '原卡无标题或已删除'}`}
          </option>)}
        </select>
      </label>}
      {!task && source && !cancellationRequested ? verification ? <VerificationForm
        draft={queryDraft} onChange={setQueryDraft} disabled={stale || busy || starting}
        blockedReason={modelStatus?.blockedReason} fixture={modelStatus?.verificationFixture === true}
        invalid={queryDraft.periodStart && queryDraft.periodEnd && queryDraft.periodStart > queryDraft.periodEnd ? '业务期间起日须早于或等于末日。' : null}
      /> : <>
        <fieldset disabled={stale || busy || starting}>
          <legend>选择本次处理的内容</legend>
          {source.title.trim() && <label><input type="checkbox" checked={title} onChange={event => setTitle(event.currentTarget.checked)} />
            <span><strong>卡片标题</strong><span>{source.title}</span></span>
          </label>}
          {blocks.map((block, index) => {
            const label = `${blockNames[block.type]} ${index + 1}`;
            return <label key={block.id}>
              <input type="checkbox" checked={selected.includes(block.id)} aria-label={label}
                onChange={event => {
                  const checked = event.currentTarget.checked;
                  setSelected(previous => checked ? [...previous, block.id] : previous.filter(id => id !== block.id));
                }} />
              <span><strong>{label}</strong><span>{block.text}</span></span>
            </label>;
          })}
          {!source.title.trim() && blocks.length === 0 && <p>请先给这张卡添加标题或正文文字。</p>}
        </fieldset>
        <p className="organize-muted">本次处理勾选的标题与正文文字。{model ? `当前模型为 ${model}。` : model === null ? modelStatus?.blockedReason ?? 'OpenAI 尚未启用，可试用模拟整理。' : '正在读取模型设置。'}</p>
        <p className="organize-muted">模拟整理使用本机示例规则，不调用模型。</p>
        {length > 24_000 && <p role="alert">选中的文字超过 24,000 字符，请减少范围。</p>}
      </> : task ? <>
        <p role="status" className="organize-status"><strong>{verification ? (task.verificationFixture ? '模拟查证' : actionName) : modeName(task.mode)}</strong> {stateName(task.state)}{task.applied
          ? task.candidateOnCanvas ? '，已添加为新卡' : '，新卡已撤销或删除'
          : ''}</p>
        {task.error && <p role="alert" className="organize-error">{task.error}</p>}
        {canRetry && retryBlockedReason && <p className="organize-muted">{retryBlockedReason}</p>}
        {latestVerification && <p role="status" className="organize-error">
          第 {task.attempt} 次查证{latestVerification.evidence.status === 'access_failed' ? `访问失败。 ${latestVerification.evidence.reason}`
            : latestVerification.evidence.status === 'not_accessed' || latestVerification.evidence.status === 'not_retained'
              ? `未取得可回查的原文。 ${latestVerification.evidence.reason}` : '未得到可添加的结果。'}
        </p>}
        {latestVerificationOutput && <ReviewGaps gaps={latestVerificationOutput.gaps} heading={`第 ${task.attempt} 次查证资料缺口`} />}
        {task.output && task.outputAttempt !== task.attempt && <p className="organize-muted">下方显示第 {task.outputAttempt} 次的结果。</p>}
        {task.verification && <VerificationScope query={task.verification} subject={task.output?.verification?.subject} />}
        {task.verification && task.output?.verification && <VerificationReview projectId={projectId}
          query={task.verification} result={task.output.verification} fixture={task.verificationFixture === true} />}
        {task.output?.candidate && (verification ? <details className="organize-result">
          <summary>要添加的卡片内容</summary>
          <h3>{task.output.candidate.title}</h3>
          <p>{task.output.candidate.text}</p>
        </details> : <article className="organize-result">
          <h3>{task.output.candidate.title}</h3>
          <p>{task.output.candidate.text}</p>
        </article>)}
        {task.output && <ReviewGaps gaps={task.output.gaps} />}
        {task.cutCopyAvailable && !stale && !pendingAdd && <p className="organize-muted">
          之前添加的卡片仍有首次粘贴资格。另建会生成一张独立的候选卡。
        </p>}
        <details>
          <summary>{verification ? '原卡版本和查证尝试' : '输入范围与用量'}</summary>
          {!verification && <p>{task.input.title === null ? '未选标题' : `标题：${task.input.title}`}，选了 {task.input.blocks.length} 个正文块，另有 {task.input.omittedBlockCount} 个块未处理。</p>}
          {task.input.blocks.map(block => <p className="organize-trace" key={block.id}>{block.text}</p>)}
          <p className="organize-trace">标题版本 {task.input.thoughtVersionId}<br />正文版本 {task.input.bodyVersionId}<br />任务 {task.id}</p>
          {task.verification ? <ul>{task.attempts.map(attempt => <li key={attempt.number}>
            第 {attempt.number} 次 · {new Date(attempt.requestedAt).toLocaleString()} · {stateName(attempt.state)}
            {attempt.error && <p>{attempt.error}</p>}
            {attempt.output?.verification && attempt.number !== task.outputAttempt && <details>
              <summary>查看这次结果</summary>
              <VerificationReview projectId={projectId} query={task.verification!} result={attempt.output.verification}
                fixture={task.verificationFixture === true} />
              <ReviewGaps gaps={attempt.output.gaps} />
            </details>}
          </li>)}</ul> : task.mode === 'simulate' ? <p>模拟在工作台中生成，无模型用量。</p> : <>
            <p>模型 {task.model}。费用未知。</p>
            <ul>{task.attempts.map(attempt => <li key={attempt.number}>
              第 {attempt.number} 次，{new Date(attempt.requestedAt).toLocaleString()}，{states[attempt.state]}
              {attempt.error && <p>{attempt.error}</p>}
              {attempt.output && attempt.number !== task.outputAttempt && <details>
                <summary>查看这次结果</summary>
                {attempt.output.candidate && <p className="organize-trace">{attempt.output.candidate.title}<br />{attempt.output.candidate.text}</p>}
                {!!attempt.output.gaps.length && <ul>{attempt.output.gaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul>}
              </details>}
              {attempt.usage?.modelDigest && <p className="organize-trace">模型摘要 {attempt.usage.modelDigest}</p>}
              {attempt.usage?.attempts.length ? <ul>{attempt.usage.attempts.map((call, index) => {
                const phase = call.phase ?? (index === 0 ? 'generate' : 'repair');
                return <li key={index}>{phase === 'repair' ? '格式修复' : '生成候选'} · {call.model}，
                  {call.responseReceived === false ? '已发起，用量未返回'
                    : `输入 ${call.inputTokens ?? '未知'}、输出 ${call.outputTokens ?? '未知'} token`}
                  {call.responseReceived !== false && call.model.startsWith('openai/') &&
                    (call.cachedInputTokens == null ? '，缓存命中未知' : `，缓存命中 ${call.cachedInputTokens} token`)}
                  {call.providerRequestId && `，请求号 ${call.providerRequestId}`}</li>;
              })}</ul>
                : attempt.state === 'running' ? '，正在检查模型' : '，未记录模型调用'}
            </li>)}</ul>
          </>}
        </details>
      </> : !starting && <p>{model === undefined ? `正在读取${recordName}。`
        : history.length ? `请选择要查看的${recordName}。` : `还没有${recordName}。请从卡片的 ${verification ? '公开查证' : 'AI'} 入口开始。`}</p>}
      {starting && <p role="status">{cancellingStart ? '正在确认取消'
        : cancellationRequested ? '取消结果未确认' : verification ? '正在发起查证' : '正在检查整理模型'}</p>}
    </div>
    <footer>
      {showDisclosure && <p id="organize-send-disclosure" className="organize-muted organize-send-disclosure">
        发送给 OpenAI API 的内容仅限{task ? '此任务原先选定并保存的' : '本次勾选的'}标题和正文文字，用于生成整理候选。请求关闭 OpenAI 的响应存储。数据留存按 API 项目的数据控制设置执行，启用前须核验零数据留存（ZDR）和不用于训练条款。
      </p>}
      {task ? <>
        {task.state === 'running' && <button type="button" disabled={busy} onClick={() => void change('cancel')}>取消任务</button>}
        {canRetry &&
          <button type="button" disabled={busy || stale || checkingRetry || !!retryBlockedReason} aria-describedby={showDisclosure ? 'organize-send-disclosure' : undefined}
            onClick={() => void change('retry')}>{verification ? '重试查证' : '重试整理'}</button>}
        {pendingAdd
          ? <button type="button" className="primary" disabled={busy} onClick={() => void add()}>确认添加结果</button>
          : task.cutCopyAvailable
          ? <button type="button" className="primary" disabled={busy || stale} onClick={() => void add(true)}>另建候选卡</button>
          : task.addAvailable &&
            <button type="button" className="primary" disabled={busy || stale} onClick={() => void add()}>
              {previousVerification ? `添加第 ${task.outputAttempt} 次结果` : '添加为新卡'}
            </button>}
      </> : starting
      ? <button type="button" ref={cancelStartButton} aria-disabled={cancelStartBlocked} onClick={() => void cancelStart()}>取消任务</button>
      : source && (verification ? <button type="button" className="primary"
        disabled={busy || stale || !query?.success || model === undefined || !!modelStatus?.blockedReason} onClick={() => void start('real')}>开始查证</button> : <>
        <button type="button" disabled={busy || stale || !length || length > 24_000 || selected.length > 100 || model === undefined}
          onClick={() => void start('simulate')}>试用模拟整理</button>
        <button type="button" className="primary" disabled={busy || stale || !model || !length || length > 24_000 || selected.length > 100}
          aria-describedby={showDisclosure ? 'organize-send-disclosure' : undefined}
          onClick={() => void start('real')}>用模型整理</button>
      </>)}
    </footer>
  </dialog>;
}
