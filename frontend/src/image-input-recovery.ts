import { MappingCommand, type Command } from '../../backend/src/mapping/contracts';

export type ImagePlacement = { projectId: string; x: number; y: number; maxWidth: number; maxHeight: number };
export type ImageInput = { name: string; placement: ImagePlacement; asset: Extract<Command, { type: 'asset.save' }>; image?: Extract<Command, { type: 'image.create' }> };
const prefix = 'forkwise:canvas-image-input:v1:';
const knownKeys = (value: unknown, keys: string[]) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
function parse(raw: string): ImageInput | null {
  try {
    const record = JSON.parse(raw), input = record.input, p = input?.placement;
    if (!knownKeys(record, ['schema', 'input']) || !knownKeys(input, ['name', 'placement', 'asset', 'image']) ||
      !knownKeys(p, ['projectId', 'x', 'y', 'maxWidth', 'maxHeight']) || record.schema !== 1 || typeof input?.name !== 'string' || !p || typeof p.projectId !== 'string' ||
      !p.projectId || !['x', 'y', 'maxWidth', 'maxHeight'].every(key => typeof p[key] === 'number' && Number.isFinite(p[key])) ||
      p.maxWidth <= 0 || p.maxHeight <= 0) return null;
    const asset = MappingCommand.safeParse(input.asset), image = input.image === undefined ? null : MappingCommand.safeParse(input.image);
    if (!asset.success || asset.data.type !== 'asset.save' || asset.data.projectId !== p.projectId || asset.data.payload.name !== input.name) return null;
    if (image && (!image.success || image.data.type !== 'image.create' || image.data.projectId !== p.projectId || image.data.payload.content.assetId !== asset.data.payload.id)) return null;
    return { name: input.name, placement: { projectId: p.projectId, x: p.x, y: p.y, maxWidth: p.maxWidth, maxHeight: p.maxHeight },
      asset: asset.data, ...(image?.success && image.data.type === 'image.create' ? { image: image.data } : {}) };
  } catch { return null; }
}
function normalized(input: ImageInput) {
  const value = parse(JSON.stringify({ schema: 1, input }));
  if (!value) throw new Error('图片恢复请求无效，原记录仍保留');
  return value;
}
export class ImageInputRecovery {
  private key = prefix + crypto.randomUUID();
  damaged = false;
  constructor(private storage: Storage = localStorage) {}
  list(): { key: string; input: ImageInput }[] {
    const result = []; this.damaged = false;
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index)!;
      if (!key.startsWith(prefix)) continue;
      const raw = this.storage.getItem(key), input = raw === null ? null : parse(raw);
      if (input) result.push({ key, input }); else this.damaged = true;
    }
    return result;
  }
  write(input: ImageInput) {
    const value = normalized(input), raw = this.storage.getItem(this.key);
    if (raw !== null) {
      const existing = parse(raw);
      if (!existing || JSON.stringify(existing.asset) !== JSON.stringify(value.asset) ||
        JSON.stringify(existing.placement) !== JSON.stringify(value.placement) ||
        existing.image && JSON.stringify(existing.image) !== JSON.stringify(value.image))
        throw new Error('另一份未确认图片记录仍保留，请先恢复原请求');
    }
    this.storage.setItem(this.key, JSON.stringify({ schema: 1, input: value }));
  }
  adopt(key: string) {
    const raw = this.storage.getItem(key), input = raw === null ? null : parse(raw);
    if (!input) throw new Error('图片恢复记录无法读取，原件仍保留');
    this.write(input);
    if (key !== this.key) {
      if (this.storage.getItem(key) !== raw) throw new Error('图片恢复记录已变化，原件仍保留');
      this.storage.removeItem(key);
    }
    return input;
  }
  confirm(input: ImageInput) {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return;
    const existing = parse(raw);
    if (!existing || JSON.stringify(existing) !== JSON.stringify(normalized(input))) throw new Error('图片确认与原请求不一致，原记录仍保留');
    this.storage.removeItem(this.key);
  }
}
