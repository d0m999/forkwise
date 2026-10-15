import type { Block } from '../../backend/src/mapping/contracts';

export function CodeTools({
  code,
  onChange,
  onParagraph,
  onCopy,
}: {
  code: Block;
  onChange: (code: Block) => void;
  onParagraph: () => void;
  onCopy: () => void;
}) {
  const languages = [
    '',
    'javascript',
    'typescript',
    'python',
    'sql',
    'json',
    'html',
    'css',
    'bash',
    'markdown',
    'mermaid',
  ];
  const language = String(code.language);
  if (!languages.includes(language)) languages.push(language);
  return (
    <div
      className="code-tools"
      role="group"
      aria-label="代码操作"
      onKeyDown={(event) => event.stopPropagation()}
    >
      <label>
        语言{' '}
        <select
          aria-label="代码语言"
          value={language}
          onChange={(event) => onChange({ ...code, language: event.target.value })}
        >
          {languages.map((value) => (
            <option key={value} value={value}>
              {value || '纯文本'}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        aria-pressed={!!code.wrap}
        onClick={() => onChange({ ...code, wrap: !code.wrap })}
      >
        自动换行
      </button>
      <button type="button" onClick={onCopy}>
        复制代码
      </button>
      <button type="button" onClick={onParagraph}>
        在代码下方插入段落
      </button>
      <span>Tab 缩进 · Esc 退出输入 · ⌘/Ctrl+Enter 下方段落</span>
    </div>
  );
}
