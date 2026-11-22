import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { downloadBlob } from './download';
import './workspace-backup.css';

type BackupStatus = {
  version: string;
  backupBlockedReason: string | null;
  restoreBlockedReason: string | null;
};
type RestoreResult = { directory: string; sourceVersion: string };
const endpoint = '/api/workspace/backup';

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
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-disabled={disabled}
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
  const [status, setStatus] = useState<BackupStatus>();
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState<'backup' | 'restore'>();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
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

  function requestClose() {
    if (busy) return;
    dialog.current?.close();
    close();
  }

  async function run(action: 'backup' | 'restore') {
    if (busy || (action === 'restore' && !file)) return;
    setBusy(action);
    setError('');
    setMessage('');
    setRestored(undefined);
    try {
      if (action === 'backup') {
        const response = await backupRequest('/download', { method: 'POST' });
        const filename = response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]
          ?? 'forkwise-workspace.tar.age';
        downloadBlob(await response.blob(), filename);
        setMessage('加密备份已生成，下载已开始。');
      } else {
        const response = await backupRequest('/restore', {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file!,
        });
        setRestored(await response.json() as RestoreResult);
        setMessage('校验通过，已创建隔离副本。');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '备份服务暂时不可用，请重试。');
    } finally {
      setBusy(undefined);
      if (!dialog.current?.contains(document.activeElement)) closeButton.current?.focus();
    }
  }

  return <dialog ref={dialog} className="workspace-backup" aria-labelledby="workspace-backup-title"
    onCancel={event => {
      event.preventDefault();
      requestClose();
    }}>
    <header>
      <h2 id="workspace-backup-title">备份与恢复</h2>
      <button ref={closeButton} type="button" aria-disabled={!!busy} onClick={requestClose}>关闭</button>
    </header>
    {status && <p className="workspace-backup-version">当前版本 {status.version}</p>}
    <section aria-labelledby="workspace-backup-download">
      <h3 id="workspace-backup-download">备份工作台</h3>
      <p>备份所有研究项目、原件和已保存的操作历史。启动凭据和会话会从副本中移除。</p>
      {status?.backupBlockedReason && <p>{status.backupBlockedReason}</p>}
      <button type="button" disabled={!status || !!status.backupBlockedReason || !!busy}
        onClick={() => void run('backup')}>下载加密备份</button>
    </section>
    <section aria-labelledby="workspace-backup-restore">
      <h3 id="workspace-backup-restore">恢复到新目录</h3>
      <p>选中备份后，见岔会先解密并校验，再将副本放到当前数据目录旁。</p>
      {status?.restoreBlockedReason && <p>{status.restoreBlockedReason}</p>}
      <label>加密备份文件
        <input type="file" accept=".age" disabled={!status || !!status.restoreBlockedReason || !!busy}
          onChange={event => { setFile(event.target.files?.[0]); setRestored(undefined); setMessage(''); setError(''); }} />
      </label>
      <button type="button" disabled={!status || !!status.restoreBlockedReason || !file || !!busy}
        onClick={() => void run('restore')}>校验并恢复副本</button>
      {restored && <div className="workspace-backup-result">
        <p>备份来源版本 {restored.sourceVersion}</p>
        <p>在 <code>backend</code> 目录运行下面的命令可单独打开副本。若 8791 已被占用，请改用空闲端口。</p>
        <code>FORKWISE_DATA_DIR={'\'' + restored.directory.replaceAll("'", "'\\''") + '\''} FORKWISE_PORT=8791 npm run start:workspace</code>
        <p>再打开新目录下 <code>local-access.json</code> 里的网址。</p>
      </div>}
    </section>
    <div role="status">{busy === 'backup' ? '正在制作加密备份…' : busy === 'restore' ? '正在校验备份并创建副本…' : message}</div>
    {error && <p role="alert">{error}</p>}
  </dialog>;
}
