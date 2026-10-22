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
  preferenceKey?: string,
) {
  const button = (canvas.closest("[data-gif-scope]") ??
    canvas.parentElement)!.querySelector<HTMLButtonElement>(
    "[data-gif-toggle]",
  )!;
  const key =
    preferenceKey ??
    canvas.closest<HTMLElement>("[data-block-id]")?.dataset.blockId ??
    canvas.dataset.gifUrl!;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let abort = new AbortController();
  let loadVersion = 0,
    failed = false;
  let failure: HTMLSpanElement | undefined;
  let decoder: Decoder | undefined,
    disposed = false,
    visible = false,
    generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined,
    index = 0,
    ready = false;
  let playing = false;
  function label(state: 'play' | 'pause' | 'loading' | 'retry' | 'still', text: string) {
    // Shared React controls keep their Lucide children; legacy body controls
    // remain plain text. Both paths retain the same playback policy.
    (button.querySelector('[data-gif-label]') ?? button).textContent = text;
    button.dataset.gifState = state;
    button.setAttribute('aria-label', text);
  }
  canvas.style.visibility = "hidden";
  function update() {
    if (failed || !ready) return;
    const requested = preferences.get(key) ?? !motion.matches;
    const nextPlaying =
      requested &&
      visible &&
      !document.hidden &&
      !canvas.closest("[inert]") &&
      ready;
    label(requested ? 'pause' : 'play', requested ? '暂停动图' : '播放动图');
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
      if (disposed || token !== generation) return 120;
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
      if (!disposed && token === generation) fail();
    }
  }
  function fail() {
    if (disposed) return;
    failed = true;
    generation++;
    clearTimeout(timer);
    playing = false;
    ready = false;
    abort.abort();
    decoder?.close();
    decoder = undefined;
    canvas.dataset.playing = "false";
    canvas.style.visibility = "visible";
    button.disabled = false;
    label('retry', '重新加载动图');
    if (!failure) {
      failure = document.createElement("span");
      failure.className = "image-load-error";
      failure.setAttribute("role", "alert");
      failure.textContent = "动图加载失败，原文件仍保留";
      canvas.parentElement!.append(failure);
    }
  }
  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    if (failed) {
      void load();
      return;
    }
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
  async function load() {
    const version = ++loadVersion;
    failed = false;
    generation++;
    clearTimeout(timer);
    playing = false;
    ready = false;
    abort.abort();
    abort = new AbortController();
    decoder?.close();
    decoder = undefined;
    failure?.remove();
    failure = undefined;
    button.disabled = true;
    label('loading', '正在加载动图');
    canvas.dataset.playing = "false";
    canvas.style.visibility = "hidden";
    try {
      const response = await fetch(canvas.dataset.gifUrl!, {
        signal: abort.signal,
      });
      if (!response.ok) throw new Error("图片读取失败");
      const data = await response.arrayBuffer();
      if (disposed || version !== loadVersion) return;
      const Constructor = (
        window as unknown as { ImageDecoder?: DecoderConstructor }
      ).ImageDecoder;
      if (!Constructor) {
        const bitmap = await createImageBitmap(
          new Blob([data], { type: "image/gif" }),
        );
        try {
          if (!disposed && version === loadVersion) {
            canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
            canvas.style.visibility = "visible";
          }
        } finally {
          bitmap.close();
        }
        if (disposed || version !== loadVersion) return;
        button.disabled = true;
        label('still', '当前浏览器仅显示动图首帧');
        return;
      }
      decoder = new Constructor({ data, type: "image/gif" });
      await decoder.tracks.ready;
      if (disposed || version !== loadVersion) return;
      await draw(0, generation);
      if (disposed || version !== loadVersion) return;
      ready = true;
      button.disabled = false;
      update();
    } catch {
      if (!disposed && version === loadVersion) fail();
    }
  }
  void load();
  return {
    refresh: update,
    close: () => {
      disposed = true;
      loadVersion++;
      generation++;
      clearTimeout(timer);
      abort.abort();
      observer.disconnect();
      button.removeEventListener("click", toggle);
      motion.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
      decoder?.close();
      failure?.remove();
    },
  };
}
