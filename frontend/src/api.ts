import type { MediaAsset } from '../../backend/src/mapping/media';
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
  ) {
    super(message);
  }
}
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/mapping" + path, {
    credentials: "same-origin",
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
      result.code ?? "UNAVAILABLE",
      result.message ?? "本机服务暂时不可用",
      result.details,
    );
  return result as T;
}
export const api = {
  asset: (projectId:string,id:string)=>request<MediaAsset>(`/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(id)}`),
  cardIdentity: (projectId: string, cardId: string) =>
    request<CardIdentity>(
      `/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(cardId)}/identity`,
    ),
  history: (id: string) =>
    request<ProjectHistory>("/projects/" + encodeURIComponent(id) + "/history"),
  projects: () => request<Project[]>("/projects"),
  project: (id: string) => readCompactMap(id, request),
  synchronize: (value: WorkspaceProjection) => syncCompactMap(value, request),
  execute: (command: Command) => request<Receipt>("/execute", command),
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
