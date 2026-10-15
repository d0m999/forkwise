import { useState } from 'react';
import { safeLink } from '../../backend/src/mapping/general-blocks';

export function LinkPopover({
  url,
  text,
  preview,
  readOnly,
  left,
  top,
  onApply,
  onRemove,
  onCancel,
}: {
  url: string;
  text: string;
  preview: boolean;
  readOnly: boolean;
  left: number;
  top: number;
  onApply: (url: string, text: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [editing, setEditing] = useState(!preview),
    [address, setAddress] = useState(url),
    [label, setLabel] = useState(text),
    [error, setError] = useState('');
  return (
    <div
      className="link-popover"
      role="dialog"
      aria-label={editing ? '编辑链接' : '链接预览'}
      style={{ left, top }}
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (!e.nativeEvent.isComposing && e.keyCode !== 229 && e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!safeLink(address)) {
              setError('请输入 http、https 或 mailto 链接');
              return;
            }
            onApply(address, label || address);
          }}
        >
          <label>
            链接地址
            <input
              autoFocus
              aria-label="链接地址"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
          </label>
          <label>
            显示文字
            <input
              aria-label="显示文字"
              value={label}
              placeholder={address || '默认使用地址'}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <button type="submit">应用链接</button>
          <button type="button" onClick={onCancel}>
            取消链接
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      ) : (
        <>
          <p>{url}</p>
          <a href={url} target="_blank" rel="noopener noreferrer">
            打开链接
          </a>
          <button type="button" disabled={readOnly} onClick={() => setEditing(true)}>
            编辑链接
          </button>
          <button type="button" disabled={readOnly} onClick={onRemove}>
            移除链接
          </button>
          <button type="button" onClick={onCancel}>
            关闭链接预览
          </button>
          {readOnly && <p>此内容中的链接暂时只读</p>}
        </>
      )}
    </div>
  );
}
