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
})
