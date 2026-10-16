import { test, expect, place } from "./writing-board-fixture";
import { twoFrameGif } from "./image-reading-fixtures";
import {
  createCanvas,
  loadImage,
} from "../../backend/node_modules/@napi-rs/canvas/index.js";
test.use({ actionTimeout: 6000 });
test("大图GIF沿用减少动态默认暂停与明确播放，实际截图帧变化且关闭保正文", async ({
  page,
  workspace,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await place(page, "大图动图");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  await page.getByRole("textbox", { name: "卡片正文", exact: true }).click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "大图双帧.gif",
    mimeType: "image/gif",
    buffer: twoFrameGif(),
  });
  const body = page.locator(".body-image canvas");
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await body.click();
  await page.getByRole("button", { name: "查看大图", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "正文大图", exact: true });
  await expect(
    viewer.getByRole("button", { name: "播放动图", exact: true }),
  ).toBeVisible();
  const frame = viewer.getByRole("img");
  let sequence = 0;
  const samples = async () => {
    const values: number[][] = [];
    for (let i = 0; i < 8; i++) {
      const screenshot = await frame.screenshot(),
        decoded = await loadImage(screenshot),
        canvas = createCanvas(decoded.width, decoded.height);
      canvas.getContext("2d").drawImage(decoded, 0, 0);
      values.push(
        Array.from(canvas.getContext("2d").getImageData(40, 30, 1, 1).data),
      );
      if (i === 0)
        await info.attach(`viewer-gif-${sequence++}`, {
          body: screenshot,
          contentType: "image/png",
        });
      await page.waitForTimeout(70);
    }
    return values;
  };
  const first = await samples();
  expect(first.every((v) => String(v) === "255,0,0,255")).toBe(true);
  await viewer.getByRole("button", { name: "播放动图", exact: true }).click();
  const playing = await samples();
  expect(playing).toContainEqual([255, 0, 0, 255]);
  expect(playing).toContainEqual([0, 255, 0, 255]);
  await viewer.getByRole("button", { name: "暂停动图", exact: true }).click();
  const paused = await samples();
  expect(new Set(paused.map(String)).size).toBe(1);
  await viewer.getByRole("button", { name: "关闭大图", exact: true }).click();
  await expect(body).toBeVisible();
  await expect(page.locator(".body-image")).toBeFocused();
  await info.attach("viewer-frame-values", {
    body: Buffer.from(JSON.stringify({ first, playing, paused })),
    contentType: "application/json",
  });
  await workspace.restart();
  await workspace.open(page);
  expect(
    (await workspace.state()).cards[0]!.body.blocks.some(
      (b) => b.mime === "image/gif",
    ),
  ).toBe(true);
});
