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

  it('does not highlight across a <br> — same known per-text-node limitation applySearchHighlights already has', () => {
    const doc = makeDoc('<p>wraps across a<br>line break here.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'across a line break', annotation: '' }])
    expect(doc.body.querySelector('mark')).toBeNull()
  })

  it('still highlights the part of a quote that stays within one text node even when the whole quote crosses a <br>', () => {
    const doc = makeDoc('<p>wraps across a<br>line break here.</p>')
    applyQuoteHighlights(doc, doc.body, [{ quoteText: 'wraps across a', annotation: '' }])
    expect(doc.body.querySelector('mark.quote-span-hit')?.textContent).toBe('wraps across a')
  })
})
