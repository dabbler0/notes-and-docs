import { describe, expect, it } from 'vitest'
import { computeQuoteRangesPerItem, renderHighlightedSpan, type ItemHighlightRange } from '../pdfTextLayer'
import type { SelectableTextItem } from '../pdfSelection'

/** Same `{str, transform}` shape `PdfViewer`'s own text items carry — only
 * `transform[5]` (the baseline y) and the item string actually matter for
 * the gap heuristic `computeQuoteRangesPerItem` joins items with. */
function item(str: string, y: number, height = 10): SelectableTextItem {
  return { str, transform: [height, 0, 0, height, 0, y] }
}

describe('computeQuoteRangesPerItem', () => {
  it('finds a quote that sits entirely within one item', () => {
    const items = [item('Hello world.', 700)]
    const ranges = computeQuoteRangesPerItem(items, [{ quoteText: 'world', annotation: '' }])
    expect(ranges.get(0)).toEqual([{ start: 6, end: 11, kind: 'quote', title: undefined }])
  })

  it('finds a quote spanning two same-line items, splitting the highlight across both', () => {
    // 'The quick' / 'brown fox' on one line, joined with a space by the gap
    // heuristic — "quick brown" straddles the boundary between them.
    const items = [item('The quick', 700), item('brown fox', 700)]
    const ranges = computeQuoteRangesPerItem(items, [{ quoteText: 'quick brown', annotation: 'note' }])
    expect(ranges.get(0)).toEqual([{ start: 4, end: 9, kind: 'quote', title: 'note' }]) // "quick" within item 0
    expect(ranges.get(1)).toEqual([{ start: 0, end: 5, kind: 'quote', title: 'note' }]) // "brown" within item 1
  })

  it('finds a quote spanning a paragraph break between items', () => {
    const items = [item('End of one paragraph.', 700), item('Start of the next.', 660)]
    const ranges = computeQuoteRangesPerItem(items, [{ quoteText: 'paragraph. Start', annotation: '' }])
    expect(ranges.get(0)).toEqual([{ start: 11, end: 21, kind: 'quote', title: undefined }])
    expect(ranges.get(1)).toEqual([{ start: 0, end: 5, kind: 'quote', title: undefined }])
  })

  it('is whitespace-tolerant the same way search is (an ordinary space in the quote matches a line/paragraph break in the text)', () => {
    const items = [item('Line one.', 700), item('Line two.', 688)]
    const ranges = computeQuoteRangesPerItem(items, [{ quoteText: 'one. Line two', annotation: '' }])
    expect(ranges.size).toBe(2)
  })

  it('omits an item with no part of any quote', () => {
    const items = [item('Hello world.', 700)]
    const ranges = computeQuoteRangesPerItem(items, [{ quoteText: 'nowhere to be found', annotation: '' }])
    expect(ranges.size).toBe(0)
  })

  it('returns an empty map when there are no quotes at all', () => {
    expect(computeQuoteRangesPerItem([item('Hello', 700)], []).size).toBe(0)
  })

  it("tags a margin annotation's range with kind: 'annotation'", () => {
    const items = [item('Hello world.', 700)]
    const ranges = computeQuoteRangesPerItem(items, [{ quoteText: 'world', annotation: 'a note to self', kind: 'annotation' }])
    expect(ranges.get(0)).toEqual([{ start: 6, end: 11, kind: 'annotation', title: 'a note to self' }])
  })

  it("defaults a quote with no kind at all to 'quote' (pre-migration data)", () => {
    const items = [item('Hello world.', 700)]
    const ranges = computeQuoteRangesPerItem(items, [{ quoteText: 'world', annotation: '' }])
    expect(ranges.get(0)?.[0].kind).toBe('quote')
  })
})

describe('renderHighlightedSpan', () => {
  it('renders plain text with no marks when there are no ranges', () => {
    const span = document.createElement('span')
    renderHighlightedSpan(span, 'Hello world', [])
    expect(span.innerHTML).toBe('Hello world')
  })

  it('wraps a single range in a mark with the matching class', () => {
    const span = document.createElement('span')
    renderHighlightedSpan(span, 'Hello world', [{ start: 6, end: 11, kind: 'quote', title: 'my note' }])
    const mark = span.querySelector('mark')!
    expect(mark.className).toBe('pdf-quote-hit')
    expect(mark.title).toBe('my note')
    expect(mark.textContent).toBe('world')
    expect(span.textContent).toBe('Hello world')
  })

  it('gives an overlapping quote+search piece both classes', () => {
    const span = document.createElement('span')
    const ranges: ItemHighlightRange[] = [
      { start: 0, end: 11, kind: 'quote', title: 'annotation' },
      { start: 6, end: 11, kind: 'search' },
    ]
    renderHighlightedSpan(span, 'Hello world', ranges)
    const marks = span.querySelectorAll('mark')
    // Three pieces: "Hello " (quote only), "world" (quote + search).
    expect(marks).toHaveLength(2)
    expect(marks[0].className).toBe('pdf-quote-hit')
    expect(marks[1].className.split(' ').sort()).toEqual(['pdf-quote-hit', 'pdf-search-hit'])
    expect(marks[1].title).toBe('annotation')
  })

  it('marks the active search hit with both search classes', () => {
    const span = document.createElement('span')
    renderHighlightedSpan(span, 'hit here', [{ start: 0, end: 3, kind: 'search-active' }])
    const mark = span.querySelector('mark')!
    expect(mark.className.split(' ').sort()).toEqual(['pdf-search-hit', 'pdf-search-hit-active'])
  })

  it('wraps a margin-annotation range in its own distinct class', () => {
    const span = document.createElement('span')
    renderHighlightedSpan(span, 'Hello world', [{ start: 6, end: 11, kind: 'annotation', title: 'a note' }])
    const mark = span.querySelector('mark')!
    expect(mark.className).toBe('pdf-annotation-hit')
    expect(mark.title).toBe('a note')
  })
})
