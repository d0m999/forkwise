import type { Card, ProjectState } from "../../backend/src/mapping/contracts";
import type {
  CardIndex,
  CompactPage,
  DetailChunk,
} from "../../backend/src/mapping/compact-contracts";

export type WorkspaceProjection = ProjectState & { snapshot: string };
type Reader = <T>(path: string) => Promise<T>;
const budget = 131_072;

// Reconstruct one immutable projection before exposing it to the editable UI.
// Failure/expiry aborts this read; it never continues with current-project data.
export async function readCompactMap(
  projectId: string,
  request: Reader,
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
  const index = await collect<CardIndex>({ view: "index" });
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
      body,
    });
  }
  return {
    project: index.first.project,
    cards,
    snapshot: index.first.snapshot,
  };
}
