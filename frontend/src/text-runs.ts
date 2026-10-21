import type { TextContent } from "../../backend/src/mapping/text-contracts";
type Run = TextContent["runs"][number];
export function hexColor(value: string): string | undefined {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const rgb = value.match(/^rgba?\((\d+),?\s+(\d+),?\s+(\d+)/);
  return rgb
    ? "#" +
        rgb
          .slice(1, 4)
          .map((part) => Number(part).toString(16).padStart(2, "0"))
          .join("")
    : undefined;
}
export function renderTextRuns(root: HTMLElement, runs: Run[]) {
  root.replaceChildren(
    ...runs.map((run) => {
      const span = document.createElement("span");
      span.textContent = run.text;
      if (run.bold) span.style.fontWeight = "700";
      if (run.color) span.style.color = run.color;
      return span;
    }),
  );
}
export function readTextRuns(root: HTMLElement): Run[] {
  const runs: Run[] = [],
    baseColor = hexColor(getComputedStyle(root).color);
  function append(text: string, bold?: boolean, color?: string) {
    if (!text) return;
    const previous = runs.at(-1);
    if (previous && !!previous.bold === !!bold && previous.color === color)
      previous.text += text;
    else
      runs.push({
        text,
        ...(bold ? { bold: true } : {}),
        ...(color ? { color } : {}),
      });
  }
  function visit(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const style = getComputedStyle(node.parentElement!);
      const color = hexColor(style.color);
      append(
        node.textContent ?? "",
        Number(style.fontWeight) >= 600 || style.fontWeight === "bold",
        color === baseColor ? undefined : color,
      );
    } else if (node.nodeName === "BR") append("\n");
    else {
      if (
        ["DIV", "P"].includes(node.nodeName) &&
        runs.length &&
        !runs.at(-1)!.text.endsWith("\n")
      )
        append("\n");
      node.childNodes.forEach(visit);
    }
  }
  root.childNodes.forEach(visit);
  if (root.lastChild?.nodeName === "BR" && runs.at(-1)?.text.endsWith("\n")) {
    runs.at(-1)!.text = runs.at(-1)!.text.slice(0, -1);
    if (!runs.at(-1)!.text) runs.pop();
  }
  return runs.length ? runs : [{ text: "" }];
}
function plain(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeName === "BR") return "\n";
  return Array.from(node.childNodes).map(plain).join("");
}
export function textRange(root: HTMLElement, range: Range) {
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  return {
    start: plain(before.cloneContents()).length,
    end:
      plain(before.cloneContents()).length +
      plain(range.cloneContents()).length,
  };
}
export function sliceRuns(
  runs: TextContent["runs"],
  start: number,
  end: number,
) {
  let at = 0;
  return runs.flatMap((run) => {
    const from = Math.max(start - at, 0),
      to = Math.min(end - at, run.text.length);
    at += run.text.length;
    return to > from ? [{ ...run, text: run.text.slice(from, to) }] : [];
  });
}
export function selectTextRange(root: HTMLElement, start: number, end: number) {
  const points: { node: Node; offset: number }[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE)
      for (
        let offset = 0;
        offset <= (node.textContent?.length ?? 0);
        offset++
      ) {
        if (!points.length || offset > 0) points.push({ node, offset });
      }
    else if (node.nodeName === "BR") {
      const parent = node.parentNode!;
      points.push({
        node: parent,
        offset: Array.from(parent.childNodes).indexOf(node as ChildNode) + 1,
      });
    } else node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  const range = document.createRange(),
    a = points[start],
    b = points[end];
  if (a && b) {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } else {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
