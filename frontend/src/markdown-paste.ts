import type { Block } from '../../backend/src/mapping/contracts';
import { safeLink, type InlineMark } from '../../backend/src/mapping/general-blocks';

export function markdownInline(value: string): { text: string; marks?: InlineMark[] } {
  const pattern =
    /\\[\\`*_~\[\]]|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|`([^`\n]+)`|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let text = '',
    consumed = 0;
  const marks: InlineMark[] = [];
  for (const match of value.matchAll(pattern)) {
    text += value.slice(consumed, match.index);
    const raw = match[0],
      start = text.length;
    if (raw.startsWith('\\')) text += raw.slice(1);
    else if (match[1] !== undefined && !safeLink(match[2]!)) text += raw;
    else {
      const group = match.slice(1).findIndex((v, i) => i !== 1 && v !== undefined) + 1;
      const content = match[group]!;
      text += content;
      const type: InlineMark['type'] =
        group === 1
          ? 'link'
          : group === 3 || group === 4
            ? 'bold'
            : group === 5
              ? 'strikethrough'
              : group === 6
                ? 'code'
                : 'italic';
      marks.push({
        type,
        start,
        end: text.length,
        ...(type === 'link' ? { value: match[2]! } : {}),
      });
    }
    consumed = match.index! + raw.length;
  }
  text += value.slice(consumed);
  return { text, ...(marks.length ? { marks } : {}) };
}

// This whole-text parser is reachable only through explicit Markdown paste.
export function markdownBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'),
    blocks: Block[] = [];
  const parents: { indent: number; id: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!,
      identity = { id: crypto.randomUUID(), inlineId: crypto.randomUUID() };
    const fence = line.match(/^(`{3,}|~{3,})([\w+-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      while (
        i + 1 < lines.length &&
        !new RegExp(`^${fence[1]![0]}{${fence[1]!.length},}\\s*$`).test(lines[i + 1]!)
      )
        code.push(lines[++i]!);
      if (i + 1 < lines.length) i++;
      blocks.push({
        ...identity,
        type: 'code',
        text: code.join('\n'),
        language: fence[2]!,
        wrap: false,
      });
      parents.length = 0;
      continue;
    }
    const heading = line.match(/^(#{1,3}) (.*)$/),
      quote = line.match(/^> ?(.*)$/),
      list = line.match(/^(\s*)([-+*]|\d+[.)]) (?:\[([ xX])\] )?(.*)$/);
    if (list) {
      const indent = list[1]!.replaceAll('\t', '    ').length;
      while (parents.length && parents.at(-1)!.indent >= indent) parents.pop();
      blocks.push({
        ...identity,
        type: 'listItem',
        listType: list[3] !== undefined ? 'todo' : /^\d/.test(list[2]!) ? 'ordered' : 'bullet',
        ...(list[3] !== undefined ? { checked: list[3]!.toLowerCase() === 'x' } : {}),
        ...(parents.length ? { parentId: parents.at(-1)!.id } : {}),
        ...markdownInline(list[4]!),
      });
      parents.push({ indent, id: identity.id });
      continue;
    }
    parents.length = 0;
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) blocks.push({ ...identity, type: 'divider' });
    else
      blocks.push({
        ...identity,
        type: heading ? 'heading' : quote ? 'quote' : 'text',
        ...(heading ? { level: heading[1]!.length } : {}),
        ...markdownInline(heading?.[2] ?? quote?.[1] ?? line),
      });
  }
  return blocks;
}
