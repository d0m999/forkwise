import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api, MappingError } from './api';
import type { ImportPreview } from '../../backend/src/mapping/package-import';
import type { PackageFailure } from '../../backend/src/mapping/package-verify';

function failureLines(error: MappingError): string[] {
  const details = error.details as { failures?: PackageFailure[] } | undefined;
  if (!details?.failures?.length) return [];
  return details.failures.map((failure) => `${failure.code} ${failure.path} expected=${failure.expected} actual=${failure.actual}`);
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      if (comma < 0) reject(new Error('无法读取所选文件'));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('无法读取所选文件'));
    reader.readAsDataURL(file);
  });
}

async function fingerprint(base64: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base64));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// 画布快捷键据此判断导入对话框是否打开；类名由本模块独占。
export function importDialogOpen() {
  return !!document.querySelector('.import-dialog');
}

// 只校验的预览是只读的，随时可以退出；已提交的请求不能再被 Esc 打断。
type Phase = 'idle' | 'verifying' | 'submitting';
type Attempt = { commandId: string; projectId: string; name: string };

export function ImportPackage({ disabled, onImported }: {
  disabled: boolean;
  onImported: (projectId: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);
  const failureRef = useRef<HTMLElement>(null);
  // 未确认的导入请求按包保留：换个文件看看不会丢掉上一次待重试的 commandId。
  const attempts = useRef(new Map<string, Attempt>());
  // 迟到的预览结果属于已经关闭或已被替换的那一次选择，直接丢弃。
  const selection = useRef(0);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<{ fileName: string; base64: string; key: string; preview: ImportPreview } | null>(null);
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [failures, setFailures] = useState<string[]>([]);
  const verifying = phase === 'verifying';
  const submitting = phase === 'submitting';

  useEffect(() => {
    if (failures.length) failureRef.current?.focus({ preventScroll: true });
  }, [failures]);

  useEffect(() => {
    if (!open) return;
    if (source) nameInput.current?.focus({ preventScroll: true });
    else if (verifying) dialogRef.current?.focus({ preventScroll: true });
    else closeButton.current?.focus({ preventScroll: true });
  }, [open, source, verifying]);

  function close() {
    if (submitting) return;
    selection.current += 1;
    setOpen(false);
    setSource(null);
    setName('');
    setMessage('');
    setFailures([]);
    setPhase('idle');
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  }

  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open, submitting]);

  function trapTab(event: ReactKeyboardEvent<HTMLFormElement>) {
    if (event.key !== 'Tab') return;
    const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.offsetParent !== null);
    if (!nodes.length) {
      event.preventDefault();
      dialogRef.current?.focus({ preventScroll: true });
      return;
    }
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    }
  }

  async function choose(file: File) {
    const ticket = ++selection.current;
    setOpen(true);
    setPhase('verifying');
    setSource(null);
    setMessage('正在校验完整项目包…');
    setFailures([]);
    try {
      const base64 = await readBase64(file);
      if (ticket !== selection.current) return;
      const key = await fingerprint(base64);
      if (ticket !== selection.current) return;
      const preview = await api.previewImport(base64);
      if (ticket !== selection.current) return;
      setSource({ fileName: file.name, base64, key, preview });
      setName(preview.suggestedName);
      setMessage('');
    } catch (error) {
      if (ticket !== selection.current) return;
      setMessage(error instanceof Error ? error.message : '所选文件无法读取');
    } finally {
      if (ticket === selection.current) setPhase('idle');
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!source || submitting || disabled || !name.trim() || source.preview.failures.length) return;
    const trimmed = name.trim();
    const previous = attempts.current.get(source.key);
    const sameRequest = previous?.name === trimmed;
    const commandId = sameRequest ? previous!.commandId : crypto.randomUUID();
    const projectId = previous ? previous.projectId : crypto.randomUUID();
    attempts.current.set(source.key, { commandId, projectId, name: trimmed });
    setPhase('submitting');
    setMessage('');
    setFailures([]);
    try {
      await api.execute({
        commandId,
        projectId,
        type: 'project.import',
        expected: null,
        payload: { name: trimmed, base64: source.base64 },
      });
      attempts.current.delete(source.key);
      setOpen(false);
      setSource(null);
      setPhase('idle');
      requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
      onImported(projectId);
    } catch (error) {
      if (error instanceof MappingError && error.code === 'ID_CONFLICT') {
        // 上一次响应丢失后已提交，或用户改名后重提；项目编号已经存在时直接打开它，不再建第二个。
        attempts.current.delete(source.key);
        setOpen(false);
        setSource(null);
        setPhase('idle');
        onImported(projectId);
        return;
      }
      if (error instanceof MappingError && (error.status ?? 0) < 500) {
        attempts.current.delete(source.key);
        setMessage(error.message);
        setFailures(failureLines(error));
      } else if (error instanceof MappingError) {
        setMessage('服务端暂时未确认结果，原请求已保留；重试会复用同一命令编号，已提交时只返回原回执。');
        setFailures(failureLines(error));
      } else {
        setMessage('响应未收到，原请求已保留；重试会使用同一命令编号，不会重复建项目。');
      }
    } finally {
      setPhase('idle');
    }
  }

  const counts = source?.preview.counts;
  return (
    <span className="import-package">
      <input
        ref={picker}
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void choose(file);
        }}
      />
      <button ref={trigger} type="button" disabled={disabled} onClick={() => {
        setOpen(true);
        setSource(null);
        setMessage('');
        setFailures([]);
        setPhase('idle');
        picker.current?.click();
      }}>
        导入项目包
      </button>
      {open && (
        <div className="dialog-shade">
          <form ref={dialogRef} className="import-dialog" role="dialog" aria-modal="true" aria-label="导入项目包" tabIndex={-1} onSubmit={(event) => void submit(event)} onKeyDown={trapTab}>
            <h2>导入项目包</h2>
            {!source && (
              <>
                <p role="status" className="import-note">{message || '请选择一份完整项目包（ZIP）。'}</p>
                {verifying && <p className="import-hint">这一步只读文件；可以随时关闭，校验结果不会写入库。</p>}
                <div className="import-actions">
                  <button ref={closeButton} type="button" onClick={close}>关闭</button>
                </div>
              </>
            )}
            {source && (
              <>
                <p className="import-note">
                  来自《{source.preview.suggestedName}》的完整项目包（{source.fileName}），源项目修订 r{source.preview.sourceRevision}。
                  这次导入不会修改源项目。
                </p>
                <label htmlFor="import-name">新研究名称</label>
                <input
                  ref={nameInput}
                  id="import-name"
                  maxLength={240}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing && event.key === 'Enter') event.preventDefault();
                  }}
                />
                <p className="import-hint">将新建一份独立研究，不覆盖当前画布；名称可以与现有项目相同。</p>

                <section className="import-block" aria-label="导入范围">
                  <h3>范围</h3>
                  <dl className="import-scope">
                    {counts && <>
                      <div><dt>卡片</dt><dd>{counts.cards}</dd></div>
                      <div><dt>独立文字</dt><dd>{counts.texts}</dd></div>
                      <div><dt>形状</dt><dd>{counts.shapes}</dd></div>
                      <div><dt>笔迹</dt><dd>{counts.strokes}</dd></div>
                      <div><dt>图片</dt><dd>{counts.images}</dd></div>
                      <div><dt>普通连线</dt><dd>{counts.connectors}</dd></div>
                      <div><dt>分区</dt><dd>{counts.frames}</dd></div>
                      <div><dt>组合</dt><dd>{counts.groups}</dd></div>
                      <div><dt>归属</dt><dd>{counts.containment}</dd></div>
                      <div><dt>附着</dt><dd>{counts.attachments}</dd></div>
                      <div><dt>标签</dt><dd>{counts.tags}</dd></div>
                      <div><dt>资源</dt><dd>{source.preview.resources} 份</dd></div>
                      <div><dt>版本</dt><dd>{source.preview.versions} 条</dd></div>
                    </>}
                  </dl>
                  <p className="import-hint">
                    {source.preview.failures.length === 0
                      ? `叠放与归属已按包内原文重算通过；旧研究归档${source.preview.hasResearch ? '随包导入，按原结构保留' : '见下方缺口'}。`
                      : '校验未通过，以下问题不会写入库；提交按钮不可用。'}
                  </p>
                </section>

                <section className="import-block" aria-label="导入缺口">
                  <h3>缺口</h3>
                  {source.preview.gaps.length
                    ? <ul>{source.preview.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>
                    : <p className="import-hint">没有需要说明的缺口。</p>}
                </section>

                <section className="import-block" aria-label="身份映射">
                  <h3>身份</h3>
                  <p className="import-hint">
                    将使用新的项目编号；卡片、文字、形状、笔迹、图片、连线、分区、组合和标签换成新编号。
                    资源编号、正文块、摆放和版本编号保持。撤销和重做不会从包里恢复；新项目的可执行历史从空栈开始，导入这一步本身不可撤销。
                  </p>
                </section>

                {(message || failures.length > 0) && (
                  <section ref={failureRef} tabIndex={-1} className="import-block import-failed" role="alert">
                    <h3>未能导入</h3>
                    {message && <p>{message}</p>}
                    {failures.length > 0 && <ul className="import-failures">{failures.map((line) => <li key={line}>{line}</li>)}</ul>}
                  </section>
                )}

                {source.preview.failures.length > 0 && (
                  <section className="import-block import-failed" role="alert">
                    <h3>校验未通过</h3>
                    <p>修正包内容后重新选择文件；以下问题不会写入库。</p>
                    <ul className="import-failures">
                      {source.preview.failures.map((failure, index) => (
                        <li key={`${failure.code}-${failure.path}-${index}`}>
                          {failure.code} {failure.path} expected={failure.expected} actual={failure.actual}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <div className="import-actions">
                  <button type="button" disabled={submitting} onClick={close}>取消</button>
                  <button
                    type="submit"
                    disabled={submitting || disabled || !name.trim() || source.preview.failures.length > 0}
                  >
                    {submitting ? '正在导入…' : '导入为新研究'}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </span>
  );
}
