import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPreference, writePreference } from '../../lib/preferences'
import { canvasOutputScale, INITIAL_READING_PROGRESS, normalizeReadingProgress, readReadingProgress, saveReadingProgress } from './readingProgress'

afterEach(() => vi.unstubAllGlobals())

describe('reading preferences', () => {
  it('normalizes invalid positions and scale without changing the source', () => {
    const source = { page: -2, scale: 100, offset: Infinity, left: -1 }
    expect(normalizeReadingProgress(source)).toEqual({ page: 1, scale: 5, fitWidth: true, offset: 0, left: 0 })
    expect(source.scale).toBe(100)
    expect(normalizeReadingProgress({ page: 10.8, offset: 0.45, left: 0.2 }).page).toBe(10)
  })
  it('isolates positions by document and survives a simulated reload', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } })
    const progress = { page: 28, scale: 2.5, fitWidth: false, offset: 0.34, left: 0.7 }
    saveReadingProgress('book-a', progress)
    expect(readReadingProgress('book-a')).toEqual(progress)
    expect(readReadingProgress('book-b')).toEqual(INITIAL_READING_PROGRESS)
    data.set('broken', '{bad json')
    expect(readPreference('broken', 'fallback')).toBe('fallback')
    data.set('bad-set', '[1,2]')
    expect(readPreference<string[]>('bad-set', [])).toEqual([])
  })
  it('does not break reading if local preferences are unavailable', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('disabled') } })
    expect(() => writePreference('test', 'value')).not.toThrow()
    expect(readReadingProgress('book')).toEqual(INITIAL_READING_PROGRESS)
  })
})

describe('PDF canvas memory budget', () => {
  it('caps high-zoom render surfaces without changing the CSS zoom', () => {
    for (const [width, height] of [[600, 800], [3000, 4200], [9000, 12000]] as const) {
      const scale = canvasOutputScale(width, height, 3)
      expect(width * height * scale * scale).toBeLessThanOrEqual(20_000_001)
      expect(Math.max(width, height) * scale).toBeLessThanOrEqual(8192)
      expect(scale).toBeLessThanOrEqual(2)
    }
  })
})
