import { test, expect, place } from "./writing-board-fixture";
import { twoFrameGif } from "./image-reading-fixtures";
import {
  createCanvas,
  loadImage,
} from "../../backend/node_modules/@napi-rs/canvas/index.js";

test("GIF临时读取失败可在正文和大图同框重试，真实帧恢复且不写正文资产历史", async ({
  page,
  workspace,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0,
    failNext = true;
  await page.route("**/assets/*/content", async (route) => {
    requests++;
    if (failNext) {
      failNext = false;
      await route.fulfill({ status: 503, body: "temporary read failure" });
    } else await route.continue();
  });
  await place(page, "动图读取重试");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "重试红绿.gif",
    mimeType: "image/gif",
    buffer: twoFrameGif(),
  });
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  const block = page.locator(".body-image"),
    canvas = block.locator("canvas");
  await expect.poll(() => requests).toBe(1);
  const original = await canvas.elementHandle(),
    box = (await canvas.boundingBox())!,
    saved = await workspace.state();
  expect(box.width).toBe(80);
  expect(box.height).toBe(60);
  const retry = block.getByRole("button", {
    name: "重新加载动图",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect.poll(() => requests).toBe(2);
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((el, prior) => el === prior, original)).toBe(
    true,
  );
  expect((await canvas.boundingBox())!.width).toBe(box.width);
  expect((await canvas.boundingBox())!.height).toBe(box.height);
  async function samples(frame: typeof canvas, label: string) {
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
    expect(values).toContainEqual([255, 0, 0, 255]);
    expect(values).toContainEqual([0, 255, 0, 255]);
    return values;
  }
  const bodyFrames = await samples(canvas, "body-retry");
  failNext = true;
  await canvas.click();
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "正文大图", exact: true }),
    large = viewer.getByRole("img");
  await expect.poll(() => requests).toBe(3);
  const largeOriginal = await large.elementHandle();
  await viewer
    .getByRole("button", { name: "重新加载动图", exact: true })
    .click();
  await expect.poll(() => requests).toBe(4);
  expect(await large.evaluate((el, prior) => el === prior, largeOriginal)).toBe(
    true,
  );
  const viewerFrames = await samples(large, "viewer-retry");
  await viewer.getByRole("button", { name: "关闭大图", exact: true }).click();
  const after = await workspace.state();
  expect(after.project.revision).toBe(saved.project.revision);
  expect(after.cards[0]!.body).toEqual(saved.cards[0]!.body);
  const image = after.cards[0]!.body.blocks.find((b) => b.type === "image")!;
  const asset = await (
    await page.request.get(
      `${workspace.origin}/api/mapping/projects/${after.project.id}/assets/${image.assetId}`,
    )
  ).json();
  expect(asset.base64).toBe(twoFrameGif().toString("base64"));
  expect(errors).toEqual([]);
  await info.attach("retry-frame-samples", {
    body: Buffer.from(
      JSON.stringify({
        bodyFrames,
        viewerFrames,
        requests,
        revision: after.project.revision,
      }),
    ),
    contentType: "application/json",
  });
});
