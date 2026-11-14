export const FILE_CARD_WIDTH = 280;
export const FILE_CARD_GAP = 40;
export const FILE_CARD_HEIGHT = 160;

export function attachmentCardTitle(name: string) {
  const stripped = name.replace(/\.[^.]+$/, '');
  return stripped || name || '未命名文件';
}

export function droppedFilePlan(files: { name: string; type: string }[], origin: { x: number; y: number }) {
  const images: { name: string; type: string }[] = [];
  const documents: { name: string; type: string; title: string; x: number; y: number }[] = [];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      images.push(file);
      continue;
    }
    const index = documents.length;
    documents.push({
      name: file.name,
      type: file.type,
      title: attachmentCardTitle(file.name),
      x: origin.x + (index % 3) * (FILE_CARD_WIDTH + FILE_CARD_GAP),
      y: origin.y + Math.floor(index / 3) * (FILE_CARD_HEIGHT + FILE_CARD_GAP),
    });
  }
  return { images, documents };
}

export async function fileAssetPayload(file: File) {
  const name = file.name || '未命名文件';
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!bytes.byteLength) throw new Error(`${name}：文件为空`);
  let raw = '';
  for (let at = 0; at < bytes.length; at += 8192) raw += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return { name, mime: (file.type || 'application/octet-stream').toLowerCase(), base64: btoa(raw) };
}
