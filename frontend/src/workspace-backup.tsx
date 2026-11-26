import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { downloadBlob } from './download';
import './workspace-backup.css';

type BackupStatus = {
  version: string;
  backupBlockedReason: string | null;
  restoreBlockedReason: string | null;
};
type BackupPreview = { sourceVersion: string };
type RestoreResult = BackupPreview & { directory: string };
type BackupAction = 'download' | 'validate' | 'restore';
const endpoint = '/api/workspace/backup';
const progress: Record<BackupAction, string> = {
  download: '正在制作加密备份…',
  validate: '正在解密和校验备份…',
  restore: '正在重新校验并建立隔离恢复副本…',
};

async function backupRequest(path: string, options?: RequestInit) {
  const response = await fetch(endpoint + path, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(failure.message ?? '本机备份服务暂时不可用，请重试。');
  }
  return response;
}

type BackupDialogRef = RefObject<HTMLDialogElement | null>;

export function WorkspaceBackup({ dialog, disabled }: { dialog: BackupDialogRef; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-disabled={disabled} data-workspace-backup
      title={disabled ? '结束当前操作后可打开备份与恢复' : undefined}
      onMouseDown={event => event.preventDefault()} onClick={() => { if (!disabled) setOpen(true); }}>
      备份与恢复
    </button>
    {open && <BackupDialog dialog={dialog} close={() => {
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }} />}
  </>;
}

function BackupDialog({ dialog, close }: { dialog: BackupDialogRef; close: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const restoreButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const [status, setStatus] = useState<BackupStatus>();
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState<BackupAction>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [validated, setValidated] = useState<BackupPreview>();
  const [restored, setRestored] = useState<RestoreResult>();

  useLayoutEffect(() => {
    const element = dialog.current;
    const request = new AbortController();
    element?.showModal();
    closeButton.current?.focus();
    void backupRequest('', { signal: request.signal })
      .then(response => response.json() as Promise<BackupStatus>)
      .then(setStatus, failure => {
        if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : '无法读取备份设置。');
      });
    return () => { request.abort(); element?.close(); };
  }, [dialog]);

  useLayoutEffect(() => {
    if (error) alert.current?.focus();
    else if (restored) result.current?.focus();
    else if (validated) restoreButton.current?.focus();
  }, [error, restored, validated]);

  function requestClose() {
    if (busy) return;
    dialog.current?.close();
    close();
  }

  async function run(action: BackupAction) {
    if (busy || (action !== 'download' && !file) || (action === 'restore' && !validated)) return;
    setBusy(action);
    setError('');
    setMessage('');
    if (action === 'validate') {
      setValidated(undefined);
      setRestored(undefined);
    }
    try {
      if (action === 'download') {
        const response = await backupRequest('/download', { method: 'POST' });
        const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
          ?? 'forkwise-workspace.tar.age';
        downloadBlob(await response.blob(), filename);
        setMessage('加密备份已生成，下载已开始。');
      } else {
        const response = await backupRequest('/' + action, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file!,
        });
        if (action === 'validate') {
          setValidated(await response.json() as BackupPreview);
          setMessage('校验通过。可以建立隔离恢复副本。');
        } else {
          setRestored(await response.json() as RestoreResult);
          setMessage('已建立隔离恢复副本，可单独打开核对。');
        }
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '备份服务暂时不可用，请重试。');
    } finally {
      setBusy(undefined);
    }
  }

  return <dialog ref={dialog} className="workspace-backup" aria-labelledby="workspace-backup-title"
    onCancel={event => {
      event.preventDefault();
      requestClose();
    }}>
    <header>
      <h2 id="workspace-backup-title">备份与恢复</h2>
      <button ref={closeButton} type="button" aria-disabled={!!busy || undefined} onClick={requestClose}>关闭</button>
    </header>
    {status && <p className="workspace-backup-version">当前版本 {status.version}</p>}
    <div role="status">{busy ? progress[busy] : message}</div>
    {error && <p role="alert" ref={alert} tabIndex={-1}>{error}</p>}
    <section aria-labelledby="workspace-backup-download">
      <h3 id="workspace-backup-download">备份工作台</h3>
      <p>加密备份包含所有研究项目、原件和已保存的操作历史。单项目导出位于项目顶部，只包含当前研究。</p>
      {status?.backupBlockedReason && <p>{status.backupBlockedReason}</p>}
      <button type="button" disabled={!status || !!status.backupBlockedReason}
        aria-disabled={!!busy || undefined} onClick={() => void run('download')}>下载加密备份</button>
    </section>
    <section aria-labelledby="workspace-backup-restore">
      <h3 id="workspace-backup-restore">校验与隔离恢复</h3>
      <p>先选文件并校验，再决定是否在当前数据目录旁建立新的恢复副本。原工作台的数据保持原样。</p>
      {status?.restoreBlockedReason && <p>{status.restoreBlockedReason}</p>}
      <label>加密备份文件
        <input type="file" accept=".age" disabled={!status || !!status.restoreBlockedReason || !!busy}
          onChange={event => {
            setFile(event.target.files?.[0]);
            setValidated(undefined);
            setRestored(undefined);
            setMessage('');
            setError('');
          }} />
      </label>
      <div className="workspace-backup-actions">
        <button type="button" disabled={!status || !!status.restoreBlockedReason || !file}
          aria-disabled={!!busy || undefined} onClick={() => void run('validate')}>校验备份</button>
        <button ref={restoreButton} type="button" disabled={!validated || !!restored}
          aria-disabled={!!busy || undefined} onClick={() => void run('restore')}>建立隔离恢复副本</button>
      </div>
      {validated && <p>备份来源版本 {validated.sourceVersion}</p>}
      {restored && <div ref={result} className="workspace-backup-result" tabIndex={-1}>
        <p>在 <code>backend</code> 目录运行下面的命令可单独打开副本。若 8791 已被占用，请改用空闲端口。</p>
        <code>FORKWISE_DATA_DIR={'\'' + restored.directory.replaceAll("'", "'\\''") + '\''} FORKWISE_PORT=8791 npm run start:workspace</code>
        <p>打开新目录下 <code>local-access.json</code> 里的网址，核对项目和原件。</p>
      </div>}
    </section>
  </dialog>;
}
