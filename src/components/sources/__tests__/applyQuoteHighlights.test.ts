import { describe, expect, it } from 'vitest'
import { applyQuoteHighlights } from '../TextViewer'

/** A standalone document (not the test runner's own global `document`) the
 * same way `TextViewer`'s real target — a sandboxed iframe's own
 * `contentDocument` — is a document distinct from the parent page's. */
function makeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument('')
  doc.body.innerHTML = html
  return doc
}

describe('applyQuoteHighlights', () => {
  it('wraps a saved quote in a mark with its annotation as the title', () => {
    const doc = makeDoc('<p>Some text with a notable phrase inside it.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'notable phrase', annotation: 'why this mattered' }])
    const mark = doc.body.querySelector('mark.quote-span-hit')!
    expect(mark).not.toBeNull()
    expect(mark.textContent).toBe('notable phrase')
    expect(mark.getAttribute('title')).toBe('why this mattered')
    expect(doc.body.textContent).toBe('Some text with a notable phrase inside it.')
  })

  it('omits the title when there is no annotation', () => {
    const doc = makeDoc('<p>Plain quoted text here.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'quoted text', annotation: '' }])
    const mark = doc.body.querySelector('mark.quote-span-hit')!
    expect(mark.hasAttribute('title')).toBe(false)
  })

  it('highlights every occurrence of a quote that appears more than once', () => {
    const doc = makeDoc('<p>Repeat this phrase. Repeat this phrase again.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'Repeat this phrase', annotation: '' }])
    expect(doc.body.querySelectorAll('mark.quote-span-hit')).toHaveLength(2)
  })

  it('does nothing for a quote not present on the page', () => {
    const doc = makeDoc('<p>Nothing relevant here.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'not present at all', annotation: '' }])
    expect(doc.body.querySelector('mark')).toBeNull()
  })

  it('highlights a quote that spans a <br> — the common case for layout-extracted text, where every line is its own node', () => {
    const doc = makeDoc('<p>wraps across a<br>line break here.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'across a line break', annotation: '' }])
    const marks = doc.body.querySelectorAll('mark.quote-span-hit')
    expect(marks).toHaveLength(2)
    expect(marks[0].textContent).toBe('across a')
    expect(marks[1].textContent).toBe('line break')
    expect(doc.body.textContent).toBe('wraps across aline break here.')
  })

  it('highlights a quote spanning two separate layout-mode spans (no <br> between them)', () => {
    const doc = makeDoc('<span>first run</span><span> second run</span>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'first run second run', annotation: '' }])
    const marks = doc.body.querySelectorAll('mark.quote-span-hit')
    expect(marks).toHaveLength(2)
    expect(marks[0].textContent).toBe('first run')
    expect(marks[1].textContent).toBe(' second run')
  })

  it('spanning quote crossing a <p>/<div> paragraph boundary is still matched (not split by the inserted blank-line separator, since buildSearchRegex is whitespace-tolerant)', () => {
    const doc = makeDoc('<p>End of one paragraph</p><p>start of the next.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'paragraph start of the next', annotation: '' }])
    expect(doc.body.querySelectorAll('mark.quote-span-hit')).toHaveLength(2)
  })

  it('carries the annotation onto every mark produced by a cross-node match', () => {
    const doc = makeDoc('<p>wraps across a<br>line break here.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'across a line break', annotation: 'why this mattered' }])
    const marks = doc.body.querySelectorAll('mark.quote-span-hit')
    expect(marks[0].getAttribute('title')).toBe('why this mattered')
    expect(marks[1].getAttribute('title')).toBe('why this mattered')
  })

  it("wraps a margin annotation in its own distinct class (not quote-span-hit)", () => {
    const doc = makeDoc('<p>a note-worthy phrase here.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'note-worthy phrase', annotation: 'remember this', kind: 'annotation' }])
    expect(doc.body.querySelector('mark.quote-span-hit')).toBeNull()
    const mark = doc.body.querySelector('mark.annotation-span-hit')!
    expect(mark).not.toBeNull()
    expect(mark.getAttribute('title')).toBe('remember this')
  })

  it('tells a quote and an annotation apart on the same page, even where their text overlaps', () => {
    const doc = makeDoc('<p>Quoted text and noted text both matter.</p>')
    applyQuoteHighlights(doc, doc.body, [
      { quoteText: 'Quoted text', annotation: '', kind: 'quote' },
      { quoteText: 'noted text', annotation: '', kind: 'annotation' },
    ])
    expect(doc.body.querySelector('mark.quote-span-hit')?.textContent).toBe('Quoted text')
    expect(doc.body.querySelector('mark.annotation-span-hit')?.textContent).toBe('noted text')
  })

  it("defaults to quote-span-hit when kind is absent (pre-migration data)", () => {
    const doc = makeDoc('<p>Some text with a notable phrase inside it.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'notable phrase', annotation: '' }])
    expect(doc.body.querySelector('mark.quote-span-hit')).not.toBeNull()
  })
})
