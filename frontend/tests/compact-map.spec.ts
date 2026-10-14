import { expectTextValue } from "./text-editor-assertions";
import { test, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { openMapping } from "../../backend/src/mapping/storage";

test("实际工作台和授权 Agent 在并发写入期间核对同一固定 snapshot，新 context 重开持久正文", async ({
  browser,
}, info) => {
  const directory = mkdtempSync(join(tmpdir(), "forkwise-compact-web-"));
  const probe = createServer();
  const port = await new Promise<number>((resolve) =>
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    }),
  );
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let identity = "";
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  const start = async () => {
    server = spawn(process.execPath, ["dist/src/workspace-server.js"], {
      cwd: resolve("../backend"),
      env: {
        ...process.env,
        FORKWISE_DATA_DIR: directory,
        FORKWISE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    identity = execFileSync(
      "ps",
      ["-p", String(server.pid), "-o", "pid=,ppid=,lstart=,command="],
      { encoding: "utf8" },
    ).trim();
    expect(identity).toContain(String(process.pid));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("自有服务启动超时")),
        10000,
      );
      server!.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error("自有服务退出 " + code));
      });
      server!.stdout!.on("data", (data) => {
        if (String(data).includes("开放工作台")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      server!.stderr!.on("data", (data) => process.stderr.write(data));
    });
    await info.attach("owned-service", {
      body: JSON.stringify({
        PopenPID: server.pid,
        PPID: process.pid,
        identity,
        origin,
      }),
      contentType: "application/json",
    });
  };
  const stop = async () => {
    if (!server || server.exitCode !== null) return;
    expect(
      execFileSync(
        "ps",
        ["-p", String(server.pid), "-o", "pid=,ppid=,lstart=,command="],
        { encoding: "utf8" },
      ).trim(),
    ).toBe(identity);
    const closed = new Promise((resolve) => server!.once("exit", resolve));
    server.kill("SIGTERM");
    await closed;
  };
  try {
    await start();
    const context = await browser.newContext();
    contexts.push(context);
    const page = await context.newPage();
    const access = JSON.parse(
      readFileSync(join(directory, "local-access.json"), "utf8"),
    );
    await page.goto(access.url);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await page.getByRole("button", { name: "新建研究", exact: true }).click();
    await page
      .getByRole("button", { name: "卡片", exact: true })
      .press("Enter");
    await page
      .locator(".react-flow__pane")
      .click({ position: { x: 350, y: 240 } });
    await page.getByLabel("卡片标题", { exact: true }).fill("同快照卡片");
    await page.getByLabel("卡片标题", { exact: true }).press("Enter");
    await page.getByRole("button", { name: "编辑正文", exact: true }).click();
    const text = "中文🧠原文\n".repeat(800);
    await page.getByLabel("卡片正文", { exact: true }).fill(text);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    const projectId = new URL(page.url()).searchParams.get("project")!;
    const mapping = openMapping(directory);
    const agentToken = mapping.access.issue(
      "agent",
      [projectId],
      60000,
      undefined,
      [projectId],
    );
    mapping.close();
    const read = async (view: string, snapshot?: string, cardId?: string) => {
      const query = new URLSearchParams({
        view,
        budget: "131072",
        ...(snapshot ? { snapshot } : {}),
        ...(cardId ? { cardId } : {}),
      });
      const response = await context.request.get(
        origin + `/api/mapping/projects/${projectId}/map?${query}`,
        { headers: { Authorization: "Bearer " + agentToken } },
      );
      expect(response.status()).toBe(200);
      return response.json();
    };
    // Hold the actual UI index response, write from another authorized caller,
    // then let the UI complete detail reads using the captured snapshot.
    let captured: any;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/map\?.*view=index/, async (route) => {
      if (captured) return route.continue();
      const response = await route.fetch();
      captured = await response.json();
      await gate;
      await route.fulfill({ response });
    });
    const reloading = page.reload();
    try {
      await expect.poll(() => !!captured).toBe(true);
      const same = await read("index", captured.snapshot);
      expect(same).toEqual(captured);
      const card = same.items[0];
      const write = await context.request.post(
        origin + "/api/mapping/execute",
        {
          headers: { Origin: origin, Authorization: "Bearer " + agentToken },
          data: {
            commandId: "agent-concurrent",
            projectId,
            type: "card.edit",
            expected: { body: card.body.versionId, pose: card.item.versionId },
            payload: {
              id: card.id,
              text: "并发更新后持久正文",
              x: 430,
              y: 260,
            },
          },
        },
      );
      expect(write.status()).toBe(200);
      release();
      await reloading;
      await expect(page.locator(".workspace")).toHaveAttribute(
        "data-snapshot",
        captured.snapshot,
      );
      await expect(page.locator(".workspace")).toHaveAttribute(
        "data-revision",
        String(captured.revision),
      );
      await page.getByRole("button", { name: "编辑正文", exact: true }).click();
      await expectTextValue(page.getByLabel("卡片正文", { exact: true }), text);
      expect(
        (await read("index", captured.snapshot)).items[0].item.pose,
      ).toEqual(card.item.pose);
      const detail = await read("detail", captured.snapshot, card.id);
      const body = JSON.parse(
        detail.items.map((i: any) => i.jsonText).join(""),
      );
      expect(body.blocks[0].text).toBe(text);
      await page.screenshot({ path: info.outputPath("same-snapshot.png") });
      await info.attach("same-snapshot", {
        body: JSON.stringify({
          index: captured,
          detail,
          renderedRevision: captured.revision,
        }),
        contentType: "application/json",
      });
    } finally {
      release();
      await reloading;
      await page.unrouteAll({ behavior: "wait" });
    }
    await context.close();
    await stop();
    await start();
    const reopened = await browser.newContext();
    contexts.push(reopened);
    const newPage = await reopened.newPage();
    await newPage.goto(
      JSON.parse(readFileSync(join(directory, "local-access.json"), "utf8"))
        .url,
    );
    await expect(newPage.getByRole("status")).toHaveText("已保存到本机");
    await newPage
      .getByRole("button", { name: "编辑正文", exact: true })
      .click();
    await expectTextValue(newPage.getByLabel("卡片正文", { exact: true }), "并发更新后持久正文");
    await newPage.screenshot({ path: info.outputPath("reopened-current.png") });
  } finally {
    for (const context of contexts) await context.close();
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
