import { bytesToBase64 } from './base64';

export const FILE_CARD_WIDTH = 280;
export const FILE_CARD_GAP = 40;
export const FILE_CARD_HEIGHT = 160;

export function attachmentCardTitle(name: string) {
  const stripped = name.replace(/\.[^.]+$/, '');
  return stripped || name || '未命名文件';
}

export type DroppedDocument = { file: File; title: string; x: number; y: number };

export function droppedFilePlan(files: File[], origin: { x: number; y: number }): { images: File[]; documents: DroppedDocument[] } {
  const images: File[] = [];
  const documents: DroppedDocument[] = [];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      images.push(file);
      continue;
    }
    const index = documents.length;
    documents.push({
      file,
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
  return { name, mime: (file.type || 'application/octet-stream').toLowerCase(), base64: bytesToBase64(bytes) };
}

export type DropHost = {
  claimDraft: () => Promise<boolean>;
  saveFile: (file: File) => Promise<{ assetId: string; name: string }>;
  createCard: (input: { title: string; x: number; y: number }) => Promise<{ cardId: string; revision: number }>;
  attach: (input: { cardId: string; assetId: string; name: string }) => Promise<void>;
  retractCard: (cardId: string, revision: number) => Promise<void>;
  importImage: (file: File) => Promise<void>;
};

// 每个文件是独立动作：单个失败不拦其余文件，已成功的不回滚；只有“建卡成功、挂附件失败”撤回那张新卡。
export async function runDroppedFiles(plan: { images: File[]; documents: DroppedDocument[] }, host: DropHost): Promise<string[]> {
  const failures: string[] = [];
  if (!(await host.claimDraft())) return ['草稿未保存，拖入已取消'];
  const reason = (error: unknown) => (error instanceof Error ? error.message : '未能保存');
  for (const item of plan.documents) {
    const label = item.file.name || '未命名文件';
    try {
      const saved = await host.saveFile(item.file);
      const card = await host.createCard({ title: item.title, x: item.x, y: item.y });
      try {
        await host.attach({ cardId: card.cardId, assetId: saved.assetId, name: saved.name });
      } catch (error) {
        try {
          await host.retractCard(card.cardId, card.revision);
        } catch {
          failures.push(`${label}：附件没有挂上，新建卡片也未能撤回`);
          continue;
        }
        throw error;
      }
    } catch (error) {
      failures.push(`${label}：${reason(error)}`);
    }
  }
  for (const file of plan.images) {
    try {
      await host.importImage(file);
    } catch (error) {
      failures.push(`${file.name || '图片'}：${reason(error)}`);
    }
  }
  return failures;
}
