import { describe, expect, it } from 'vitest'
import { completeTag, joinTagDraft, parseTags, splitTagDraft, suggestTags } from './tags'

describe('shared tag editing', () => {
  it('keeps committed chips separate from the unfinished input without losing it on save', () => {
    expect(splitTagDraft(joinTagDraft(['甲', '乙']))).toEqual({ committed: ['甲', '乙'], draft: '' })
    const value = joinTagDraft(['甲'], '未按回车的标签')
    expect(splitTagDraft(value)).toEqual({ committed: ['甲'], draft: '未按回车的标签' })
    expect(parseTags(value)).toEqual(['甲', '未按回车的标签'])
    expect(splitTagDraft('甲，乙、正在输入')).toEqual({ committed: ['甲', '乙'], draft: '正在输入' })
    expect(joinTagDraft([], '')).toBe('')
  })
  it('accepts common Chinese and English separators and deduplicates', () => {
    expect(parseTags(' 主题A、主题B，主题A; Topic C；主题D\n主题E, ')).toEqual(['主题A', '主题B', 'Topic C', '主题D', '主题E'])
  })
  it('completes only the final token and preserves committed tags', () => {
    expect(completeTag('材料、sp', 'Space')).toBe('材料、Space、')
    expect(completeTag('材料、', '材料')).toBe('材料、')
  })
  it('filters suggestions without case sensitivity, repeated or committed tags', () => {
    expect(suggestTags('材料、sp', ['材料', 'Space', 'Space', '专题'])).toEqual(['Space'])
    expect(suggestTags('', Array.from({ length: 20 }, (_, i) => `标签${i}`))).toHaveLength(8)
  })
})
