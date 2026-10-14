import type { Page } from "@playwright/test";
import type { Draft } from "../src/draft-recovery";

export interface BodyInputObservation {
  type: string;
  inputType: string;
  key: string;
  trusted: boolean;
  clock: number;
  elapsed: number;
  text: string;
  selection: {
    blockId: string;
    start: number;
    end: number;
    text: string;
  } | null;
  drafts: Draft[];
}

// Observe browser events and the public recovery journal; never replace the
// editor's handlers, storage writes, clock, or requests in this observer.
export async function observeBodyInput(page: Page) {
  await page.evaluate(() => {
    const observations: BodyInputObservation[] = [];
    (window as any).__forkwiseBodyInputs = observations;
    const capture = (event: Event) => {
      const editor = document.querySelector<HTMLElement>(".paragraph-editor");
      if (!editor) return;
      const selection = getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (event.type === "selectionchange") {
        if (!range || !editor.contains(range.startContainer)) return;
      } else if (
        !(event.target instanceof Node) ||
        !editor.contains(event.target)
      )
        return;
      const block =
        range &&
        (range.startContainer.nodeType === Node.ELEMENT_NODE
          ? (range.startContainer as Element)
          : range.startContainer.parentElement
        )?.closest<HTMLElement>("[data-block-id]");
      const drafts = Object.keys(localStorage)
        .filter((key) => key.startsWith("forkwise:recovery:v1:"))
        .flatMap((key) => {
          const recovery = JSON.parse(localStorage.getItem(key)!);
          return [
            ...recovery.drafts,
            ...recovery.closed,
            ...(recovery.pending ? [recovery.pending] : []),
          ];
        });
      observations.push({
        type: event.type,
        inputType: (event as InputEvent).inputType ?? "",
        key: (event as KeyboardEvent).key ?? "",
        trusted: event.isTrusted,
        clock: Date.now(),
        elapsed: performance.now(),
        text: editor.innerText,
        selection:
          range && block
            ? {
                blockId: block.dataset.blockId!,
                start: range.startOffset,
                end: range.endOffset,
                text: range.toString(),
              }
            : null,
        drafts,
      });
    };
    for (const type of [
      "beforeinput",
      "input",
      "selectionchange",
      "keyup",
      "pointerup",
      "focusin",
      "focusout",
    ])
      document.addEventListener(type, capture, type === "beforeinput");
  });
}

export async function bodyInputObservations(
  page: Page,
): Promise<BodyInputObservation[]> {
  return page.evaluate(() => (window as any).__forkwiseBodyInputs ?? []);
}
