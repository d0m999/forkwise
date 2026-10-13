import type {
  Command,
  Project,
  ProjectState,
  Receipt,
} from "../../backend/src/mapping/contracts";
export type {
  Card,
  Command,
  Project,
  ProjectState,
} from "../../backend/src/mapping/contracts";
export class MappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
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
    );
  return result as T;
}
export const api = {
  projects: () => request<Project[]>("/projects"),
  project: (id: string) =>
    request<ProjectState>("/projects/" + encodeURIComponent(id)),
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
