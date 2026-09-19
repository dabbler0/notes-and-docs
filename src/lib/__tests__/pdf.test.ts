import { describe, expect, it } from 'vitest'
import { buildSearchRegex, findPdfMatches, reflowTextItems } from '../pdf'

/** A fake pdf.js text item — `transform` is `[scaleX, skewY, skewX, scaleY, x, y]`; only the font-height (`scaleY` here, via `Math.hypot(scaleX-ish, scaleY)`) and baseline `y` matter to `reflowTextItems`. */
function item(str: string, y: number, height = 10) {
  return { str, transform: [height, 0, 0, height, 0, y] }
}

describe('findPdfMatches', () => {
  it('finds a single occurrence on a single page', () => {
    const matches = findPdfMatches(['the quick brown fox'], 'quick')
    expect(matches).toEqual([{ page: 1, indexInPage: 0 }])
  })

  it('is case-insensitive', () => {
    const matches = findPdfMatches(['The Quick Brown Fox'], 'quick')
    expect(matches).toEqual([{ page: 1, indexInPage: 0 }])
  })

  it('finds multiple non-overlapping occurrences on one page, in order', () => {
    const matches = findPdfMatches(['cat cat cat'], 'cat')
    expect(matches).toEqual([
      { page: 1, indexInPage: 0 },
      { page: 1, indexInPage: 1 },
      { page: 1, indexInPage: 2 },
    ])
  })

  it('spans multiple pages in document order, resetting indexInPage per page', () => {
    const matches = findPdfMatches(['fox here', 'no match', 'fox and fox again'], 'fox')
    expect(matches).toEqual([
      { page: 1, indexInPage: 0 },
      { page: 3, indexInPage: 0 },
      { page: 3, indexInPage: 1 },
    ])
  })

  it('returns nothing for a blank or whitespace-only query', () => {
    expect(findPdfMatches(['some text'], '')).toEqual([])
    expect(findPdfMatches(['some text'], '   ')).toEqual([])
  })

  it('returns nothing for a document with no pages', () => {
    expect(findPdfMatches([], 'anything')).toEqual([])
  })

  it('returns nothing when the query does not appear', () => {
    expect(findPdfMatches(['the quick brown fox'], 'zebra')).toEqual([])
  })

  it('finds a match whose query has a space where the text has a line break', () => {
    // e.g. "first\nsecond" (a real line break reflowTextItems preserves) —
    // a query typed as "first second" should still find it.
    const matches = findPdfMatches(['This is the first\nsecond line of a page.'], 'first second')
    expect(matches).toEqual([{ page: 1, indexInPage: 0 }])
  })

  it('finds a match whose query has a space where the text has a paragraph break', () => {
    const matches = findPdfMatches(['End of one paragraph.\n\nStart of the next.'], 'paragraph. start')
    expect(matches).toEqual([{ page: 1, indexInPage: 0 }])
  })
})

describe('buildSearchRegex', () => {
  it('returns null for a blank query', () => {
    expect(buildSearchRegex('')).toBeNull()
    expect(buildSearchRegex('   ')).toBeNull()
  })

  it('escapes regex special characters in the query', () => {
    const regex = buildSearchRegex('a.b*c?')
    expect(regex).not.toBeNull()
    expect('xa.b*c?y'.match(regex!)?.[0]).toBe('a.b*c?')
    expect('xaXbYcZy'.match(regex!)).toBeNull()
  })

  it('is case-insensitive', () => {
    expect('HELLO'.match(buildSearchRegex('hello')!)?.[0]).toBe('HELLO')
  })
})

describe('reflowTextItems', () => {
  it('joins items on the same line with a single space', () => {
    const items = [item('Hello', 700), item('world.', 700)]
    expect(reflowTextItems(items)).toBe('Hello world.')
  })

  it('inserts a single line break for a real line break in the source document', () => {
    const items = [item('Line one.', 700), item('Line two, same paragraph.', 688)] // gap 12: 0.3*height (3) < 12 <= 1.6*height (16)
    expect(reflowTextItems(items)).toBe('Line one.\nLine two, same paragraph.')
  })

  it('inserts a paragraph break across a large vertical gap', () => {
    const items = [item('First paragraph.', 700), item('Second paragraph.', 660)] // gap 40 > 16
    expect(reflowTextItems(items)).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('handles more than one paragraph break', () => {
    const items = [item('First.', 700), item('Second.', 660), item('Third.', 620)]
    expect(reflowTextItems(items)).toBe('First.\n\nSecond.\n\nThird.')
  })

  it('handles a mix of same-line words, a line break, and a paragraph break', () => {
    const items = [item('One', 700), item('two', 700), item('three.', 688), item('New paragraph.', 640)]
    expect(reflowTextItems(items)).toBe('One two\nthree.\n\nNew paragraph.')
  })

  it('skips items with no string content', () => {
    const items = [item('Hello', 700), { transform: [10, 0, 0, 10, 0, 700] }, item('', 700), item('world.', 700)]
    expect(reflowTextItems(items)).toBe('Hello world.')
  })

  it('returns an empty string for no items', () => {
    expect(reflowTextItems([])).toBe('')
  })

  it('trims the result and collapses runs of internal spaces', () => {
    const items = [item('  Hello  ', 700), item('world.  ', 700)]
    expect(reflowTextItems(items)).toBe('Hello world.')
  })
})
