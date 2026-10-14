import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { ProjectState } from "../src/api";
import { openMapping } from "../../backend/src/mapping/storage";

type Workspace = {
  origin: string;
  state: (page?: Page) => Promise<ProjectState>;
  open: (page: Page) => Promise<void>;
  restart: () => Promise<void>;
  revoke: () => void;
  removeCard: (id: string) => void;
};
export const test = base.extend<{ workspace: Workspace }>({
  workspace: async ({ page }, use) => {
    const directory = mkdtempSync(join(tmpdir(), "forkwise-issue9-"));
    let server: ChildProcess | undefined;
    const socket = createServer();
    let origin = "";
    async function stop() {
      if (server?.exitCode === null) {
        const ended = new Promise((resolve) => server!.once("exit", resolve));
        server.kill("SIGTERM");
        await ended;
      }
    }
    async function start() {
      server = spawn(process.execPath, ["dist/src/workspace-server.js"], {
        cwd: resolve("../backend"),
        env: {
          ...process.env,
          FORKWISE_DATA_DIR: directory,
          FORKWISE_PORT: new URL(origin).port,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("服务启动超时")),
          10000,
        );
        server!.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`服务退出 ${code}`));
        });
        server!.stdout!.on("data", (chunk) => {
          if (String(chunk).includes("开放工作台")) {
            clearTimeout(timer);
            resolve();
          }
        });
        server!.stderr!.on("data", (chunk) => process.stderr.write(chunk));
      });
    }
    async function open(target: Page) {
      await target.goto(
        JSON.parse(readFileSync(join(directory, "local-access.json"), "utf8"))
          .url,
      );
      await expect(target.getByRole("status")).toHaveText("已保存到本机");
    }
    function removeCard(id: string) {
      const host = openMapping(directory);
      try {
        const access = JSON.parse(
          readFileSync(join(directory, "local-access.json"), "utf8"),
        );
        const token = new URLSearchParams(
          new URL(access.url).hash.slice(1),
        ).get("token")!;
        const human = host.access.authenticate(token);
        const project = host.read({ type: "projects" }, human)[0]!;
        for (let i = 0; i < 10; i++) {
          const state = host.read(
            { type: "project", projectId: project.id },
            human,
          );
          if (!state.cards.some((c) => c.id === id)) return;
          host.execute(
            {
              commandId: crypto.randomUUID(),
              projectId: project.id,
              type: "history.undo",
              expected: state.project.revision,
              payload: {},
            },
            human,
          );
        }
        throw new Error("测试卡片未删除");
      } finally {
        host.close();
      }
    }
    try {
      const port = await new Promise<number>((resolve) =>
        socket.listen(0, "127.0.0.1", () => {
          const port = (socket.address() as { port: number }).port;
          socket.close(() => resolve(port));
        }),
      );
      origin = `http://127.0.0.1:${port}`;
      await start();
      await open(page);
      await page.getByRole("button", { name: "新建研究", exact: true }).click();
      await expect(page.getByRole("tab", { selected: true })).toBeVisible();
      await use({
        origin,
        open,
        removeCard,
        restart: async () => {
          await stop();
          await start();
        },
        revoke: () => {
          const host = openMapping(directory);
          try {
            const access = JSON.parse(
              readFileSync(join(directory, "local-access.json"), "utf8"),
            );
            const token = new URLSearchParams(
              new URL(access.url).hash.slice(1),
            ).get("token")!;
            host.access.revoke(host.access.authenticate(token).tokenHash);
          } finally {
            host.close();
          }
        },
        state: async (target = page) => {
          const projects = await (
            await target.request.get(origin + "/api/mapping/projects")
          ).json();
          return (
            await target.request.get(
              origin + "/api/mapping/projects/" + projects[0].id,
            )
          ).json();
        },
      });
    } finally {
      await page.context().close();
      await stop();
      if (socket.listening)
        await new Promise<void>((resolve) => socket.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  },
});
export async function place(page: Page, title: string, x = 100, y = 120) {
  await page.getByRole("button", { name: "卡片", exact: true }).click();
  await page.locator(".react-flow__pane").click({ position: { x, y } });
  await page.getByLabel("卡片标题", { exact: true }).fill(title);
  await page.getByLabel("卡片标题", { exact: true }).press("Enter");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
}

export { expect };
