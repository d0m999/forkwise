import { useRef, useState, type ClipboardEvent } from 'react';
import { api, type Command } from './api';
import { mediaFiles } from './media-input';
import { canvasPasteAllowed } from './canvas-paste';
import { ImageInputRecovery, type ImageInput, type ImagePlacement } from './image-input-recovery';

export function useCanvasImageInput(context: () => ImagePlacement | null, commit: (command: Command) => Promise<boolean | undefined>, historyBlocked: () => boolean) {
  const task = useRef<ImageInput | null>(null), running = useRef(false);
  const reading = useRef(false), readTicket = useRef(0), readProject = useRef<string | null>(null);
  const [journal] = useState(() => new ImageInputRecovery());
  function readRecoveries() {
    const records = journal.list();
    return { records, error: journal.damaged ? '部分未确认图片记录无法识别，原件仍保留' : '' };
  }
  const [initial] = useState(() => { try { return readRecoveries(); } catch { return { records: [], error: '图片恢复区无法读取，原记录仍保留' }; } });
  const [recoveries, setRecoveries] = useState(initial.records), [recoveryError, setRecoveryError] = useState(initial.error);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  const [cancellable, setCancellable] = useState(true);
  function scan() {
    try { const result = readRecoveries(); setRecoveries(result.records); setRecoveryError(result.error); }
    catch { setRecoveryError('图片恢复区无法读取，原记录仍保留'); }
  }
  async function process() {
    const current = task.current;
    if (!current || running.current) return;
    running.current = true; setPending(true); setError(''); setCancellable(!current.image);
    try {
      journal.write(current);
      await api.execute(current.asset);
      if (task.current !== current) return;
      const asset = await api.asset(current.placement.projectId, current.asset.payload.id);
      if (task.current !== current) return;
      const p = current.placement;
      if (!current.image) {
        const factor = Math.min(1, p.maxWidth / asset.width, p.maxHeight / asset.height);
        const width = asset.width * factor, height = asset.height * factor;
        current.image = { commandId: crypto.randomUUID(), projectId: p.projectId, type: 'image.create', expected: null,
          payload: { id: crypto.randomUUID(), content: { assetId: asset.id, crop: { x: 0, y: 0, width: 1, height: 1 } },
            pose: { x: p.x - width / 2, y: p.y - height / 2, width, height, rotation: 0 } } };
      }
      setCancellable(false);
      journal.write(current);
      if (!(await commit(current.image))) throw new Error('图片结果尚未确认，请重试原请求');
      journal.confirm(current); task.current = null; setPending(false); scan();
    } catch (e) { if (task.current === current) setError(current.name + '：' + (e instanceof Error ? e.message : '图片保存失败')); }
    finally { running.current = false; if (!task.current) setPending(false); }
  }
  async function begin(file: File) {
    const placement = context();
    if (!placement || historyBlocked() || task.current || running.current || reading.current) return;
    reading.current = true; readProject.current = placement.projectId; const ticket = ++readTicket.current;
    setPending(true); setError(''); setCancellable(true);
    try {
      const block = (await mediaFiles([file]))[0]!;
      if (ticket !== readTicket.current) return;
      task.current = { name: file.name || '图片', placement,
        asset: { commandId: crypto.randomUUID(), projectId: placement.projectId, type: 'asset.save', expected: null,
          payload: { id: crypto.randomUUID(), name: String(block.name), mime: String(block.mime), base64: String(block.base64) } } };
      reading.current = false; await process();
    } catch (e) { setError(e instanceof Error ? e.message : '无法读取图片'); }
    finally { reading.current = false; if (!task.current && ticket !== readTicket.current) setPending(false); }
  }
  function paste(event: ClipboardEvent<HTMLElement>) {
    if (!canvasPasteAllowed(event)) return false;
    const files = Array.from(event.clipboardData.files);
    if (files.length !== 1 || !files[0]!.type.startsWith('image/')) return false;
    event.preventDefault(); void begin(files[0]!); return true;
  }
  async function recover(key: string) {
    if (historyBlocked() || task.current || running.current || reading.current) return;
    try {
      const record = journal.list().find(record => record.key === key);
      if (!record || context()?.projectId !== record.input.placement.projectId) return;
      task.current = journal.adopt(key); setCancellable(!task.current.image); setRecoveries(records => records.filter(record => record.key !== key));
      await process();
    } catch (e) { setError(e instanceof Error ? e.message : '无法恢复图片，原记录仍保留'); }
  }
  function cancel() {
    const current = task.current;
    if (current?.image) return;
    try {
      if (current) journal.confirm(current);
      readTicket.current++; readProject.current = null; task.current = null; setError(''); scan();
      if (!running.current && !reading.current) setPending(false);
    } catch (e) { setError(e instanceof Error ? e.message : '无法取消图片，原请求仍保留'); }
  }
  return { paste, begin, pending: pending || recoveries.length > 0, error, retry: process,
    recoveries, recoveryError, recover, cancel, active: pending, cancellable,
    hasPending: (projectId?: string) => projectId === undefined ? !!task.current || reading.current || running.current
      : task.current?.placement.projectId === projectId || (reading.current && readProject.current === projectId) };
}
