import { describe, expect, it } from 'vitest'
import { completeTag, parseTags, suggestTags } from './tags'

describe('shared tag editing', () => {
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
