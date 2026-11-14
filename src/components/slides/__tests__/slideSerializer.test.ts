import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema } from '../../../lib/pmSchema'
import { serializeDeck } from '../slideSerializer'
import type { Source } from '../../../models/types'

function paragraph(text: string) {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

function section(id: string, title: string, children: unknown[]) {
  return { type: 'section', attrs: { id }, content: [{ type: 'section_title', content: title ? [{ type: 'text', text: title }] : [] }, ...children] }
}

function minimalDoc(): PMNode {
  return PMNode.fromJSON(essaySchema, { type: 'doc', content: [section('root', '', [paragraph('Hello.')])] })
}

const noSources = new Map<string, Source>()

describe('serializeDeck — title slide', () => {
  it('renders the deck title and author, with no subtitle div at all when none is given', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author')
    expect(slides[0].html).toContain('My Deck')
    expect(slides[0].html).toContain('Jane Author')
    expect(slides[0].html).not.toContain('deck-subtitle')
  })

  it('renders a given subtitle in its own div, between the title and the author line', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', 'A talk on things')
    const html = slides[0].html
    expect(html).toContain('<div class="deck-subtitle">A talk on things</div>')
    expect(html.indexOf('deck-title')).toBeLessThan(html.indexOf('deck-subtitle'))
    expect(html.indexOf('deck-subtitle')).toBeLessThan(html.indexOf('deck-authors'))
  })

  it('omits the subtitle div for an empty or whitespace-only subtitle', () => {
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '')[0].html).not.toContain('deck-subtitle')
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '   ')[0].html).not.toContain('deck-subtitle')
  })

  it('escapes HTML in the subtitle, same as the title', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '<b>bold</b> & more')
    expect(slides[0].html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more')
  })

  it('appends the affiliation to the author line, comma-separated, when given', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { affiliation: 'Some University' })
    expect(slides[0].html).toContain('<div class="deck-authors">Jane Author, Some University</div>')
  })

  it('omits the affiliation entirely when not given, or blank', () => {
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author')[0].html).toContain('<div class="deck-authors">Jane Author</div>')
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { affiliation: '   ' })[0].html).toContain('<div class="deck-authors">Jane Author</div>')
  })

  it('renders a specific picked date exactly, rather than falling back to today', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { date: '2024-03-07' })
    expect(slides[0].html).toContain('<div class="deck-date">March 7, 2024</div>')
  })

  it("falls back to today's own date when none is picked, but only alongside an author name", () => {
    const withAuthor = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author')[0].html
    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    expect(withAuthor).toContain(`<div class="deck-date">${today}</div>`)

    const withoutAuthor = serializeDeck(minimalDoc(), noSources, 'My Deck', '')[0].html
    expect(withoutAuthor).not.toContain('deck-date')
  })
})

describe('serializeDeck — inline quotes', () => {
  /** `insertQuoteInline` (pmCommands.ts) bakes the surrounding curly quotes into the text itself before applying the mark — exactly reproduced here, rather than a plain `'Quoted text'` with no quote characters at all, since the bug this guards against only shows up with real, already-quoted text underneath the mark. */
  function quoteInlineDoc(): PMNode {
    return PMNode.fromJSON(essaySchema, {
      type: 'doc',
      content: [
        section('root', '', [{ type: 'paragraph', content: [{ type: 'text', text: '“Quoted text”', marks: [{ type: 'quote_inline', attrs: { sourceId: 's1', page: 1 } }] }] }]),
      ],
    })
  }

  it('wraps the already-quoted text in a plain styled span, not a <q> element', () => {
    const slides = serializeDeck(quoteInlineDoc(), noSources, 'My Deck', 'Jane Author')
    const slideWithQuote = slides.find((s) => s.html.includes('Quoted text'))!
    expect(slideWithQuote.html).toContain('<span class="slide-quote-inline">“Quoted text”</span>')
    expect(slideWithQuote.html).not.toContain('<q>')
    expect(slideWithQuote.html).not.toContain('</q>')
  })

  it('never doubles the quote characters — exactly the two pairs already in the text, no more', () => {
    const slides = serializeDeck(quoteInlineDoc(), noSources, 'My Deck', 'Jane Author')
    const slideWithQuote = slides.find((s) => s.html.includes('Quoted text'))!
    expect(slideWithQuote.html.match(/“/g)).toHaveLength(1)
    expect(slideWithQuote.html.match(/”/g)).toHaveLength(1)
  })
})
