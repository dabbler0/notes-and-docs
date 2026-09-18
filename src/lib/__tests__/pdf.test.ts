import { describe, expect, it } from 'vitest'
import { findPdfMatches } from '../pdf'

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
})
