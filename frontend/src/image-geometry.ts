import { useEffect, useRef, useState } from 'react';
import type { CanvasImage } from '../../backend/src/mapping/image-contracts';
import type { Command, ProjectState } from './api';
export type ImagePose = CanvasImage['item']['pose'];
// Only the execute boundary may classify a write as rejected. A failed read
// after an acknowledged write still requires confirmation of that request.
export class ImageWriteRejected extends Error {}
export function useImageGeometry(authority: () => ProjectState | null, commit: (command: Command, done?: () => void) => Promise<boolean | undefined>, readSaved: (projectId: string) => Promise<unknown>, historyBlocked: () => boolean) {
  const gesture = useRef<{ projectId: string; value: CanvasImage } | null>(null);
  const request = useRef<Command | null>(null), running = useRef(false);
  const [poses, setPoses] = useState<Record<string, ImagePose>>({});
  const [dragging, setDragging] = useState(false), [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const rejectedRequest = useRef<Command | null>(null), [rejected, setRejected] = useState(false);
  function clear(command: Command) {
    if (request.current !== command) return;
    request.current = null; rejectedRequest.current = null;
    setRejected(false); setPoses({}); setPending(false); setError('');
  }
  async function retry() {
    const command = request.current;
    if (!command || running.current || rejectedRequest.current) return;
    running.current = true; setError('');
    const confirmed = () => {
      if (request.current !== command) return;
      clear(command);
    };
    try {
      if (await commit(command, confirmed)) confirmed();
      else if (request.current === command) setError('图片调整尚未确认，请先完成其他保存后重试原请求');
    } catch (failure) {
      if (request.current === command) {
        if (failure instanceof ImageWriteRejected) { rejectedRequest.current = command; setRejected(true); }
        setError(failure instanceof Error ? failure.message : '图片调整尚未确认，原请求仍保留');
      }
    }
    finally { running.current = false; }
  }
  async function abandon() {
    const command = rejectedRequest.current;
    if (!command || request.current !== command || running.current) return;
    running.current = true;
    try { await readSaved(command.projectId); clear(command); }
    catch { setError('无法读取图片已保存状态，本次调整仍保留，请重新读取'); }
    finally { running.current = false; }
  }
  function send(command: Command) { request.current = command; setPending(true); void retry(); }
  function cancel() { gesture.current = null; setDragging(false); if (!request.current) setPoses({}); }
  useEffect(() => { cancel(); }, [authority()?.project.id]);
  function start(value: CanvasImage) {
    const current = authority();
    if (!current || historyBlocked() || gesture.current || request.current) return false;
    gesture.current = { projectId: current.project.id, value: structuredClone(value) };
    setDragging(true); return true;
  }
  function preview(pose: ImagePose) {
    if (gesture.current) setPoses({ [gesture.current.value.item.id]: pose });
  }
  function finish(pose: ImagePose) {
    const captured = gesture.current; gesture.current = null; setDragging(false);
    if (!captured) return;
    const { value, projectId } = captured;
    if (JSON.stringify(pose) === JSON.stringify(value.item.pose)) { setPoses({}); return; }
    const { rotation: _rotation, ...layout } = pose;
    setPoses({ [value.item.id]: pose });
    send({ commandId: crypto.randomUUID(), projectId, type: 'image.transform',
      expected: { image: value.versionId, pose: value.item.versionId }, payload: { id: value.id, pose: layout } });
  }
  function adjust(value: CanvasImage, next: ImagePose | null) { if (next && start(value)) finish(next); }
  function operate(value: CanvasImage, direction: 'left' | 'right' | 'delete') {
    const current = authority();
    if (!current || historyBlocked() || gesture.current || request.current) return;
    const command: Command = { commandId: crypto.randomUUID(), projectId: current.project.id,
      expected: { image: value.versionId, pose: value.item.versionId },
      ...(direction === 'delete' ? { type: 'image.delete', payload: { id: value.id } } : { type: 'image.rotate', payload: { id: value.id, direction } }) };
    send(command);
  }
  return { poses, dragging, pending, start, preview, finish, adjust, cancel, operate, error, retry, rejected, abandon,
    hasPending: (projectId?: string) => projectId === undefined ? !!request.current || !!gesture.current
      : request.current?.projectId === projectId || gesture.current?.projectId === projectId };
}
export type ImageGeometry = ReturnType<typeof useImageGeometry>;
