import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, extname, sep } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "../../backend/node_modules/@hono/node-server/dist/index.mjs";
import { openMapping } from "../../backend/src/mapping/storage";
import { createWorkspaceApp } from "../../backend/src/mapping/http";

test("真实库文件读取失败可见，保留当前输入，显式受限后重试恢复全部条件", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "forkwise-search-failure-"));
  let missing = true;
  const mapping = openMapping(directory, {
    searchAssetReader: (url) =>
      readFile(
        missing && url.pathname.endsWith(".wasm")
          ? join(directory, "missing-library.wasm")
          : url,
      ),
  });
  let app: ReturnType<typeof createWorkspaceApp>;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => app.fetch(request),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const root = resolve("../backend/dist/workspace");
    app = createWorkspaceApp(mapping, origin, (path) => {
      const file = resolve(root, "." + path);
      const mime = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
      }[extname(file)];
      if (!file.startsWith(root + sep) || !mime)
        return new Response("", { status: 404 });
      return new Response(readFileSync(file), {
        headers: { "Content-Type": mime },
      });
    });
    const token = mapping.access.issue("human", ["*"]);
    const human = mapping.access.authenticate(token);
    mapping.execute(
      {
        type: "project.create",
        commandId: "p",
        projectId: "p",
        expected: null,
        payload: { name: "真实库故障" },
      },
      human,
    );
    for (const [id, text] of [
      ["a", "多头平仓"],
      ["b", "多头开始平仓"],
    ])
      mapping.execute(
        {
          type: "thought.create",
          commandId: id,
          projectId: "p",
          expected: null,
          payload: { id, title: id, text, x: 0, y: 0 },
        },
        human,
      );
    await page.goto(origin + "/#token=" + token);
    await expect(page.getByRole("status")).toHaveText("已保存到本机");
    await page
      .getByRole("button", { name: "搜索当前项目卡片", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "搜索当前项目卡片",
      exact: true,
    });
    const input = dialog.getByRole("searchbox", {
      name: "关键词",
      exact: true,
    });
    await input.fill("多头平仓");
    await expect(dialog.getByRole("alert")).toContainText("搜索库加载失败");
    await expect(
      dialog.getByText("0 张卡片", { exact: true }),
    ).not.toBeVisible();
    let release!: () => void;
    let started!: () => void;
    let limitedRequests = 0;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/search", async (route) => {
      const response = await route.fetch();
      if (route.request().postDataJSON().literal) {
        limitedRequests++;
        started();
        await gate;
      }
      await route.fulfill({ response });
    });
    const limited = dialog.getByRole("button", {
      name: "暂按完整片段搜索",
      exact: true,
    });
    await limited.click();
    await waiting;
    try {
      await expect(limited).toBeDisabled();
      await limited.click({ force: true });
      expect(limitedRequests).toBe(1);
    } finally {
      release();
    }
    await expect(dialog.getByText("1 张卡片", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("当前按完整片段搜索，未自动识别中文词组", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(input).toHaveValue("多头平仓");
    missing = false;
    await dialog
      .getByRole("button", { name: "重试完整搜索", exact: true })
      .click();
    await expect(dialog.getByText("2 张卡片", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("多头平仓");
    await expect(dialog.locator("mark")).toHaveText([
      "多头",
      "平仓",
      "多头",
      "平仓",
    ]);
  } finally {
    await page.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    mapping.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
