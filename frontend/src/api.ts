import type { SearchQuery, SearchResult, SearchStateView } from '../../backend/src/mapping/search-contracts';
import type { MediaAsset, ImageAsset } from '../../backend/src/mapping/media';
import type { CutStateView } from '../../backend/src/mapping/cut-contracts';
import type { CanvasShape } from '../../backend/src/mapping/shape-contracts';
import type {
  CardIdentity,
  Command,
  Project,
  Receipt,
  ProjectHistory,
} from "../../backend/src/mapping/contracts";
import {
  readCompactMap,
  syncCompactMap,
  type WorkspaceProjection,
} from "./compact-map";
import { TRANSPORT_FALLBACK_CODE } from '../../backend/src/mapping/recovery-contract';
export type ProjectState = WorkspaceProjection;
export type {
  Card,
  Command,
  Project,
} from "../../backend/src/mapping/contracts";
export class MappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly status?: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, body?: unknown, keepalive = false): Promise<T> {
  const response = await fetch("/api/mapping" + path, {
    credentials: "same-origin",
    keepalive,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok)
    throw new MappingError(
      result.code ?? TRANSPORT_FALLBACK_CODE,
      result.message ?? "本机服务暂时不可用",
      result.details,
      response.status,
    );
  return result as T;
}
const MISSING_IMAGE_SIZE = '图片原件缺少尺寸';
export function missingImageSizeMessage(error: unknown): string | null {
  return error instanceof Error && error.message === MISSING_IMAGE_SIZE ? error.message : null;
}
function readMediaAsset(projectId: string, id: string) {
  return request<MediaAsset>(`/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(id)}`);
}
export const api = {
  searchState: (projectId: string) => request<SearchStateView>(`/projects/${encodeURIComponent(projectId)}/search-state`),
  search: (projectId: string, query: Omit<SearchQuery, "type" | "projectId">) =>
    request<SearchResult>(`/projects/${encodeURIComponent(projectId)}/search`, query),
  asset: readMediaAsset,
  // 图片消费方只走这里：尺寸在读取边界判一次，调用方拿到的是有尺寸的原件视图。
  imageAsset: async (projectId: string, id: string): Promise<ImageAsset> => {
    const asset = await readMediaAsset(projectId, id);
    if (asset.width === undefined || asset.height === undefined) throw new Error(MISSING_IMAGE_SIZE);
    return { ...asset, width: asset.width, height: asset.height };
  },
  cardIdentity: (projectId: string, cardId: string) =>
    request<CardIdentity>(
      `/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/identity`,
    ),
  history: (id: string) =>
    request<ProjectHistory>("/projects/" + encodeURIComponent(id) + "/history"),
  cutState: (projectId: string, cutId: string) =>
    request<CutStateView>(`/projects/${encodeURIComponent(projectId)}/cuts/${encodeURIComponent(cutId)}`),
  projects: () => request<Project[]>("/projects"),
  project: (id: string) => readCompactMap(id, request),
  readableSummary: async (id: string, revision: number): Promise<Blob> => {
    const response = await fetch(`/api/mapping/projects/${encodeURIComponent(id)}/export.md?revision=${revision}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { code?: string; message?: string; details?: unknown };
      throw new MappingError(result.code ?? TRANSPORT_FALLBACK_CODE, result.message ?? '摘要生成失败，请重试；项目未修改', result.details, response.status);
    }
    return response.blob();
  },
  fullPackage: async (id: string, revision: number): Promise<Blob> => {
    const response = await fetch(`/api/mapping/projects/${encodeURIComponent(id)}/export.package?revision=${revision}`, { credentials: 'same-origin' });
    if (!response.ok) {
      const result = await response.json().catch(() => ({})) as { code?: string; message?: string; details?: unknown };
      throw new MappingError(result.code ?? TRANSPORT_FALLBACK_CODE, result.message ?? '完整项目包生成失败，请重试；项目未修改', result.details, response.status);
    }
    return response.blob();
  },
  poseVersion: (projectId: string, itemId: string, versionId: string) =>
    request<CanvasShape["item"]>(`/projects/${encodeURIComponent(projectId)}/versions/pose/${encodeURIComponent(itemId)}/${encodeURIComponent(versionId)}`),
  synchronize: (value: WorkspaceProjection) => syncCompactMap(value, request),
  execute: (command: Command, options?: { keepalive?: boolean }) => request<Receipt>("/execute", command, options?.keepalive),
};

export async function authorizeLocalSession() {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!token) return;
  history.replaceState(null, "", location.pathname + location.search);
  const response = await fetch("/api/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw new Error("本机启动凭证无效，请从 local-access.json 重新打开");
}
