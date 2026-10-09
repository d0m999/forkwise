import { createHash } from 'node:crypto';
import type { LayoutData } from '../contracts/layout.js';
import type { z } from 'zod';

/** Remove byte-identical copies of known restricted files from portable canvas assets. */
export function redactCanvasImages(data: z.infer<typeof LayoutData>, hashes: Set<string>) {
  const copy = structuredClone(data),
    files = copy.canvas?.annotations.files;
  if (!files || !hashes.size) return copy;
  const removed = new Set<string>();
  for (const [id, file] of Object.entries(files)) {
    const match =
      typeof file.dataURL === 'string' &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=]+)$/.exec(file.dataURL);
    if (
      match &&
      hashes.has(createHash('sha256').update(Buffer.from(match[1]!, 'base64')).digest('hex'))
    ) {
      delete files[id];
      removed.add(id);
    }
  }
  for (const element of copy.canvas?.annotations.elements ?? [])
    if (element.type === 'image' && removed.has(String(element.fileId))) element.status = 'error';
  return copy;
}
