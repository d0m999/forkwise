import { readFile, access } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface SearchLanguage {
  convert: (text: string) => string;
  cut: (text: string) => string[];
}

function converter(bytes: Uint8Array): SearchLanguage['convert'] {
  const exports: { Converter?: (options: { from: string; to: string }) => SearchLanguage['convert'] } = {};
  runInNewContext(new TextDecoder().decode(bytes), { exports, module: { exports } }, { timeout: 2000 });
  const convert = exports.Converter?.({ from: 't', to: 'cn' });
  if (!convert) throw new Error('文字规范化不可用');
  return convert;
}

let historyConvert: SearchLanguage['convert'] | undefined;
// Synchronous commands use the same trusted local normalization asset. History
// identity preserves query syntax and never depends on segmentation results.
export function normalizeHistoryText(text: string) {
  if (!historyConvert) {
    const built = new URL('../../search-vendor/', import.meta.url);
    const directory = existsSync(new URL('NOTICE-search.txt', built)) ? built
      : new URL('../../../prototype/open-canvas-r2-20261011/vendor/', import.meta.url);
    historyConvert = converter(readFileSync(new URL('opencc-t2cn.js', directory)));
  }
  return foldText(text, { convert: historyConvert, cut: () => [] }).text;
}

// The only source assets remain the licensed R2 vendor files. A distribution
// contains the same files in its build output, never a second source dependency.
async function vendorDirectory(): Promise<URL> {
  const built = new URL('../../search-vendor/', import.meta.url);
  try {
    await access(new URL('NOTICE-search.txt', built));
    return built;
  } catch {
    return new URL('../../../prototype/open-canvas-r2-20261011/vendor/', import.meta.url);
  }
}

export type SearchAssetReader = (url: URL) => Promise<Uint8Array>;
export class SearchLibraries {
  private current:
    | Promise<{ language: SearchLanguage | null; normalization: boolean; segmentation: boolean }>
    | undefined;
  private failed = false;
  private loading = false;
  constructor(private readonly read: SearchAssetReader = readFile) {}
  load(retry = false) {
    if (retry && this.failed && !this.loading) this.current = undefined;
    if (this.current) return this.current;
    this.loading = true;
    this.current = this.initialize().finally(() => {
      this.loading = false;
    });
    return this.current;
  }
  private async initialize() {
    const directory = await vendorDirectory();
    let convert: SearchLanguage['convert'] | undefined, cut: SearchLanguage['cut'] | undefined;
    try {
      convert = converter(await this.read(new URL('opencc-t2cn.js', directory)));
    } catch {
      /* A missing/corrupt local library is reported as a capability failure. */
    }
    try {
      const bytes = await this.read(new URL('jieba/jieba_rs_wasm_bg.wasm', directory));
      // The shared browser asset has ESM syntax but its prototype package is
      // CommonJS. Load these trusted local module bytes explicitly as ESM;
      // passing WASM bytes avoids the module's relative-fetch default.
      const script = await this.read(new URL('jieba/jieba_rs_wasm.js', directory));
      const moduleUrl = `data:text/javascript;base64,${Buffer.from(script).toString('base64')}#${randomUUID()}`;
      const jieba = (await import(moduleUrl)) as {
        default: (input: { module_or_path: Uint8Array }) => Promise<unknown>;
        add_word: (word: string, frequency: number) => void;
        cut: (text: string, hmm: boolean) => string[];
      };
      await jieba.default({ module_or_path: bytes });
      for (const word of ['多头', '空头', '平仓', '回补', '比特币', '资金费率', '美联储', '半导体'])
        jieba.add_word(word, 1000000);
      cut = (text) => jieba.cut(text, true);
    } catch {
      /* Retry performs a real read and a fresh WASM instantiation. */
    }
    this.failed = !convert || !cut;
    return {
      normalization: !!convert,
      segmentation: !!cut,
      language: convert
        ? {
            convert,
            cut:
              cut ??
              (() => {
                throw new Error('中文分词不可用');
              }),
          }
        : null,
    };
  }
}

export interface FoldedText {
  text: string;
  starts: number[];
  ends: number[];
}
export function foldText(text: string, language: SearchLanguage): FoldedText {
  const result: FoldedText = { text: '', starts: [], ends: [] };
  let offset = 0;
  for (const character of text) {
    // Width/case rules apply only to Latin letters and digits, not punctuation,
    // whitespace or arbitrary compatibility characters. Every emitted UTF-16
    // unit maps to the exact original code point; no second conversion pass.
    const width = character.replace(/[Ａ-Ｚａ-ｚ０-９]/gu, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    );
    const folded = language.convert(width).replace(/[A-Z]/g, (c) => c.toLowerCase());
    result.text += folded;
    for (let i = 0; i < folded.length; i++) {
      result.starts.push(offset);
      result.ends.push(offset + character.length);
    }
    offset += character.length;
  }
  return result;
}

// Scan quote syntax before normalization or segmentation. History needs the
// exact phrase structure/closure; matching separately decides whether to cut.
export function lexSearch(text: string) {
  const pieces: { text: string; phrase: boolean; closed: boolean }[] = [];
  const input = text.trimStart();
  let index = 0,
    separated = false,
    unclosedQuote = false;
  while (index < input.length) {
    if (/\s/u.test(input[index]!)) {
      while (index < input.length && /\s/u.test(input[index]!)) index++;
      if (index < input.length) separated = true;
      continue;
    }
    const opening = input[index];
    if (opening === '"' || opening === '“') {
      const closing = opening === '"' ? '"' : '”';
      const start = ++index;
      while (index < input.length && input[index] !== closing) index++;
      const value = input.slice(start, index);
      if (value.trim()) pieces.push({ text: value, phrase: true, closed: index < input.length });
      if (index === input.length) unclosedQuote = true;
      else index++;
    } else {
      const start = index++;
      while (index < input.length && !/[\s"“]/u.test(input[index]!)) index++;
      pieces.push({ text: input.slice(start, index), phrase: false, closed: true });
    }
  }
  return { pieces, separated, unclosedQuote };
}

export function parseSearch(text: string, language: SearchLanguage, literal = false) {
  const { pieces, separated, unclosedQuote } = lexSearch(text);
  const units = pieces.flatMap(({ text, phrase }) => {
    const piece = { text, phrase };
    if (literal || piece.phrase || separated || !/\p{Script=Han}/u.test(piece.text)) return [piece];
    const folded = foldText(piece.text, language);
    let offset = 0;
    const tokens = language.cut(folded.text).map((word) => {
      // Jieba must preserve the complete input. Reject inconsistent output
      // instead of losing a negation, unknown word or punctuation silently.
      if (!word.length || folded.text.slice(offset, offset + word.length) !== word)
        throw new Error('中文分词未完整保留输入');
      const start = offset;
      offset += word.length;
      return {
        text: piece.text.slice(folded.starts[start], folded.ends[offset - 1]),
        phrase: false,
      };
    });
    if (offset !== folded.text.length) throw new Error('中文分词未完整保留输入');
    return tokens;
  });
  return { input: text, units, unclosedQuote };
}
