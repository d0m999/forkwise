import type { Block } from '../../backend/src/mapping/contracts';
import { useLayoutEffect, useRef } from 'react';

export const BLOCK_OPTIONS: {
  name: string;
  group: string;
  shape: Partial<Block>;
  disabled?: boolean;
}[] = [
  { name: '段落', group: '文字', shape: { type: 'text' } },
  { name: '一级标题', group: '文字', shape: { type: 'heading', level: 1 } },
  { name: '二级标题', group: '文字', shape: { type: 'heading', level: 2 } },
  { name: '三级标题', group: '文字', shape: { type: 'heading', level: 3 } },
  { name: '引用', group: '文字', shape: { type: 'quote' } },
  {
    name: '无序列表',
    group: '列表',
    shape: { type: 'listItem', listType: 'bullet' },
  },
  {
    name: '有序列表',
    group: '列表',
    shape: { type: 'listItem', listType: 'ordered' },
  },
  {
    name: '待办列表',
    group: '列表',
    shape: { type: 'listItem', listType: 'todo', checked: false },
  },
  { name: '图片', group: '媒体', shape: { type: 'imageTask' } },
  { name: '分隔线', group: '其他', shape: { type: 'divider' } },
  {
    name: '简单表格',
    group: '其他',
    shape: {
      type: 'table',
      header: false,
      rows: [
        [{ text: '' }, { text: '' }],
        [{ text: '' }, { text: '' }],
      ],
    },
  },
  {
    name: '代码块',
    group: '其他',
    shape: { type: 'code', language: '', wrap: false },
  },
];
export function BlockMenu({
  options,
  selected,
  convert,
  query,
  slash,
  onQuery,
  onChoose,
  onKeyDown,
  left,
  top,
  explanation,
  children,
}: {
  options: typeof BLOCK_OPTIONS;
  selected: number;
  convert: boolean;
  query: string;
  slash: boolean;
  onQuery: (value: string) => void;
  onChoose: (index: number) => void;
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
  left: number;
  top: number;
  explanation?: string | undefined;
  children?: React.ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    menu.current?.querySelector('[aria-current=true]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, query]);
  return (
    <div
      ref={menu}
      id="block-options"
      className="block-menu"
      role="menu"
      aria-label={convert ? '转换块类型' : '插入块类型'}
      style={{ left, top }}
      onKeyDown={onKeyDown}
    >
      {!slash && (
        <input
          autoFocus
          aria-label="筛选块类型"
          placeholder="筛选块类型"
          aria-controls="block-options"
          aria-activedescendant={options[selected] ? `block-option-${selected}` : undefined}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      )}
      {explanation && <p>{explanation}</p>}
      {children}
      {[...new Set(options.map((o) => o.group))].map((group) => (
        <div className="block-option-group" role="group" aria-label={group} key={group}>
          <span>{group}</span>
          {options.map(
            (item, i) =>
              item.group === group && (
                <button
                  id={`block-option-${i}`}
                  type="button"
                  role="menuitem"
                  tabIndex={i === selected ? 0 : -1}
                  aria-current={i === selected}
                  disabled={item.disabled}
                  key={item.name}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onChoose(i)}
                >
                  {convert ? '转为' : ''}
                  {item.name}
                </button>
              ),
          )}
        </div>
      ))}
      {!options.length && <p>没有匹配的类型</p>}
    </div>
  );
}
