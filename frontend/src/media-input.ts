import type { Block } from '../../backend/src/mapping/contracts';
import { PENDING_IMAGE_MAX_BYTES } from '../../backend/src/mapping/pending-image';
export function mediaTask(block: Block): Block {
  if (block.type !== 'pendingImage') return block;
  const { status, ...payload } = block;
  return {
    ...payload,
    type: 'imageTask',
    ticket: crypto.randomUUID(),
    width: 320,
    height: 180,
    status: 'queued',
  };
}
export async function mediaFiles(files: File[]): Promise<Block[]> {
  if (files.reduce((n, f) => n + f.size, 0) > PENDING_IMAGE_MAX_BYTES)
    throw new Error(
      `${files.map((f) => f.name).join('、')}：本次图片合计不得超过512 KiB；原内容保留`,
    );
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!bytes.length) throw new Error(`${file.name}：文件为空，原内容保留`);
      let raw = '';
      for (let at = 0; at < bytes.length; at += 8192)
        raw += String.fromCharCode(...bytes.subarray(at, at + 8192));
      return {
        id: crypto.randomUUID(),
        type: 'imageTask',
        ticket: crypto.randomUUID(),
        name: file.name || '图片',
        mime: file.type || 'application/octet-stream',
        base64: btoa(raw),
        byteLength: bytes.length,
        width: 320,
        height: 180,
        status: 'queued',
      };
    }),
  );
}
