import { useEffect, useRef, useState } from 'react';
import { api, type Project } from './api';
import { downloadBlob, exportFilename } from './download';

type ExportKind = 'markdown' | 'image' | 'package';

const EXPORT_STEPS: Record<ExportKind, {
  label: string;
  busy: string;
  done: string;
  failed: string;
  extension: 'md' | 'png' | 'zip';
  load: (project: Project, image: () => Promise<Blob>) => Promise<Blob>;
}> = {
  markdown: {
    label: '下载可读摘要（Markdown）',
    busy: '正在生成可读摘要…',
    done: '可读摘要下载已开始',
    failed: '摘要生成失败，请重试；项目未修改',
    extension: 'md',
    load: (project) => api.readableSummary(project.id, project.revision),
  },
  image: {
    label: '下载画布图像（PNG）',
    busy: '正在生成画布图像…',
    done: '画布图像下载已开始',
    failed: '画布图像生成失败，请重试；项目未修改',
    extension: 'png',
    load: (_project, image) => image(),
  },
  package: {
    label: '下载完整项目包（ZIP）',
    busy: '正在生成完整项目包…',
    done: '完整项目包下载已开始',
    failed: '完整项目包生成失败，请重试；项目未修改',
    extension: 'zip',
    load: (project) => api.fullPackage(project.id, project.revision),
  },
};

export function ExportMenu({ project, disabled, report, image }: {
  project: Project;
  disabled: boolean;
  report: (message: string) => void;
  image: () => Promise<Blob>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) first.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeAndFocus();
    };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  function closeAndFocus() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }
  async function run(kind: ExportKind) {
    if (disabled || busy) return;
    const step = EXPORT_STEPS[kind];
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setBusy(kind);
    report(step.busy);
    try {
      const blob = await step.load(project, image);
      downloadBlob(blob, exportFilename(project.name, project.revision, step.extension));
      report(step.done);
    } catch (error) {
      report(error instanceof Error ? error.message : step.failed);
    } finally {
      setBusy(null);
      requestAnimationFrame(() => {
        if ((document.activeElement === document.body || document.activeElement === document.documentElement) && returnFocus?.isConnected)
          returnFocus.focus({ preventScroll: true });
      });
    }
  }

  return <div className="export-menu" ref={root} onKeyDown={event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1 + items.length) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }}>
    <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => {
      report('');
      setOpen(value => !value);
    }}>导出</button>
    {open && <div className="export-popover" role="menu" aria-label="导出当前项目">
      <p>只导出当前已保存状态；未保存草稿不包含在内。</p>
      <p>摘要是可读文本，不含完整恢复数据或原件；图像呈现画布，不含完整正文，也不是备份。</p>
      <p>完整项目包包含已保存的数据和资源文件，可离开本机读取；它不是加密备份，也不能在这里导入。</p>
      {disabled && <p role="note">当前有未保存内容，请先完成保存；导出只读取已保存状态。</p>}
      <button ref={first} type="button" role="menuitem" disabled={disabled || !!busy} onClick={() => void run('markdown')}>
        {busy === 'markdown' ? EXPORT_STEPS.markdown.busy : EXPORT_STEPS.markdown.label}
      </button>
      <button type="button" role="menuitem" disabled={disabled || !!busy} onClick={() => void run('image')}>
        {busy === 'image' ? EXPORT_STEPS.image.busy : EXPORT_STEPS.image.label}
      </button>
      <button type="button" role="menuitem" disabled={disabled || !!busy} onClick={() => void run('package')}>
        {busy === 'package' ? EXPORT_STEPS.package.busy : EXPORT_STEPS.package.label}
      </button>
    </div>}
  </div>;
}
