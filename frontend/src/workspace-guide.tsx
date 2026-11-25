import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { WorkspaceGuidePreference } from '../../backend/src/mapping/mapping';
import './workspace-guide.css';

const preferenceUrl = '/api/workspace/guide';
type PreferenceSave = { value: WorkspaceGuidePreference; status: 'saving' | 'failed' };

const steps = [
  {
    title: '新建研究与卡片',
    instructions: <p>在顶栏点击<b>新建研究</b>。在空画布点击<b>新建卡片</b>，也可以在底部选<b>卡片</b>。点击画布放置卡片，输入标题后按 Enter。</p>,
  },
  {
    title: '用分区组织内容',
    instructions: <p>在底部选<b>分区</b>，在画布上拖出一个框。可以先画一个空分区，再把对象拖进去。</p>,
  },
  {
    title: '把批注附着到卡片',
    instructions: <p>分区或组合里的批注需要先移出。选中独立文字或形状，点击<b>附着到卡片</b>，再点击目标卡片。批注会随卡片移动。选中已附着的批注，点击<b>解除附着</b>可将它留在原处。</p>,
  },
];

export function WorkspaceGuide({ ready, showInvitation, editInProgress, open, dialog, navigation }: {
  ready: boolean;
  showInvitation: boolean;
  editInProgress: boolean;
  open: () => void;
  dialog: RefObject<HTMLDialogElement | null>;
  navigation: RefObject<HTMLButtonElement | null>;
}) {
  const [preference, setPreference] = useState<WorkspaceGuidePreference | null>();
  const [readFailed, setReadFailed] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [save, setSave] = useState<PreferenceSave | null>(null);
  const [index, setIndex] = useState(0);
  const review = useRef(0);
  const invitation = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const step = steps[index]!;
  const last = index === steps.length - 1;
  const canSkip = preference === null;
  const saving = save?.status === 'saving';
  const skipFailed = save?.status === 'failed' && save.value === 'skipped';
  const completeFailed = save?.status === 'failed' && save.value === 'completed';

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void fetch(preferenceUrl, { signal: controller.signal }).then(async response => {
      if (response.status === 401 || response.status === 403) return;
      if (!response.ok) throw new Error('Guide preference unavailable');
      const saved: { preference: WorkspaceGuidePreference | null } = await response.json();
      setPreference(current => current === undefined ? saved.preference : current);
      const active = document.activeElement;
      if (active?.hasAttribute('data-guide-read-retry')) {
        (dialog.current?.contains(active) ? next.current : navigation.current)?.focus({ preventScroll: true });
      }
      setReadFailed(false);
    }).catch(() => { if (!controller.signal.aborted) setReadFailed(true); });
    return () => controller.abort();
  }, [ready, readAttempt, dialog, navigation]);

  useLayoutEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!dialog.current?.open) return;
      // Canvas handlers also listen on window capture. Reserve keydown for the
      // dialog and let keyup reach the canvas to release held keys.
      event.stopImmediatePropagation();
      if (event.key !== 'Tab') return;
      if (event.shiftKey && event.target === close.current) {
        event.preventDefault();
        next.current?.focus();
      } else if (!event.shiftKey && event.target === next.current) {
        event.preventDefault();
        close.current?.focus();
      }
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, [dialog]);

  async function remember(value: WorkspaceGuidePreference) {
    if (saving) return;
    if (value === preference && value === 'completed') {
      dialog.current?.close();
      return;
    }
    const startedInDialog = dialog.current?.open;
    const startedReview = review.current;
    setSave({ value, status: 'saving' });
    try {
      const response = await fetch(preferenceUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference: value }),
        keepalive: true,
      });
      if (!response.ok) throw new Error('Guide preference not saved');
      setPreference(value);
      setSave(null);
      if (startedInDialog && review.current === startedReview) dialog.current?.close();
      if (invitation.current?.contains(document.activeElement)) navigation.current?.focus({ preventScroll: true });
    } catch {
      setSave({ value, status: 'failed' });
    }
  }

  const retryReading = <>
    <p className="workspace-guide-message" role="alert">暂时无法读取引导偏好。</p>
    <button type="button" data-guide-read-retry onMouseDown={event => event.preventDefault()} onClick={() => setReadAttempt(attempt => attempt + 1)}>重试读取</button>
  </>;

  return <>
    {showInvitation && (preference === null || (preference === undefined && readFailed)) &&
    <section ref={invitation} className="workspace-guide-invitation" data-workspace-guide aria-labelledby="workspace-guide-invitation-title">
      <h2 id="workspace-guide-invitation-title">画布引导</h2>
      {preference === undefined ? retryReading : <div>
        <button type="button" aria-disabled={saving} onMouseDown={event => event.preventDefault()} onClick={() => void remember('skipped')}>{skipFailed ? '重试跳过' : '跳过引导'}</button>
        <button type="button" className="workspace-guide-primary" aria-haspopup="dialog" aria-disabled={editInProgress || saving}
          title={editInProgress ? '结束当前操作后可查看引导' : undefined}
          onMouseDown={event => event.preventDefault()} onClick={() => { if (!saving) open(); }}>查看引导</button>
      </div>}
      {skipFailed && <p className="workspace-guide-message" role="alert">暂时无法保存跳过偏好。</p>}
    </section>}
    <dialog ref={dialog} className="workspace-guide-dialog" data-workspace-guide aria-labelledby="workspace-guide-title" onClose={() => {
      review.current += 1;
      setIndex(0);
    }}>
      <header>
        <h2 id="workspace-guide-title">画布引导</h2>
        <button ref={close} type="button" onClick={() => dialog.current?.close()}>关闭引导</button>
      </header>
      <section className="workspace-guide-step" aria-live="polite" aria-atomic="true">
        <p className="workspace-guide-progress">第 {index + 1} 步，共 {steps.length} 步</p>
        <h3>{step.title}</h3>
        {step.instructions}
      </section>
      <footer>
        {preference === undefined && readFailed && retryReading}
        {canSkip && skipFailed && <p className="workspace-guide-message" role="alert">暂时无法保存跳过偏好。</p>}
        {last && completeFailed && <p className="workspace-guide-message" role="alert">暂时无法保存完成偏好。</p>}
        {canSkip && <button type="button" className="workspace-guide-skip" aria-disabled={saving} onClick={() => void remember('skipped')}>{skipFailed ? '重试跳过' : '跳过引导'}</button>}
        {index > 0 && <button type="button" onClick={() => {
          if (index === 1) next.current?.focus();
          setIndex(index - 1);
        }}>上一步</button>}
        <button ref={next} type="button" className="workspace-guide-primary" aria-disabled={last && saving} onClick={() => {
          if (last) void remember('completed');
          else setIndex(index + 1);
        }}>{last ? completeFailed ? '重试完成' : '完成引导' : '下一步'}</button>
      </footer>
    </dialog>
  </>;
}
