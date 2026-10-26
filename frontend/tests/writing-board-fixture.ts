import { test as base, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { ProjectState } from "../src/api";
import { openMapping } from "../../backend/src/mapping/storage";
import { createMcpServer, httpTransport } from "../../backend/src/mcp-server";
import { Client } from "../../backend/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../../backend/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import Database from "../../backend/node_modules/better-sqlite3/lib/index.js";
import type { Block } from "../../backend/src/mapping/contracts";

export type Workspace = {
  origin: string;
  state: (page?: Page) => Promise<ProjectState>;
  open: (page: Page, expectedStatus?: string) => Promise<void>;
  restart: () => Promise<void>;
  revoke: () => void;
  removeCard: (id: string) => void;
  directory: string;
  execute: (page: Page, command: Record<string, unknown>) => Promise<any>;
  agentBody: (projectId: string, cardId: string, snapshot: string) => Promise<any>;
  installOriginalBody: (id: string, blocks: Block[]) => Promise<void>;
  installOriginalTagColor: (id: string, color: string) => Promise<void>;
  installOriginalShapeItem: (id: string, itemId: string) => Promise<void>;
};
export const test = base.extend<{ workspace: Workspace }>({
  workspace: async ({ page }, use, testInfo) => {
    const directory = mkdtempSync(join(tmpdir(), "forkwise-issue10-"));
    const evidence = process.env.FORKWISE_ISSUE10_RESOURCE_LOG;
    const record = (event: Record<string, unknown>) => {
      if (evidence) appendFileSync(evidence, JSON.stringify({ at: new Date().toISOString(), fixturePID: process.pid, fixturePPID: process.ppid, directory, ...event }) + "\n");
    };
    record({ event: "allocate-directory", method: "mkdtemp-direct" });
    let server: ChildProcess | undefined;
    const socket = createServer();
    let origin = "";
    async function stop() {
      if (server?.exitCode === null) {
        const ended = new Promise((resolve) => server!.once("exit", resolve));
        server.kill("SIGTERM");
        await ended;
        record({ event: "server-closed", pid: server.pid, exit: server.exitCode, signal: server.signalCode });
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
      record({ event: "server-spawn", pid: server.pid, executable: process.execPath, port: new URL(origin).port });
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
    async function open(target: Page, expectedStatus = "已保存到本机") {
      await target.goto(
        JSON.parse(readFileSync(join(directory, "local-access.json"), "utf8"))
          .url,
      );
      await expect(target.getByRole("status")).toHaveText(expectedStatus);
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
        directory,
        installOriginalShapeItem: async (id, itemId) => {
          await stop();
          try {
            const db = new Database(join(directory, 'workspace.sqlite'));
            try {
              const projects = db.prepare('SELECT id,revision FROM mapping_projects').all() as { id: string; revision: number }[];
              if (projects.length !== 1 || !id || !itemId || id === itemId || id.length > 160 || itemId.length > 160) throw new Error('legacy Shape 初始化要求单一空项目和不同的有效身份');
              const project = projects[0]!;
              for (const table of ['mapping_cards', 'mapping_shapes', 'mapping_texts', 'mapping_images', 'mapping_strokes', 'mapping_connectors']) {
                if (db.prepare(`SELECT 1 FROM ${table} WHERE project_id=?`).get(project.id)) throw new Error('legacy Shape 只能初始化空画布');
              }
              if (db.prepare('SELECT 1 FROM mapping_shape_ids WHERE id=?').get(id) || db.prepare("SELECT 1 FROM mapping_versions WHERE domain='pose' AND id=?").get(itemId)) throw new Error('legacy Shape 身份已经存在');
              const value: NonNullable<ProjectState['shapes']>[number] = { id, kind: 'shape', versionId: crypto.randomUUID(),
                content: { shapeType: 'rectangle', shortText: '特殊身份', fill: '#dce8dd', stroke: '#403b36', strokeWidth: 2 },
                item: { id: itemId, versionId: crypto.randomUUID(), createdOrder: project.revision, pose: { x: 180, y: 170, width: 220, height: 120 } } };
              // Stopped-server fixture input only; do not manufacture a production command or history.
              db.transaction(() => {
                db.prepare('INSERT INTO mapping_shape_ids VALUES(?,?)').run(id, project.id);
                db.prepare('INSERT INTO mapping_shapes VALUES(?,?,?)').run(id, project.id, JSON.stringify(value));
                const version = db.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)');
                version.run(project.id, 'shape', id, value.versionId, JSON.stringify({ id, versionId: value.versionId, content: value.content }));
                version.run(project.id, 'pose', itemId, value.item.versionId, JSON.stringify(value.item));
              })();
              record({ event: 'legacy-shape-item-fixture-input', projectId: project.id, shapeId: id, itemId, itemVersion: value.item.versionId, createdOrder: value.item.createdOrder });
            } finally { db.close(); }
          } finally { await start(); }
        },
        installOriginalTagColor: async (id, color) => {
          await stop();
          try {
            const db = new Database(join(directory, 'workspace.sqlite'));
            try {
              const row = db.prepare('SELECT project_id,value FROM mapping_tags WHERE id=?').get(id) as { project_id: string; value: string };
              const tag = { ...JSON.parse(row.value), color, versionId: crypto.randomUUID() };
              db.transaction(() => {
                db.prepare('UPDATE mapping_tags SET value=? WHERE id=?').run(JSON.stringify(tag), id);
                db.prepare('INSERT INTO mapping_versions VALUES(?,?,?,?,?)').run(row.project_id, 'tag', id, tag.versionId, JSON.stringify(tag));
              })();
              record({ event: 'legacy-tag-fixture-input', id, tagVersion: tag.versionId });
            } finally { db.close(); }
          } finally { await start(); }
        },
        installOriginalBody: async (id, blocks) => {
          await stop();
          const host = openMapping(directory);
          let card: ProjectState['cards'][number], projectId: string;
          try {
            const access = JSON.parse(readFileSync(join(directory, "local-access.json"), "utf8"));
            const token = new URLSearchParams(new URL(access.url).hash.slice(1)).get("token")!;
            const human = host.access.authenticate(token);
            projectId = host.read({ type: "projects" }, human)[0]!.id;
            card = host.read({ type: "project", projectId }, human).cards.find(c => c.id === id)!;
          } finally { host.close(); }
          card.body = { ...card.body, versionId: crypto.randomUUID(), blocks };
          // Legacy fixture input only, with the server stopped. Production
          // writes and every readback assertion still cross the real seam.
          const db = new Database(join(directory, "workspace.sqlite"));
          try {
            db.prepare("UPDATE mapping_cards SET value=? WHERE id=?").run(JSON.stringify(card), id);
            db.prepare("INSERT INTO mapping_versions VALUES(?,?,?,?,?)").run(projectId, "body", card.body.id, card.body.versionId, JSON.stringify(card.body));
          } finally { db.close(); }
          record({ event: "legacy-fixture-input", id, bodyVersion: card.body.versionId });
          await start();
        },
        agentBody: async (projectId, cardId, snapshot) => {
          const host = openMapping(directory);
          let client: Client | undefined;
          let mcp: ReturnType<typeof createMcpServer> | undefined;
          const token = host.access.issue("agent", [projectId]);
          try {
            mcp = createMcpServer(httpTransport(origin, token));
            client = new Client({ name: "issue10-ui-snapshot", version: "1.0.0" });
            const [a, b] = InMemoryTransport.createLinkedPair();
            await mcp.connect(b); await client.connect(a);
            let cursor: string | undefined;
            let jsonText = "", revision: number | undefined;
            do {
              const result = await client.callTool({ name: "forkwise_read_map", arguments: { projectId, cardId, snapshot, view: "detail", ...(cursor ? { cursor } : {}) } });
              if (result.isError) throw new Error(JSON.stringify(result));
              const response = (result.structuredContent as any).response;
              if (revision !== undefined && response.revision !== revision) throw new Error("MCP snapshot revision changed");
              revision = response.revision;
              jsonText += response.items.map((c: { jsonText: string }) => c.jsonText).join("");
              cursor = response.nextCursor ?? undefined;
            } while (cursor);
            return { body: JSON.parse(jsonText), revision, snapshot };
          } finally {
            try { await client?.close(); } finally { try { await mcp?.close(); } finally { host.access.revoke(host.access.authenticate(token).tokenHash); host.close(); } }
          }
        },
        execute: async (target, command) => {
          const response = await target.request.post(origin + "/api/mapping/execute", { data: command, headers: { Origin: origin } });
          const value = await response.json();
          if (!response.ok()) throw new Error(JSON.stringify(value));
          return value;
        },
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
      try {
        await page.context().close();
      } finally {
        await stop();
        if (socket.listening)
          await new Promise<void>((resolve) => socket.close(() => resolve()));
        if (process.env.FORKWISE_TEST_RETAIN_FAILURE && testInfo.status !== testInfo.expectedStatus) {
          record({ event: "directory-retained", reason: "failed-test-evidence" });
        } else {
          rmSync(directory, { recursive: true, force: true });
          record({ event: "directory-reclaimed", method: "own-direct-allocation-finally" });
        }
      }
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
