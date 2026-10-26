export type SelectionLayoutOperation = 'left' | 'top' | 'horizontal' | 'vertical'

export type SelectionLayoutCard = {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type SelectionLayoutChange = Pick<SelectionLayoutCard, 'id' | 'x' | 'y'>

const minimumExpandedGap = 24
const positionTolerance = 0.000001

/** 只排列传入对象；等距排布空间不足时，从左端或顶端向外扩展。 */
export function layoutSelection(
  cards: readonly SelectionLayoutCard[],
  operation: SelectionLayoutOperation,
): SelectionLayoutChange[] {
  const distribute = operation === 'horizontal' || operation === 'vertical'
  if (cards.length < (distribute ? 3 : 2)) return []
  if (new Set(cards.map(card => card.id)).size !== cards.length) return []
  if (cards.some(card =>
    ![card.x, card.y, card.width, card.height].every(Number.isFinite)
    || card.width < 0 || card.height < 0,
  )) return []

  const horizontal = operation === 'left' || operation === 'horizontal'
  const coordinate = horizontal ? 'x' : 'y'
  const size = horizontal ? 'width' : 'height'
  const start = Math.min(...cards.map(card => card[coordinate]))
  const positions = new Map<string, number>()

  if (!distribute) {
    for (const card of cards) positions.set(card.id, start)
  } else {
    // 相同起点保留输入顺序；按卡片外边缘间距计算，兼容不同尺寸。
    const ordered = cards.map((card, index) => ({ card, index }))
      .sort((a, b) => a.card[coordinate] - b.card[coordinate] || a.index - b.index)
    const end = Math.max(...cards.map(card => card[coordinate] + card[size]))
    const occupied = cards.reduce((sum, card) => sum + card[size], 0)
    const availableGap = (end - start - occupied) / (cards.length - 1)
    // 负间距会保留重叠，此时牺牲末端边界，使用可见间隔展开。
    const gap = availableGap < 0 ? minimumExpandedGap : availableGap
    let cursor = start
    for (const { card } of ordered) {
      positions.set(card.id, cursor)
      cursor += card[size] + gap
    }
  }

  return cards.flatMap(card => {
    const position = positions.get(card.id)!
    if (Math.abs(position - card[coordinate]) <= positionTolerance) return []
    return [{ id: card.id, x: horizontal ? position : card.x, y: horizontal ? card.y : position }]
  })
}
