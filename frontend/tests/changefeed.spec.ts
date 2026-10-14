import { expectTextValue } from "./text-editor-assertions";
import { test, expect, type Browser } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { openMapping } from "../../backend/src/mapping/storage";

async function fixture(browser: Browser) {
  const directory = mkdtempSync(join(tmpdir(), "forkwise-changefeed-web-"));
  const mapping = openMapping(directory);
  const humanToken = mapping.access.issue("human", ["*"]);
  const human = mapping.access.authenticate(humanToken);
  mapping.execute(
    {
      commandId: "project",
      projectId: "p",
      type: "project.create",
      expected: null,
      payload: { name: "同步研究" },
    },
    human,
  );
  mapping.execute(
    {
      commandId: "card",
      projectId: "p",
      type: "thought.create",
      expected: null,
      payload: { id: "c", title: "同步卡片", text: "初始正文", x: 10, y: 20 },
    },
    human,
  );
  const agentToken = mapping.access.issue("agent", ["p"], 600000, undefined, [
    "p",
  ]);
  mapping.close();
  const probe = createServer();
  const port = await new Promise<number>((resolve) =>
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    }),
  );
  const origin = `http://127.0.0.1:${port}`;
  let server: ChildProcess | undefined;
  let identity = "";
  const identities: string[] = [];
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
    identities.push(identity);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("自有服务启动超时")),
        10000,
      );
      server!.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("服务退出 " + code));
      });
      server!.stdout!.on("data", (data) => {
        if (String(data).includes("开放工作台")) {
          clearTimeout(timer);
          resolve();
        }
      });
      server!.stderr!.on("data", (data) => process.stderr.write(data));
    });
  };
  const stop = async () => {
    if (!server || server.exitCode !== null || server.signalCode !== null)
      return;
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
  const context = await browser.newContext();
  const page = await context.newPage();
  const request = async (path: string, data?: unknown, token = agentToken) => {
    const response = await context.request.fetch(
      origin + "/api/mapping" + path,
      {
        method: data ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + token,
          ...(data ? { Origin: origin } : {}),
        },
        ...(data ? { data } : {}),
      },
    );
    return { status: response.status(), value: await response.json() };
  };
  const index = async (snapshot?: string) => {
    const r = await request(
      "/projects/p/map?view=index" + (snapshot ? "&snapshot=" + snapshot : ""),
    );
    expect(r.status).toBe(200);
    return r.value;
  };
  const execute = async (data: Record<string, unknown>, token = agentToken) => {
    const r = await request("/execute", { projectId: "p", ...data }, token);
    expect(r.status).toBe(200);
    return r.value;
  };
  const cleanup = async () => {
    // Browser cleanup can reject after a failed route or closed worker. Its
    // failure must not skip closure of this exact owned server identity.
    try {
      await context.close();
    } finally {
      await stop();
      await expect
        .poll(async () => {
          try {
            await fetch(origin + "/api/mapping/projects");
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    await start();
    const url = new URL(
      JSON.parse(
        readFileSync(join(directory, "local-access.json"), "utf8"),
      ).url,
    );
    url.searchParams.set("project", "p");
    await page.goto(url.toString());
    await expect(page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      "3",
    );
    return {
      page,
      context,
      directory,
      origin,
      humanToken,
      agentToken,
      request,
      index,
      execute,
      start,
      stop,
      cleanup,
      identities,
    };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

test("断连重连后 UI 和 Agent 恢复同一地图，删除不留幽灵对象", async ({
  browser,
}, info) => {
  const f = await fixture(browser);
  try {
    await f.page.getByRole("button", { name: "编辑正文", exact: true }).click();
    await f.page.route("**/changes?**", (route) =>
      route.abort("connectionfailed"),
    );
    const card = (await f.index()).items[0];
    await f.execute({
      commandId: "remote-edit",
      type: "card.edit",
      expected: { body: card.body.versionId, pose: card.item.versionId },
      payload: { id: "c", text: "断连期间完整中文🧠正文", x: 380, y: 220 },
    });
    await expectTextValue(f.page.getByLabel("卡片正文", { exact: true }), "初始正文");
    await f.page.unroute("**/changes?**");
    await expect(f.page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      "4",
    );
    await expectTextValue(f.page.getByLabel("卡片正文", { exact: true }), "断连期间完整中文🧠正文");
    const same = await f.index(
      (await f.page.locator(".workspace").getAttribute("data-snapshot"))!,
    );
    expect(same.revision).toBe(4);
    expect(same.items[0].item.pose).toMatchObject({ x: 380, y: 220 });
    await f.execute(
      {
        commandId: "undo-edit",
        type: "history.undo",
        expected: 4,
        payload: {},
      },
      f.humanToken,
    );
    await f.execute(
      {
        commandId: "undo-create",
        type: "history.undo",
        expected: 5,
        payload: {},
      },
      f.humanToken,
    );
    await expect(f.page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      "6",
    );
    await expect(f.page.locator(".react-flow__node")).toHaveCount(0);
    await expect(
      f.page.getByText("这张卡片已删除", { exact: true }),
    ).toBeVisible();
    await expect(
      f.page.getByRole("button", { name: "撤销删除", exact: true }),
    ).toBeEnabled();
    expect(
      (
        await f.index(
          (await f.page.locator(".workspace").getAttribute("data-snapshot"))!,
        )
      ).items,
    ).toEqual([]);
    await f.page.screenshot({ path: info.outputPath("recovered-delete.png") });
    await f.page.getByRole("button", { name: "撤销删除", exact: true }).click();
    await expect(f.page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      "7",
    );
    expect((await f.index()).items[0].id).toBe("c");
  } finally {
    await f.cleanup();
    await info.attach("owned-service-closeout", {
      body: JSON.stringify({ identities: f.identities, closed: true }),
      contentType: "application/json",
    });
  }
});

test("真正服务重启使旧缓存 token 失效，同页面及新 context 完整恢复权威地图", async ({
  browser,
}, info) => {
  const f = await fixture(browser);
  try {
    const old = (await f.page
      .locator(".workspace")
      .getAttribute("data-snapshot"))!;
    await f.stop();
    await f.start();
    const expired = await f.request(
      "/projects/p/map?view=index&snapshot=" + old,
    );
    expect(expired).toMatchObject({
      status: 409,
      value: { code: "SNAPSHOT_EXPIRED" },
    });
    await expect
      .poll(() => f.page.locator(".workspace").getAttribute("data-snapshot"))
      .not.toBe(old);
    const current = (await f.page
      .locator(".workspace")
      .getAttribute("data-snapshot"))!;
    expect((await f.index(current)).revision).toBe(3);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(
        JSON.parse(readFileSync(join(f.directory, "local-access.json"), "utf8"))
          .url,
      );
      await expect(page.locator(".workspace")).toHaveAttribute(
        "data-snapshot",
        current,
      );
      await page.getByRole("button", { name: "编辑正文", exact: true }).click();
      await expectTextValue(page.getByLabel("卡片正文", { exact: true }), "初始正文");
    } finally {
      await context.close();
    }
    await f.page.screenshot({ path: info.outputPath("restart-recovered.png") });
  } finally {
    await f.cleanup();
    await info.attach("owned-service-closeout", {
      body: JSON.stringify({ identities: f.identities, closed: true }),
      contentType: "application/json",
    });
  }
});

test("过旧真实游标 RESET_REQUIRED 后 UI 完整重读，原幂等与旧版本仍可用", async ({
  browser,
}, info) => {
  const f = await fixture(browser);
  try {
    await f.page.route("**/changes?**", (route) =>
      route.abort("connectionfailed"),
    );
    const old = await f.index();
    const original = old.items[0];
    const mapping = openMapping(f.directory);
    try {
      const actor = mapping.access.authenticate(f.agentToken);
      let card = mapping.read({ type: "project", projectId: "p" }, actor)
        .cards[0]!;
      for (let n = 0; n < 1001; n++) {
        mapping.execute(
          {
            commandId: "retained-" + n,
            projectId: "p",
            type: "pose.move",
            expected: card.item.versionId,
            payload: { id: "c", x: 100 + n, y: 200 },
          },
          actor,
        );
        card = mapping.read({ type: "project", projectId: "p" }, actor)
          .cards[0]!;
      }
    } finally {
      mapping.close();
    }
    const reset = await f.request(
      "/projects/p/changes?after=3&baseSnapshot=" + old.snapshot,
    );
    expect(reset).toMatchObject({
      status: 200,
      value: {
        status: "RESET_REQUIRED",
        reason: "CURSOR_TOO_OLD",
        revision: 1004,
        changes: [],
      },
    });
    await f.page.unroute("**/changes?**");
    await expect(f.page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      "1004",
    );
    const same = await f.index(
      (await f.page.locator(".workspace").getAttribute("data-snapshot"))!,
    );
    expect(same.items[0].item.pose.x).toBe(1100);
    const oldBody = await f.request(
      `/projects/p/versions/body/${original.body.id}/${original.body.versionId}`,
    );
    expect(oldBody).toMatchObject({
      status: 200,
      value: { blocks: [{ text: "初始正文" }] },
    });
    expect(
      (
        await f.execute(
          {
            commandId: "card",
            type: "thought.create",
            expected: null,
            payload: {
              id: "c",
              title: "同步卡片",
              text: "初始正文",
              x: 10,
              y: 20,
            },
          },
          f.humanToken,
        )
      ).revision,
    ).toBe(2);
    await f.page.screenshot({ path: info.outputPath("reset-recovered.png") });
  } finally {
    await f.cleanup();
  }
});

test("晚到和重复变化响应不能覆盖新 revision 或复活已删除卡片", async ({
  browser,
}) => {
  const f = await fixture(browser);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let captured: any;
  let repeated = false;
  try {
    await f.page.route("**/changes?**", async (route) => {
      if (!captured) {
        const response = await route.fetch();
        captured = await response.json();
        await gate;
        await route.fulfill({ json: captured });
      } else if (!repeated) {
        repeated = true;
        await route.fulfill({ json: captured });
      } else await route.continue();
    });
    await expect.poll(() => !!captured).toBe(true);
    await f.execute(
      { commandId: "delete", type: "history.undo", expected: 3, payload: {} },
      f.humanToken,
    );
    // A local project refresh publishes deletion before the older response arrives.
    await f.page.reload();
    release();
    await expect(f.page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      "4",
    );
    await expect(f.page.locator(".react-flow__node")).toHaveCount(0);
    await f.page.unrouteAll({ behavior: "wait" });
    expect((await f.index()).items).toEqual([]);
  } finally {
    release();
    await f.cleanup();
  }
});

test("授权撤销撤下派生地图，未确认草稿保留，重新授权完整读取", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await f.page.getByRole("button", { name: "编辑正文", exact: true }).click();
    await f.page.route("**/execute", (route) =>
      route.abort("connectionfailed"),
    );
    await f.page
      .getByLabel("卡片正文", { exact: true })
      .fill("未确认但必须保留的草稿");
    await expect(f.page.getByRole("status")).toHaveText("保存未完成");
    const cookies = await f.context.cookies(f.origin);
    const token = cookies.find((c) =>
      c.name.startsWith("forkwise_workspace_"),
    )!.value;
    const mapping = openMapping(f.directory);
    try {
      mapping.access.revoke(mapping.access.authenticate(token).tokenHash);
    } finally {
      mapping.close();
    }
    await expect(
      f.page.getByText(
        "授权已失效，请从本机启动入口重新打开；未确认草稿已保留",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(f.page.locator(".react-flow__node")).toHaveCount(0);
    expect(await f.page.evaluate(() => JSON.stringify(localStorage))).toContain(
      "未确认但必须保留的草稿",
    );
    await f.page.unrouteAll({ behavior: "wait" });
    await f.stop();
    await f.start();
    await f.page.goto("about:blank");
    await f.page.goto(
      JSON.parse(readFileSync(join(f.directory, "local-access.json"), "utf8"))
        .url,
    );
    await expect(f.page.locator(".workspace")).toHaveAttribute(
      "data-revision",
      "3",
    );
    await expect(
      f.page.getByRole("button", { name: "恢复草稿", exact: true }),
    ).toBeVisible();
  } finally {
    await f.cleanup();
  }
});

for (const field of ["body", "title"] as const) {
  for (const boundary of ["changes", "history", "projects"] as const) {
    test(`D123 ${field} 新草稿使 ${boundary} await 中的旧轮失效，journal 保持`, async ({
      browser,
    }, info) => {
      const f = await fixture(browser);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held!: () => void;
      const captured = new Promise<void>((resolve) => {
        held = resolve;
      });
      let next!: () => void;
      const settled = new Promise<void>((resolve) => {
        next = resolve;
      });
      let armed = false;
      let observeStarted = false;
      let didHold = false;
      try {
        await f.page.route("**/api/mapping/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/changes")) {
            if (!armed) return route.abort("connectionfailed");
            if (observeStarted) {
              next();
              return route.abort("connectionfailed");
            }
            observeStarted = true;
          }
          const target =
            boundary === "changes"
              ? path.endsWith("/changes")
              : boundary === "history"
                ? path.endsWith("/history")
                : path === "/api/mapping/projects";
          if (!armed || !target || didHold) return route.continue();
          didHold = true;
          const response = await route.fetch();
          const value = await response.json();
          expect(
            boundary === "projects" ? value[0].revision : value.revision,
          ).toBe(4);
          held();
          await gate;
          await route.fulfill({ response });
        });
        if (field === "body")
          await f.page
            .getByRole("button", { name: "编辑正文", exact: true })
            .click();
        else
          await f.page
            .getByRole("button", { name: "同步卡片", exact: true })
            .dblclick();
        const editor = f.page.getByLabel(
          field === "body" ? "卡片正文" : "卡片标题",
          { exact: true },
        );
        // Start composition before the read: later input advances generation,
        // without another composition event changing the editor epoch.
        await editor.dispatchEvent("compositionstart");
        await editor.fill("组合中的起始草稿");
        const card = (await f.index()).items[0];
        await f.execute({
          commandId: "remote-before-read",
          type: "body.edit",
          expected: card.body.versionId,
          payload: { id: "c", text: "读取开始前已提交的远端正文" },
        });
        armed = true;
        await captured;
        await expect(f.page.locator(".workspace")).toHaveAttribute(
          "data-revision",
          "3",
        );
        const input = `读取期间新增的${field}草稿🧠`;
        await editor.fill(input);
        const journal = await f.page.evaluate(() => {
          const key = Object.keys(localStorage).find((k) =>
            k.startsWith("forkwise:recovery:v1:"),
          )!;
          return { key, value: JSON.parse(localStorage.getItem(key)!) };
        });
        expect(journal.value.drafts[0]).toMatchObject({
          projectId: "p",
          cardId: "c",
          field,
          generation: 2,
          expected: field === "body" ? card.body.versionId : card.versionId,
          value: input,
        });
        release();
        // The next serialized poll proves the old round has settled; its
        // response is aborted so it cannot publish a later, fresh projection.
        await settled;
        const after = await f.page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key)!),
          journal.key,
        );
        expect(after).toEqual(journal.value);
        await expectTextValue(editor, input);
        expect((await f.index()).revision).toBe(4);
        await info.attach("draft-invalidation-observation", {
          body: JSON.stringify({
            field,
            boundary,
            beforeAuthority: 2,
            serverRevision: 3,
            afterAuthority: await f.page
              .locator(".workspace")
              .getAttribute("data-revision"),
            journalBefore: journal.value,
            journalAfter: after,
            syntheticComposition: true,
          }),
          contentType: "application/json",
        });
        await expect(f.page.locator(".workspace")).toHaveAttribute(
          "data-revision",
          "3",
        );
      } finally {
        release();
        await f.page.unrouteAll({ behavior: "wait" });
        await f.cleanup();
        await info.attach("owned-service-closeout", {
          body: JSON.stringify({
            identities: f.identities,
            origin: f.origin,
            temporaryDirectory: f.directory,
            contextClosed: true,
            servicesClosed: true,
            portClosed: true,
            temporaryDirectoryRemoved: true,
          }),
          contentType: "application/json",
        });
      }
    });
  }
}
