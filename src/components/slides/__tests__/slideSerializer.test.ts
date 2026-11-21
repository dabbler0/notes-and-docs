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

function citationParagraph(sourceId: string) {
  return { type: 'paragraph', content: [{ type: 'citation', attrs: { sourceId, note: null } }] }
}

function sourceWithUrl(id: string, url: string): Source {
  return { id, bibtex: { type: 'misc', key: id, fields: { title: 'A Cited Work', url } }, comment: '', pageHtml: [], pageCount: 0, contentBytes: 0, createdAt: 0, updatedAt: 0 }
}

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

  it('renders the venue on its own div, right after the author line and right before the date', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { venue: 'Some Conference 2024', date: '2024-03-07' })
    const html = slides[0].html
    expect(html).toContain('<div class="deck-venue">Some Conference 2024</div>')
    expect(html.indexOf('deck-authors')).toBeLessThan(html.indexOf('deck-venue'))
    expect(html.indexOf('deck-venue')).toBeLessThan(html.indexOf('deck-date'))
  })

  it('omits the venue div entirely when not given, or blank', () => {
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author')[0].html).not.toContain('deck-venue')
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { venue: '   ' })[0].html).not.toContain('deck-venue')
  })

  it("falls back to today's own date when none is picked, but only alongside an author name", () => {
    const withAuthor = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author')[0].html
    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    expect(withAuthor).toContain(`<div class="deck-date">${today}</div>`)

    const withoutAuthor = serializeDeck(minimalDoc(), noSources, 'My Deck', '')[0].html
    expect(withoutAuthor).not.toContain('deck-date')
  })
})

describe('serializeDeck — acknowledgements slide', () => {
  it('inserts no acknowledgements slide at all when authorNote is absent or blank', () => {
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author').some((s) => s.html.includes('Acknowledgements'))).toBe(false)
    expect(serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: '   ' }).some((s) => s.html.includes('Acknowledgements'))).toBe(false)
  })

  it('inserts exactly one acknowledgements slide, right before the closing References slide, when authorNote is non-blank', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: 'Thanks to A and B.' })
    expect(slides).toHaveLength(4) // title, body, acknowledgements, references
    expect(slides[2].html).toContain('Acknowledgements')
    expect(slides[2].html).toContain('Thanks to A and B.')
    expect(slides[3].html).toContain('References')
  })

  it('applies inline Markdown (bold/italic/links) the same way the essay-side footnote version does', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: '*Thanks* to [Jane](https://example.com).' })
    const ack = slides.find((s) => s.html.includes('Acknowledgements'))!
    expect(ack.html).toContain('<em>Thanks</em>')
    expect(ack.html).toContain('<a href="https://example.com" target="_blank" rel="noopener">Jane</a>')
  })

  it('turns a literal line break in the note into a real <br>, rather than collapsing it', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: 'Line one.\nLine two.' })
    const ack = slides.find((s) => s.html.includes('Acknowledgements'))!
    expect(ack.html).toContain('Line one.<br>Line two.')
  })

  it('escapes HTML in the note', () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: '<b>bold</b> & more' })
    const ack = slides.find((s) => s.html.includes('Acknowledgements'))!
    expect(ack.html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more')
  })

  it("renders the note as small print on the title slide instead, with no Acknowledgements slide at all, when authorNotePlacement is 'title'", () => {
    const slides = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: 'Thanks to A and B.', authorNotePlacement: 'title' })
    expect(slides).toHaveLength(3) // title, body, references — no acknowledgements slide
    expect(slides[0].html).toContain('<div class="deck-author-note">Thanks to A and B.</div>')
    expect(slides.some((s) => s.html.includes('Acknowledgements'))).toBe(false)
  })

  it("still renders the dedicated Acknowledgements slide, not the title slide, when authorNotePlacement is 'slide' or absent", () => {
    const explicit = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: 'Thanks to A and B.', authorNotePlacement: 'slide' })
    expect(explicit[0].html).not.toContain('deck-author-note')
    expect(explicit.some((s) => s.html.includes('Acknowledgements'))).toBe(true)

    const implicit = serializeDeck(minimalDoc(), noSources, 'My Deck', 'Jane Author', '', { authorNote: 'Thanks to A and B.' })
    expect(implicit[0].html).not.toContain('deck-author-note')
    expect(implicit.some((s) => s.html.includes('Acknowledgements'))).toBe(true)
  })
})

describe('serializeDeck — inline quotes', () => {
  /** An inline quote excerpt (`insertQuoteInline`, pmCommands.ts) is ordinary unmarked text now — its own literal quote characters are already baked into the text, with no special mark/rendering layered on top (see `pmSchema.ts`'s own doc comment on `stripQuoteInlineMark` for the removed mark this guards against ever quietly reappearing). */
  function quotedTextDoc(): PMNode {
    return PMNode.fromJSON(essaySchema, {
      type: 'doc',
      content: [section('root', '', [{ type: 'paragraph', content: [{ type: 'text', text: '"Quoted text"' }] }])],
    })
  }

  it('renders the quoted text plain, with no special span and no <q> element wrapping it', () => {
    const slides = serializeDeck(quotedTextDoc(), noSources, 'My Deck', 'Jane Author')
    const slideWithQuote = slides.find((s) => s.html.includes('Quoted text'))!
    expect(slideWithQuote.html).toContain('&quot;Quoted text&quot;')
    expect(slideWithQuote.html).not.toContain('<span class="slide-quote-inline">')
    expect(slideWithQuote.html).not.toContain('<q>')
    expect(slideWithQuote.html).not.toContain('</q>')
  })
})

describe('serializeDeck — references slide', () => {
  it("renders a cited source's URL as a real clickable link, not literal Markdown link syntax", () => {
    const sources = new Map<string, Source>([['s1', sourceWithUrl('s1', 'https://example.com/paper')]])
    const doc = PMNode.fromJSON(essaySchema, { type: 'doc', content: [section('root', '', [citationParagraph('s1')])] })
    const slides = serializeDeck(doc, sources, 'My Deck', 'Jane Author')
    const references = slides[slides.length - 1]
    expect(references.html).toContain('References')
    expect(references.html).toContain('<a href="https://example.com/paper" target="_blank" rel="noopener">https://example.com/paper</a>')
    expect(references.html).not.toContain('[https://example.com/paper](https://example.com/paper)')
  })
})
