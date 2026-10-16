import { test, expect, place } from "./writing-board-fixture";
import {
  createCanvas,
  loadImage,
} from "../../backend/node_modules/@napi-rs/canvas/index.js";
import { twoFrameGif } from "./image-reading-fixtures";
test.use({ actionTimeout: 6000 });
test("真实双帧GIF播放像素改变、暂停/离屏停止、reduced-motion默认暂停且可明确播放", async ({
  page,
  workspace,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await place(page, "动图阅读");
  await page.getByRole("button", { name: "编辑正文", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "卡片正文", exact: true });
  await editor.click();
  await page.getByRole("button", { name: "插入块", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "图片", exact: true }).click();
  await (
    await chooser
  ).setFiles({
    name: "双帧红绿.gif",
    mimeType: "image/gif",
    buffer: twoFrameGif(),
  });
  await expect(page.getByRole("status")).toHaveText("已保存到本机");
  await expect(
    page.getByRole("button", { name: "播放动图", exact: true }),
  ).toBeVisible();
  const frame = page.locator(".body-image canvas");
  await expect(frame).toBeVisible();
  const pixel = () =>
    frame.evaluate((c: HTMLCanvasElement) =>
      Array.from(c.getContext("2d")!.getImageData(20, 20, 1, 1).data),
    );
  let sample = 0;
  const samples = async (visible = true) => {
    const values: number[][] = [];
    for (let i = 0; i < 9; i++) {
      if (visible) {
        const screenshot = await frame.screenshot();
        const image = await loadImage(screenshot),
          canvas = createCanvas(image.width, image.height);
        canvas.getContext("2d").drawImage(image, 0, 0);
        const value = Array.from(
          canvas.getContext("2d").getImageData(40, 30, 1, 1).data,
        );
        values.push(value);
        if (
          i === 0 ||
          (values.length > 1 && String(values.at(-2)) !== String(value))
        )
          await info.attach(`visible-gif-${sample++}`, {
            body: screenshot,
            contentType: "image/png",
          });
      } else values.push(await pixel());
      await page.waitForTimeout(70);
    }
    return values;
  };
  const first = await samples();
  expect(new Set(first.map(String)).size).toBe(1);
  expect(first[0]).toEqual([255, 0, 0, 255]);
  const revision = (await workspace.state()).project.revision;
  await page.getByRole("button", { name: "播放动图", exact: true }).click();
  const playing = await samples();
  expect(playing).toContainEqual([255, 0, 0, 255]);
  expect(playing).toContainEqual([0, 255, 0, 255]);
  await page.getByRole("button", { name: "暂停动图", exact: true }).click();
  const paused = await samples();
  expect(new Set(paused.map(String)).size).toBe(1);
  await page.getByRole("button", { name: "播放动图", exact: true }).click();
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".board-scroll")!;
    const spacer = document.createElement("div");
    spacer.style.height = "1600px";
    scroller.append(spacer);
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(frame).not.toBeInViewport();
  await page.waitForTimeout(150);
  const offscreen = await samples(false);
  expect(new Set(offscreen.map(String)).size).toBe(1);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".board-scroll")!.scrollTop = 0;
  });
  await expect(frame).toBeInViewport();
  const returned = await samples();
  expect(new Set(returned.map(String)).size).toBe(2);
  expect((await workspace.state()).project.revision).toBe(revision);
  await info.attach("actual-gif-pixels", {
    body: Buffer.from(
      JSON.stringify({ first, playing, paused, offscreen, returned }),
    ),
    contentType: "application/json",
  });
});
