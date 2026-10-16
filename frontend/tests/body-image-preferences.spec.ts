import { test, expect, place } from "./writing-board-fixture";
import { twoFrameGif } from "./image-reading-fixtures";
import {
  createCanvas,
  loadImage,
} from "../../backend/node_modules/@napi-rs/canvas/index.js";

test("同一GIF正文与大图双向沿用人工暂停播放意图，真实帧且不写历史", async ({
  page,
  workspace,
}, info) => {
  const commands: { type: string; commandId: string; at: number }[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/mapping/execute")) {
      const command = request.postDataJSON();
      commands.push({
        type: command.type,
        commandId: command.commandId,
        at: Date.now(),
      });
    }
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await place(page, "同图播放意图");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "同图红绿.gif",
    mimeType: "image/gif",
    buffer: twoFrameGif(),
  });
  const body = page.locator(".body-image canvas");
  await expect(body).toBeVisible();
  await expect
    .poll(async () =>
      (await workspace.state()).cards[0]!.body.blocks.some(
        (block) => block.type === "image" && !block.request,
      ),
    )
    .toBe(true);
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const saved = await workspace.state(),
    uiBefore = Number(
      await page.locator(".workspace").getAttribute("data-revision"),
    );
  expect(uiBefore).toBe(saved.project.revision);
  await info.attach("before-any-playback-action", {
    body: Buffer.from(
      JSON.stringify({
        body: saved.cards[0]!.body,
        revision: saved.project.revision,
        uiRevision: uiBefore,
        commands,
      }),
    ),
    contentType: "application/json",
  });
  const observations: Record<string, number[][]> = {};
  async function samples(frame: typeof body, label: string) {
    const values: number[][] = [],
      seen = new Set<string>();
    for (let i = 0; i < 9; i++) {
      const png = await frame.screenshot(),
        image = await loadImage(png),
        surface = createCanvas(image.width, image.height);
      surface.getContext("2d").drawImage(image, 0, 0);
      const value = Array.from(
        surface.getContext("2d").getImageData(40, 30, 1, 1).data,
      );
      values.push(value);
      if (!seen.has(String(value))) {
        seen.add(String(value));
        await info.attach(label + "-" + seen.size, {
          body: png,
          contentType: "image/png",
        });
      }
      await page.waitForTimeout(70);
    }
    observations[label] = values;
    await info.attach(label + "-samples", {
      body: Buffer.from(JSON.stringify(values)),
      contentType: "application/json",
    });
    return values;
  }
  const moving = (values: number[][]) => {
    expect(values).toContainEqual([255, 0, 0, 255]);
    expect(values).toContainEqual([0, 255, 0, 255]);
  };
  const paused = (values: number[][]) =>
    expect(new Set(values.map(String)).size).toBe(1);
  moving(await samples(body, "body-default"));
  await page.getByRole("button", { name: "暂停动图", exact: true }).click();
  paused(await samples(body, "body-manual-pause"));
  await body.click();
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "正文大图", exact: true }),
    large = viewer.getByRole("img");
  paused(await samples(large, "viewer-inherited-pause"));
  await viewer.getByRole("button", { name: "播放动图", exact: true }).click();
  moving(await samples(large, "viewer-explicit-play"));
  await viewer.getByRole("button", { name: "关闭大图", exact: true }).click();
  moving(await samples(body, "body-inherited-play"));
  await body.click();
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  await viewer.getByRole("button", { name: "暂停动图", exact: true }).click();
  paused(await samples(large, "viewer-manual-pause"));
  await viewer.getByRole("button", { name: "关闭大图", exact: true }).click();
  paused(await samples(body, "body-inherited-pause"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "播放动图", exact: true }).click();
  await body.click();
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  moving(await samples(large, "viewer-inherited-explicit-play-in-reduce"));
  await viewer.getByRole("button", { name: "关闭大图", exact: true }).click();
  const after = await workspace.state();
  await info.attach("after-playback-actions", {
    body: Buffer.from(
      JSON.stringify({
        body: after.cards[0]!.body,
        revision: after.project.revision,
        uiRevision: Number(
          await page.locator(".workspace").getAttribute("data-revision"),
        ),
        commands,
      }),
    ),
    contentType: "application/json",
  });
  expect(after.project.revision).toBe(saved.project.revision);
  expect(after.cards[0]!.body).toEqual(saved.cards[0]!.body);
  await info.attach("same-gif-intent", {
    body: Buffer.from(
      JSON.stringify({ observations, revision: after.project.revision }),
    ),
    contentType: "application/json",
  });
});
