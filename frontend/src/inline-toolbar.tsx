import { useEffect, useState } from 'react';
import {
  HIGHLIGHTS,
  TEXT_COLORS,
  safeLink,
  type InlineMark,
} from '../../backend/src/mapping/general-blocks';

export function InlineToolbar({
  onFormat,
  onCancel,
  left,
  top,
  linkInitially = false,
}: {
  onFormat: (type: InlineMark['type'], value?: string) => void;
  onCancel: () => void;
  left: number;
  top: number;
  linkInitially?: boolean;
}) {
  const [panel, setPanel] = useState<'more' | 'color' | 'link' | null>(
    linkInitially ? 'link' : null,
  );
  const [url, setUrl] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    if (linkInitially) setPanel('link');
  }, [linkInitially]);
  const names: Record<string, string> = {
    default: '默认',
    gray: '灰色',
    red: '红色',
    orange: '橙色',
    green: '绿色',
    blue: '蓝色',
    purple: '紫色',
    yellow: '黄色',
    pink: '粉色',
  };
  const apply = (type: InlineMark['type'], value?: string) => {
    onFormat(type, value);
    setPanel(null);
  };
  return (
    <div
      className="inline-toolbar"
      role="toolbar"
      aria-label="文字格式"
      style={{ left, top }}
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          if (panel) setPanel(null);
          else onCancel();
        }
      }}
    >
      <button type="button" onClick={() => apply('bold')}>
        加粗
      </button>
      <button type="button" onClick={() => apply('italic')}>
        斜体
      </button>
      <button type="button" onClick={() => setPanel('link')}>
        链接
      </button>
      <button
        type="button"
        aria-label="文字颜色"
        onClick={() => setPanel(panel === 'color' ? null : 'color')}
      >
        颜色
      </button>
      <button
        type="button"
        aria-label="格式更多"
        onClick={() => setPanel(panel === 'more' ? null : 'more')}
      >
        更多
      </button>
      {panel === 'more' && (
        <div className="format-panel">
          <button type="button" onClick={() => apply('underline')}>
            下划线
          </button>
          <button type="button" onClick={() => apply('strikethrough')}>
            删除线
          </button>
          <button type="button" onClick={() => apply('code')}>
            行内代码
          </button>
          {HIGHLIGHTS.map((color) => (
            <button
              type="button"
              key={color}
              className={`highlight-${color}`}
              onClick={() => apply('highlight', color)}
            >
              {names[color]}高亮
            </button>
          ))}
        </div>
      )}
      {panel === 'color' && (
        <div className="format-panel">
          {TEXT_COLORS.map((color) => (
            <button
              type="button"
              key={color}
              className={`textColor-${color}`}
              onClick={() => apply('textColor', color)}
            >
              {names[color]}文字
            </button>
          ))}
        </div>
      )}
      {panel === 'link' && (
        <form
          className="format-panel"
          onSubmit={(e) => {
            e.preventDefault();
            if (!safeLink(url)) {
              setError('请输入 http、https 或 mailto 链接');
              return;
            }
            apply('link', url);
          }}
        >
          <label>
            链接地址
            <input
              autoFocus
              aria-label="链接地址"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <button type="submit">应用链接</button>
          <button
            type="button"
            onClick={() => {
              setPanel(null);
              onCancel();
            }}
          >
            取消链接
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}
