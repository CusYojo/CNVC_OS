export type WorkbenchQuotation = {
  id: string
  text: string
}

// Original work messages, not attributed quotations. Playback stays entirely local.
export const WORKBENCH_QUOTES: readonly WorkbenchQuotation[] = [
  { id: 'shared-journey', text: '做精品创投，与伟大企业同行。' },
  { id: 'trust', text: '以专业赢得信任，以陪伴创造价值。' },
  { id: 'daily-work', text: '认真做好今天的事，耐心创造长期的价值。' },
  { id: 'hard-times', text: '陪企业走过难关，比在顺境中喝彩更重要。' },
  { id: 'commitment', text: '把每一次承诺，变成可靠的行动。' },
  { id: 'founders', text: '看见创业者的远志，也关心眼前的难题。' },
  { id: 'small-steps', text: '今天多解决一个问题，企业就能多前进一步。' },
  { id: 'patience', text: '好企业值得耐心，也值得全力以赴。' },
  { id: 'value', text: '不只发现价值，更与企业一起创造价值。' },
  { id: 'craft', text: '把平凡的工作做扎实，让重要的事有结果。' },
  { id: 'care', text: '每一次认真跟进，都是对信任的回应。' },
  { id: 'conviction', text: '看准方向，踏实做事，陪伴企业走得更远。' },
  { id: 'early-belief', text: '在企业尚小时看见它，在成长路上支持它。' },
  { id: 'technology', text: '支持真正的创新，陪硬科技走向更大舞台。' },
  { id: 'teamwork', text: '彼此补位，一起把难事做成。' },
  { id: 'judgement', text: '让每一次判断有依据，让每一份支持有分量。' },
  { id: 'resolve', text: '面对难题多走一步，就是今天的进步。' },
  { id: 'long-term', text: '不急于一时的掌声，专注值得长期做的事。' },
  { id: 'companionship', text: '与优秀的创业者同行，把远大愿景变成现实。' },
  { id: 'future', text: '今天的用心，终会成为企业成长的一份力量。' },
]

export const QUOTE_INTERVAL_MS = 15_000
export type QuoteRotation = { order: readonly number[]; cursor: number; previous: number | null }

export function createQuoteRotation(random = Math.random, previous: number | null = null): QuoteRotation {
  const order = WORKBENCH_QUOTES.map((_, index) => index)
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[order[index], order[other]] = [order[other], order[index]]
  }
  // A newly shuffled round must not immediately repeat the last visible quote.
  if (order[0] === previous) [order[0], order[1]] = [order[1], order[0]]
  return { order, cursor: 0, previous }
}

export function advanceQuoteRotation(rotation: QuoteRotation, random = Math.random): QuoteRotation {
  const previous = rotation.order[rotation.cursor]
  return rotation.cursor + 1 < rotation.order.length
    ? { ...rotation, cursor: rotation.cursor + 1, previous }
    : createQuoteRotation(random, previous)
}
