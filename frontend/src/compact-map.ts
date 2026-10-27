import type { CanvasConnector } from '../../backend/src/mapping/connector-contracts';
import type { ConnectorIndex } from '../../backend/src/mapping/compact-contracts';
import type { CanvasImage, ImageVersion } from '../../backend/src/mapping/image-contracts';
import type { ImageIndex } from '../../backend/src/mapping/compact-contracts';
import type { CanvasText } from '../../backend/src/mapping/text-contracts';
import type { CanvasShape, ShapeVersion } from '../../backend/src/mapping/shape-contracts';
import type { CanvasStroke, StrokeVersion } from '../../backend/src/mapping/stroke-contracts';
import type { StrokeIndex } from '../../backend/src/mapping/compact-contracts';
import type { ShapeIndex } from '../../backend/src/mapping/compact-contracts';
import type { TextIndex } from '../../backend/src/mapping/compact-contracts';
import type { Card, ProjectState, Tag } from "../../backend/src/mapping/contracts";
import type {
  CardIndex,
  CompactPage,
  DetailChunk,
} from "../../backend/src/mapping/compact-contracts";
import type { ObservePage } from "../../backend/src/mapping/observe-contracts";

export type WorkspaceProjection = ProjectState & { snapshot: string };
type Reader = <T>(path: string) => Promise<T>;
const budget = 131_072;

// Reconstruct one immutable projection before exposing it to the editable UI.
// Failure/expiry aborts this read; it never continues with current-project data.
export async function readCompactMap(
  projectId: string,
  request: Reader,
  snapshot?: string,
): Promise<WorkspaceProjection> {
  const root = `/projects/${encodeURIComponent(projectId)}/map?`;
  async function collect<T>(parameters: Record<string, string>) {
    const get = (query: Record<string, string>) =>
      request<CompactPage<T>>(
        root + new URLSearchParams({ ...query, budget: String(budget) }),
      );
    let page = await get(parameters);
    const first = page;
    const items: T[] = [];
    const cursors = new Set<string>();
    for (;;) {
      if (
        page.project.id !== projectId ||
        page.snapshot !== first.snapshot ||
        page.revision !== first.revision ||
        page.totalItems !== first.totalItems ||
        page.availability !== "available" ||
        page.budgetUnit !== "utf8_bytes" ||
        page.bytes !== new TextEncoder().encode(JSON.stringify(page)).length ||
        page.bytes > budget ||
        page.coverage.start !== items.length ||
        page.coverage.end !== items.length + page.items.length ||
        page.coverage.end > page.totalItems ||
        page.coverage.complete !== (page.coverage.end === page.totalItems)
      )
        throw new Error("地图读取范围或版本不一致，请重新读取");
      items.push(...page.items);
      if (!page.nextCursor) {
        if (!page.coverage.complete)
          throw new Error("地图读取尚未完整，请重新读取");
        return { first, items };
      }
      if (!page.items.length || cursors.has(page.nextCursor))
        throw new Error("地图分页未推进，请重新读取");
      cursors.add(page.nextCursor);
      page = await get({
        ...parameters,
        snapshot: first.snapshot,
        cursor: page.nextCursor,
      });
    }
  }
  const index = await collect<CardIndex>({
    view: "index",
    ...(snapshot ? { snapshot } : {}),
  });
  const cards: Card[] = [];
  for (const item of [...index.items].sort((a, b) => a.order - b.order)) {
    const detail = await collect<DetailChunk>({
      view: "detail",
      cardId: item.id,
      snapshot: index.first.snapshot,
    });
    if (
      detail.first.revision !== index.first.revision ||
      detail.first.snapshot !== index.first.snapshot ||
      detail.items.some(
        (c, i) =>
          c.chunkIndex !== i ||
          c.chunkCount !== detail.items.length ||
          c.id !== item.body.id,
      )
    )
      throw new Error("正文分片与地图快照不一致，请重新读取");
    const body = JSON.parse(
      detail.items.map((c) => c.jsonText).join(""),
    ) as Card["body"];
    if (
      body.id !== item.body.id ||
      body.versionId !== item.body.versionId ||
      body.blocks.length !== item.body.blockCount
    )
      throw new Error("正文版本与地图身份不一致，请重新读取");
    cards.push({
      id: item.id,
      title: item.title,
      versionId: item.versionId,
      item: item.item,
      ...(item.cardTags ? { cardTags: item.cardTags } : {}),
      ...(item.appearance ? { appearance: item.appearance } : {}),
      body,
    });
  }
  const tags = await collect<Tag>({ view: "tags", snapshot: index.first.snapshot });
  if (tags.first.revision !== index.first.revision || tags.first.snapshot !== index.first.snapshot)
    throw new Error("标签与卡片快照不一致，请重新读取");
  const textPage = await collect<TextIndex>({ view: 'text-index', snapshot: index.first.snapshot });
  if (textPage.first.revision !== index.first.revision || textPage.first.snapshot !== index.first.snapshot)
    throw new Error('文字索引与卡片快照不一致，请重新读取');
  const texts: CanvasText[] = [];
  for (const item of textPage.items) {
    const detail = await collect<DetailChunk>({ view: 'text-detail', textId: item.id, snapshot: index.first.snapshot });
    if (detail.first.revision !== index.first.revision || detail.first.snapshot !== index.first.snapshot)
      throw new Error('文字详情与卡片快照不一致，请重新读取');
    if (detail.items.some((chunk, i) => chunk.id !== item.id || chunk.chunkIndex !== i || chunk.chunkCount !== detail.items.length)) throw new Error('文字分片与快照不一致');
    const value = JSON.parse(detail.items.map(chunk => chunk.jsonText).join(''));
    if (value.id !== item.id || value.versionId !== item.versionId || value.content.runs.length !== item.content.runCount) throw new Error('文字版本与快照不一致');
    texts.push({ ...value, kind: 'text', item: item.item });
  }
  const shapePage = await collect<ShapeIndex>({ view: 'shape-index', snapshot: index.first.snapshot });
  if (shapePage.first.revision !== index.first.revision || shapePage.first.snapshot !== index.first.snapshot)
    throw new Error('形状索引与卡片快照不一致，请重新读取');
  const shapes: CanvasShape[] = [];
  for (const item of [...shapePage.items].sort((a, b) => a.order - b.order)) {
    const detail = await collect<DetailChunk>({ view: 'shape-detail', shapeId: item.id, snapshot: index.first.snapshot });
    if (detail.first.revision !== index.first.revision || detail.first.snapshot !== index.first.snapshot)
      throw new Error('形状详情与卡片快照不一致，请重新读取');
    if (detail.items.some((chunk, i) => chunk.id !== item.id || chunk.chunkIndex !== i || chunk.chunkCount !== detail.items.length))
      throw new Error('形状分片与快照不一致，请重新读取');
    const value = JSON.parse(detail.items.map(chunk => chunk.jsonText).join('')) as ShapeVersion;
    if (value.id !== item.id || value.versionId !== item.versionId || value.content.shapeType !== item.content.shapeType)
      throw new Error('形状版本与快照不一致，请重新读取');
    shapes.push({ ...value, kind: 'shape', item: item.item });
  }
  const strokePage = await collect<StrokeIndex>({ view: 'stroke-index', snapshot: index.first.snapshot });
  if (strokePage.first.revision !== index.first.revision || strokePage.first.snapshot !== index.first.snapshot)
    throw new Error('笔迹索引与卡片快照不一致，请重新读取');
  const strokes: CanvasStroke[] = [];
  for (const item of [...strokePage.items].sort((a, b) => a.order - b.order)) {
    const detail = await collect<DetailChunk>({ view: 'stroke-detail', strokeId: item.id, snapshot: index.first.snapshot });
    const target = detail.first.target;
    if (detail.first.revision !== index.first.revision || detail.first.snapshot !== index.first.snapshot ||
      !target || !('strokeId' in target) || target.strokeId !== item.id || target.versionId !== item.versionId)
      throw new Error('笔迹详情与卡片快照不一致，请重新读取');
    if (detail.items.some((chunk, i) => chunk.id !== item.id || chunk.chunkIndex !== i || chunk.chunkCount !== detail.items.length))
      throw new Error('笔迹分片与快照不一致，请重新读取');
    const value = JSON.parse(detail.items.map(chunk => chunk.jsonText).join('')) as StrokeVersion;
    if (value.id !== item.id || value.versionId !== item.versionId || value.content.path.length !== item.content.pointCount ||
      value.content.penKind !== item.content.penKind || value.content.color !== item.content.color ||
      value.content.width !== item.content.width || value.content.opacity !== item.content.opacity ||
      value.content.path.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y)))
      throw new Error('笔迹内容版本与索引不一致，请重新读取');
    strokes.push({ ...value, kind: 'stroke', item: item.item });
  }
  const imagePage = await collect<ImageIndex>({ view: 'image-index', snapshot: index.first.snapshot });
  if (imagePage.first.revision !== index.first.revision || imagePage.first.snapshot !== index.first.snapshot)
    throw new Error('图片索引与地图快照不一致，请重新读取');
  const images: CanvasImage[] = [];
  for (const item of [...imagePage.items].sort((a, b) => a.order - b.order)) {
    const detail = await collect<DetailChunk>({ view: 'image-detail', imageId: item.id, snapshot: index.first.snapshot });
    const target = detail.first.target;
    if (detail.first.revision !== index.first.revision || detail.first.snapshot !== index.first.snapshot ||
      !target || !('imageId' in target) || target.imageId !== item.id || target.versionId !== item.versionId ||
      detail.items.some((chunk, i) => chunk.id !== item.id || chunk.chunkIndex !== i || chunk.chunkCount !== detail.items.length))
      throw new Error('图片详情与地图快照不一致，请重新读取');
    const value = JSON.parse(detail.items.map(chunk => chunk.jsonText).join('')) as ImageVersion;
    if (value.id !== item.id || value.versionId !== item.versionId || value.content.assetId !== item.content.assetId)
      throw new Error('图片版本与地图快照不一致，请重新读取');
    images.push({ ...value, kind: 'image', item: item.item });
  }
  const connectorPage = await collect<ConnectorIndex>({ view: 'connector-index', snapshot: index.first.snapshot });
  if (connectorPage.first.revision !== index.first.revision || connectorPage.first.snapshot !== index.first.snapshot)
    throw new Error('连线索引与地图快照不一致，请重新读取');
  const connectors: CanvasConnector[] = [];
  for (const item of [...connectorPage.items].sort((a, b) => a.order - b.order)) {
    const detail = await collect<DetailChunk>({ view: 'connector-detail', connectorId: item.id, snapshot: index.first.snapshot });
    const target = detail.first.target;
    if (detail.first.revision !== index.first.revision || detail.first.snapshot !== index.first.snapshot ||
      !target || !('connectorId' in target) || target.connectorId !== item.id || target.versionId !== item.versionId ||
      detail.items.some((chunk, i) => chunk.id !== item.id || chunk.chunkIndex !== i || chunk.chunkCount !== detail.items.length))
      throw new Error('连线详情与地图快照不一致，请重新读取');
    const value = JSON.parse(detail.items.map(chunk => chunk.jsonText).join('')) as CanvasConnector;
    if (value.id !== item.id || value.kind !== 'connector' || value.versionId !== item.versionId || value.path !== item.path ||
      JSON.stringify(value.start) !== JSON.stringify(item.start) || JSON.stringify(value.end) !== JSON.stringify(item.end))
      throw new Error('连线端点版本与地图快照不一致，请重新读取');
    const styleFields = ['startMarker', 'endMarker', 'color', 'width', 'dash'] as const;
    if (value.style === undefined ? item.style !== undefined : !item.style || styleFields.some(field => value.style![field] !== item.style![field]))
      throw new Error('连线外观与地图快照不一致，请重新读取');
    if (value.label == null) {
      if (value.label !== item.label) throw new Error('连线文字与地图快照不一致，请重新读取');
    } else {
      const label = value.label, summary = item.label;
      if (!summary || summary.availability !== 'not_fetched' || summary.position !== label.position ||
        summary.fontSize !== label.fontSize || summary.color !== label.color || summary.bold !== label.bold ||
        summary.textCodePoints !== Array.from(label.text).length)
        throw new Error('连线文字与地图快照不一致，请重新读取');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(label.text)));
      const checksum = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      if (checksum !== summary.textJsonSha256) throw new Error('连线文字与地图快照不一致，请重新读取');
    }
    connectors.push(value);
  }
  return {
    project: index.first.project,
    cards,
    tags: tags.items,
    texts,
    shapes,
    strokes,
    images,
    connectors,
    snapshot: index.first.snapshot,
  };
}

// Deltas invalidate a derived projection; only a complete pinned read publishes.
export async function syncCompactMap(
  previous: WorkspaceProjection,
  request: Reader,
): Promise<WorkspaceProjection> {
  const projectId = previous.project.id;
  let after = previous.project.revision;
  let snapshot: string | undefined;
  let target: number | undefined;
  try {
    for (;;) {
      const page = await request<ObservePage>(
        `/projects/${encodeURIComponent(projectId)}/changes?` +
          new URLSearchParams({
            after: String(after),
            budget: String(budget),
            limit: "100",
            ...(snapshot ? { snapshot } : { baseSnapshot: previous.snapshot }),
          }),
      );
      if (
        page.projectId !== projectId ||
        page.budgetUnit !== "utf8_bytes" ||
        page.bytes !== new TextEncoder().encode(JSON.stringify(page)).length ||
        page.bytes > budget
      )
        throw new Error("地图变化响应不一致，请重新读取");
      if (page.status === "RESET_REQUIRED")
        return readCompactMap(projectId, request, page.snapshot);
      if (
        page.status !== "OK" ||
        page.afterRevision !== after ||
        (target !== undefined &&
          (page.revision !== target || page.snapshot !== snapshot)) ||
        page.changes.some(
          (c, i) => c.projectId !== projectId || c.revision !== after + i + 1,
        ) ||
        page.nextRevision !== after + page.changes.length ||
        page.nextRevision > page.revision ||
        page.complete !== (page.nextRevision === page.revision)
      )
        throw new Error("地图变化修订断档，请重新读取");
      snapshot = page.snapshot;
      target = page.revision;
      if (page.complete) {
        if (
          target === previous.project.revision &&
          snapshot === previous.snapshot
        )
          return previous;
        return readCompactMap(projectId, request, snapshot);
      }
      if (page.nextRevision <= after)
        throw new Error("地图变化没有推进，请重新读取");
      after = page.nextRevision;
    }
  } catch (error) {
    const typed = error as {
      code?: string;
      details?: { recovery?: { snapshot?: string } };
    };
    if (
      [
        "SNAPSHOT_EXPIRED",
        "SNAPSHOT_UNAVAILABLE",
        "ITEM_EXCEEDS_BUDGET",
        "BUDGET_TOO_SMALL",
      ].includes(typed.code ?? "")
    )
      return readCompactMap(
        projectId,
        request,
        typed.details?.recovery?.snapshot,
      );
    throw error;
  }
}
