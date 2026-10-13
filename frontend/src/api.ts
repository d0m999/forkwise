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
  if (!response.ok) throw new Error(result.message ?? "本机服务暂时不可用");
  return result as T;
}
export const api = {
  projects: () => request<Project[]>("/projects"),
  project: (id: string) =>
    request<ProjectState>("/projects/" + encodeURIComponent(id)),
  execute: (command: Command) => request<Receipt>("/execute", command),
};
