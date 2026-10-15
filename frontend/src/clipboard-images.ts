import type { Block } from '../../backend/src/mapping/contracts';
import {
  PENDING_IMAGE_MAX_BYTES,
  validPendingImage,
} from '../../backend/src/mapping/pending-image';

export function embeddedImage(src: string, name: string): Block | null {
  if (!/^data:image\//i.test(src)) return null;
  const match = src.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new Error('无法可靠保留内嵌图片，原剪贴板与正文均保留');
  const base64 = match[2]!.replace(/\s/g, '');
  const block: Block = {
    id: crypto.randomUUID(),
    type: 'pendingImage',
    name: name || '内嵌图片',
    mime: match[1]!,
    base64,
    byteLength: (base64.length / 4) * 3 - (base64.match(/=+$/)?.[0].length ?? 0),
    status: 'unsupported',
  };
  if (!validPendingImage(block))
    throw new Error('内嵌图片超过上限或字节无效，原剪贴板与正文均保留');
  return block;
}

export async function clipboardImages(files: File[]): Promise<Block[]> {
  if (files.reduce((total, file) => total + file.size, 0) > PENDING_IMAGE_MAX_BYTES)
    throw new Error('图片字节超过本次暂存的 512 KiB 上限，原剪贴板与正文均保留');
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let raw = '';
      for (let i = 0; i < bytes.length; i += 8192)
        raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const block: Block = {
        id: crypto.randomUUID(),
        type: 'pendingImage',
        name: file.name || '剪贴板图片',
        mime: file.type,
        byteLength: bytes.length,
        base64: btoa(raw),
        status: 'unsupported',
      };
      if (!validPendingImage(block)) throw new Error('图片字节无法可靠保留，原剪贴板与正文均保留');
      return block;
    }),
  );
}
