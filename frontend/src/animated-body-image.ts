type Frame = CanvasImageSource & { duration: number | null; close(): void };
type Decoder = {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };
  decode(options: { frameIndex: number }): Promise<{ image: Frame }>;
  close(): void;
};
type DecoderConstructor = new (options: {
  data: ArrayBuffer;
  type: string;
}) => Decoder;

// Decode and draw only the selected frame. Pausing never leaves a hidden <img>
// animation running; every decoded VideoFrame is closed after the canvas draw.
export function animateBodyImage(
  canvas: HTMLCanvasElement,
  preferences: Map<string, boolean>,
) {
  const button = (canvas.closest("[data-gif-scope]") ??
    canvas.parentElement)!.querySelector<HTMLButtonElement>(
    "[data-gif-toggle]",
  )!;
  const key =
    canvas.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ??
    canvas.dataset.gifUrl!;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const abort = new AbortController();
  let decoder: Decoder | undefined,
    disposed = false,
    visible = false,
    generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined,
    index = 0,
    ready = false;
  let playing = false;
  canvas.style.visibility = "hidden";
  function update() {
    const requested = preferences.get(key) ?? !motion.matches;
    const nextPlaying =
      requested &&
      visible &&
      !document.hidden &&
      !canvas.closest("[inert]") &&
      ready;
    button.textContent = requested ? "暂停动图" : "播放动图";
    button.setAttribute("aria-label", requested ? "暂停动图" : "播放动图");
    canvas.dataset.playing = String(nextPlaying);
    if (nextPlaying === playing) return;
    generation++;
    clearTimeout(timer);
    playing = nextPlaying;
    if (playing)
      timer = setTimeout(() => {
        void next(generation);
      }, 120);
  }
  async function draw(frameIndex: number, token: number) {
    const { image } = await decoder!.decode({ frameIndex });
    try {
      if (disposed || (ready && token !== generation)) return 120;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      canvas.style.visibility = "visible";
      return Math.max(20, Number(image.duration ?? 120000) / 1000);
    } finally {
      image.close();
    }
  }
  async function next(token: number) {
    if (!playing || disposed || token !== generation) return;
    index = (index + 1) % decoder!.tracks.selectedTrack.frameCount;
    try {
      const duration = await draw(index, token);
      if (playing && !disposed && token === generation)
        timer = setTimeout(() => {
          void next(token);
        }, duration);
    } catch {
      fail();
    }
  }
  function fail() {
    if (disposed) return;
    generation++;
    clearTimeout(timer);
    playing = false;
    canvas.dataset.playing = "false";
    canvas.style.visibility = "visible";
    button.disabled = true;
    button.textContent = "动图解码失败，原文件仍保留";
    button.setAttribute("aria-label", button.textContent);
  }
  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    preferences.set(key, !(preferences.get(key) ?? !motion.matches));
    update();
  };
  button.addEventListener("click", toggle);
  motion.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0]!;
      visible =
        entry.isIntersecting &&
        entry.intersectionRect.width > 0 &&
        entry.intersectionRect.height > 0;
      update();
    },
    { root: canvas.closest(".board-scroll"), threshold: 0 },
  );
  observer.observe(canvas);
  void (async () => {
    try {
      const response = await fetch(canvas.dataset.gifUrl!, {
        signal: abort.signal,
      });
      if (!response.ok) throw new Error("图片读取失败");
      const data = await response.arrayBuffer();
      if (disposed) return;
      const Constructor = (
        window as unknown as { ImageDecoder?: DecoderConstructor }
      ).ImageDecoder;
      if (!Constructor) {
        const bitmap = await createImageBitmap(
          new Blob([data], { type: "image/gif" }),
        );
        try {
          if (!disposed) {
            canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
            canvas.style.visibility = "visible";
          }
        } finally {
          bitmap.close();
        }
        button.disabled = true;
        button.textContent = "当前浏览器仅显示动图首帧";
        button.setAttribute("aria-label", button.textContent);
        return;
      }
      decoder = new Constructor({ data, type: "image/gif" });
      await decoder.tracks.ready;
      if (disposed) return;
      await draw(0, generation);
      ready = true;
      update();
    } catch {
      if (!disposed) fail();
    }
  })();
  return {
    refresh: update,
    close: () => {
      disposed = true;
      generation++;
      clearTimeout(timer);
      abort.abort();
      observer.disconnect();
      button.removeEventListener("click", toggle);
      motion.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      decoder?.close();
    },
  };
}
