import { describe, expect, it } from 'vitest'
import { buildSearchRegex, findPdfMatches } from '../pageSearchCore'

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
