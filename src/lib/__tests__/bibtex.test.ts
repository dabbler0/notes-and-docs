import { describe, expect, it } from 'vitest'
import { citationHtml, citationLabel, citationPage, formatCitation, pageNote, renderCitationLabel } from '../bibtex'
import type { BibtexEntry, Source } from '../../models/types'

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 's1',
    bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith', year: '2020' } },
    comment: '',
    pageHtml: [],
    pageCount: 0,
    contentBytes: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('citationPage', () => {
  it('returns the raw page unchanged with no offset or no-page-numbers setting', () => {
    expect(citationPage(source(), 5)).toBe(5)
  })

  it('returns null for a falsy or undefined page', () => {
    expect(citationPage(source(), 0)).toBeNull()
    expect(citationPage(source(), undefined)).toBeNull()
  })

  it('subtracts the page offset', () => {
    expect(citationPage(source({ pageOffset: 3 }), 4)).toBe(1)
    expect(citationPage(source({ pageOffset: 3 }), 10)).toBe(7)
  })

  it('returns null when the offset pushes the page to zero or below', () => {
    expect(citationPage(source({ pageOffset: 3 }), 3)).toBeNull()
    expect(citationPage(source({ pageOffset: 3 }), 1)).toBeNull()
  })

  it('adds instead of subtracting for a negative offset — a journal article whose PDF starts already numbered higher than 1', () => {
    expect(citationPage(source({ pageOffset: -152 }), 1)).toBe(153)
    expect(citationPage(source({ pageOffset: -152 }), 2)).toBe(154)
  })

  it('always returns null when the source has no page numbers, offset or not', () => {
    expect(citationPage(source({ noPageNumbers: true }), 5)).toBeNull()
    expect(citationPage(source({ noPageNumbers: true, pageOffset: 2 }), 5)).toBeNull()
  })
})

describe('citationHtml page display', () => {
  it('shows the raw page by default', () => {
    expect(citationHtml(source(), { page: 12 })).toContain('p. 12')
  })

  it('shows the offset-adjusted page', () => {
    expect(citationHtml(source({ pageOffset: 3 }), { page: 12 })).toContain('p. 9')
  })

  it('omits the page entirely for a no-page-numbers source', () => {
    const html = citationHtml(source({ noPageNumbers: true }), { page: 12 })
    expect(html).not.toContain('p.')
  })

  it('omits the page when no page was given at all', () => {
    const html = citationHtml(source())
    expect(html).not.toContain('p.')
  })
})

describe('pageNote', () => {
  it('formats the offset-adjusted page as "p. N"', () => {
    expect(pageNote(source(), 12)).toBe('p. 12')
    expect(pageNote(source({ pageOffset: 3 }), 12)).toBe('p. 9')
  })

  it('is the empty string, not null, when there is nothing to show', () => {
    expect(pageNote(source(), undefined)).toBe('')
    expect(pageNote(source({ noPageNumbers: true }), 12)).toBe('')
  })
})

describe('renderCitationLabel', () => {
  it('matches citationLabel alone when there is no note', () => {
    expect(renderCitationLabel(source().bibtex)).toBe(citationLabel(source().bibtex))
  })

  it('appends the note after the closing paren, comma-separated — the same shape citationHtml has always rendered', () => {
    expect(renderCitationLabel(source().bibtex, 'p. 5')).toBe('(Smith, 2020), p. 5')
  })

  it('accepts any freeform note, not just a page number', () => {
    expect(renderCitationLabel(source().bibtex, 'ch. 3')).toBe('(Smith, 2020), ch. 3')
    expect(renderCitationLabel(source().bibtex, 'forthcoming')).toBe('(Smith, 2020), forthcoming')
  })
})

describe('citationHtml structured data', () => {
  it('tags every chip it produces with the current structured-data version marker', () => {
    expect(citationHtml(source())).toContain('data-cite-v="2"')
  })

  it('carries the source id and the freeform note as separate data attributes', () => {
    const html = citationHtml(source(), { note: 'ch. 3' })
    expect(html).toContain('data-source-id="s1"')
    expect(html).toContain('data-note="ch. 3"')
  })

  it('derives data-note from a raw page via the same pageNote formatting, when note is not given directly', () => {
    const html = citationHtml(source({ pageOffset: 3 }), { page: 12 })
    expect(html).toContain('data-note="p. 9"')
  })

  it('omits data-note entirely when there is nothing to show, rather than an empty attribute', () => {
    expect(citationHtml(source())).not.toContain('data-note')
  })

  it('prefers an explicit note over a page when both are given', () => {
    const html = citationHtml(source(), { page: 12, note: 'ch. 3' })
    expect(html).toContain('data-note="ch. 3"')
    expect(html).not.toContain('p. 12')
  })

  it('HTML-escapes a freeform note that contains markup, rather than splicing it in raw', () => {
    const html = citationHtml(source(), { note: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })
})

describe('formatCitation', () => {
  function entry(fields: Record<string, string> = {}, type = 'article'): BibtexEntry {
    return { type, key: 'smith2020', fields }
  }

  it('renders author, year, title, and journal/volume/pages together', () => {
    expect(formatCitation(entry({ author: 'Jane Tester', year: '2024', title: 'A Test PDF Document', journal: 'Journal of Examples', volume: '12', number: '3', pages: '45-67' }))).toBe(
      'Jane Tester (2024). A Test PDF Document. Journal of Examples, 12(3), pp. 45-67.',
    )
  })

  it('degrades gracefully with only a title', () => {
    expect(formatCitation(entry({ title: 'Untitled Paper' }))).toBe('Untitled Paper.')
  })

  it('falls back to the BibTeX key when there is no title at all', () => {
    expect(formatCitation(entry())).toBe('smith2020.')
  })

  it('uses the publisher when there is no journal/booktitle', () => {
    expect(formatCitation(entry({ author: 'Jane Tester', year: '2024', title: 'A Book', publisher: 'Example Press' }, 'book'))).toBe('Jane Tester (2024). A Book. Example Press.')
  })

  it('uses booktitle and volume alone (no issue number) when there is no journal', () => {
    expect(formatCitation(entry({ title: 'A Chapter', booktitle: 'Collected Works', volume: '2' }, 'incollection'))).toBe('A Chapter. Collected Works, 2.')
  })
})
