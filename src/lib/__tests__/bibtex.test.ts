import { describe, expect, it } from 'vitest'
import { citationHtml, citationLabel, citationPage, extractLegacyCitationNote, formatCitation, pageNote, renderCitationLabel, trailingCitationFields } from '../bibtex'
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

  it('folds the note inside the closing paren, comma-separated — the same shape citationHtml has always rendered', () => {
    expect(renderCitationLabel(source().bibtex, 'p. 5')).toBe('(Smith, 2020, p. 5)')
  })

  it('accepts any freeform note, not just a page number', () => {
    expect(renderCitationLabel(source().bibtex, 'ch. 3')).toBe('(Smith, 2020, ch. 3)')
    expect(renderCitationLabel(source().bibtex, 'forthcoming')).toBe('(Smith, 2020, forthcoming)')
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

describe('citationHtml DOM structure (base/note/close spans)', () => {
  it('wraps the generated author/date label — minus its closing paren — in a non-editable .citation-base span', () => {
    const html = citationHtml(source())
    expect(html).toContain('<span class="citation-base" contenteditable="false">(Smith, 2020</span>')
  })

  it('closes the chip with a fixed, non-editable .citation-close span holding just the closing paren', () => {
    const html = citationHtml(source())
    expect(html).toContain('<span class="citation-close" contenteditable="false">)</span>')
  })

  it('renders a note between the base and close spans, so it reads inside the parens — not outside the base span', () => {
    const html = citationHtml(source(), { note: 'p. 5' })
    expect(html).toContain('<span class="citation-base" contenteditable="false">(Smith, 2020</span>, p. 5<span class="citation-close" contenteditable="false">)</span>')
    // The separator + note must not have ended up inside either non-editable span.
    expect(html).not.toContain('(Smith, 2020, p. 5</span>')
    expect(html).not.toContain('p. 5)</span>')
  })

  it('adds no visible separator or note text when there is no note — only the invisible zero-width-space caret placeholder between base and close', () => {
    const html = citationHtml(source())
    // See citationHtml's own doc comment: a lone U+200B keeps a click
    // between the base and close spans from landing outside the chip
    // entirely, with nothing visible to show for it.
    expect(html).toMatch(/<\/span>​<span class="citation-close"/)
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

  it('includes the editor and translator, right after the title, when present', () => {
    expect(
      formatCitation(entry({ author: 'Jane Tester', year: '2024', title: 'A Test PDF Document', editor: 'Bob Editor', translator: 'Ann Translator', journal: 'Journal of Examples' })),
    ).toBe('Jane Tester (2024). A Test PDF Document. Ed. Bob Editor. Trans. Ann Translator. Journal of Examples.')
  })

  it('includes only the editor when there is no translator, and vice versa', () => {
    expect(formatCitation(entry({ title: 'A Chapter', editor: 'Bob Editor', booktitle: 'Collected Works' }, 'incollection'))).toBe('A Chapter. Ed. Bob Editor. Collected Works.')
    expect(formatCitation(entry({ title: 'A Translated Work', translator: 'Ann Translator', publisher: 'Example Press' }, 'book'))).toBe('A Translated Work. Trans. Ann Translator. Example Press.')
  })

  it('omits the editor/translator sentence entirely when neither is present', () => {
    expect(formatCitation(entry({ title: 'A Test PDF Document', journal: 'Journal of Examples' }))).not.toContain('Ed.')
  })

  it('includes the editor for a regular @book entry (no booktitle/journal), same as any other entry shape', () => {
    expect(formatCitation(entry({ title: 'A Whole Book', editor: 'Bob Editor', publisher: 'Example Press' }, 'book'))).toBe('A Whole Book. Ed. Bob Editor. Example Press.')
  })

  it('appends ISBN, DOI (as a link), URL (as a link), and note, in that order, when present', () => {
    const md = formatCitation(entry({ title: 'A Whole Book', publisher: 'Example Press', isbn: '978-0-00-000000-0', doi: '10.1000/xyz123', url: 'https://example.com/book', note: 'A reprint edition' }, 'book'))
    expect(md).toBe('A Whole Book. Example Press. ISBN: 978-0-00-000000-0. [doi.org/10.1000/xyz123](https://doi.org/10.1000/xyz123). [https://example.com/book](https://example.com/book). A reprint edition.')
  })

  it('leaves an already-fully-qualified DOI URL untouched rather than double-prefixing it, while displaying it without the scheme', () => {
    const md = formatCitation(entry({ title: 'A Paper', doi: 'https://doi.org/10.1000/xyz123' }))
    expect(md).toContain('[doi.org/10.1000/xyz123](https://doi.org/10.1000/xyz123)')
    expect(md).not.toContain('doi.org/https://')
  })

  it('omits every trailing field that is absent', () => {
    expect(formatCitation(entry({ title: 'A Paper' }))).toBe('A Paper.')
  })
})

describe('trailingCitationFields', () => {
  it('returns an empty array when none of isbn/doi/url/note are present', () => {
    expect(trailingCitationFields({ title: 'x' })).toEqual([])
  })

  it('applies the given escape function to each field value, but not to the [text](url) link syntax itself', () => {
    const out = trailingCitationFields({ url: 'https://example.com/a*b' }, (s) => s.replace(/\*/g, '\\*'))
    expect(out).toEqual(['[https://example.com/a\\*b](https://example.com/a\\*b)'])
  })

  it('suppresses the URL when includeUrlWhenDoi is false and a DOI is present', () => {
    const out = trailingCitationFields({ doi: '10.1000/xyz', url: 'https://example.com/book' }, (s) => s, { includeUrlWhenDoi: false })
    expect(out).toEqual(['[doi.org/10.1000/xyz](https://doi.org/10.1000/xyz)'])
  })

  it('still includes the URL when includeUrlWhenDoi is false but there is no DOI', () => {
    const out = trailingCitationFields({ url: 'https://example.com/book' }, (s) => s, { includeUrlWhenDoi: false })
    expect(out).toEqual(['[https://example.com/book](https://example.com/book)'])
  })
})

describe('extractLegacyCitationNote', () => {
  it('returns a single page as "pN", with no period or space', () => {
    expect(extractLegacyCitationNote('(Smith, 2020, p. 5)', '2020')).toBe('p5')
  })

  it('returns a page range as "ppN-N", collapsing any whitespace around the dash', () => {
    expect(extractLegacyCitationNote('(Smith, 2020, pp. 12-15)', '2020')).toBe('pp12-15')
    expect(extractLegacyCitationNote('(Smith, 2020, pp. 12 - 15)', '2020')).toBe('pp12-15')
    expect(extractLegacyCitationNote('(Smith, 2020, pp. 12  -15)', '2020')).toBe('pp12-15')
    expect(extractLegacyCitationNote('(Smith, 2020, pp. 12-  15)', '2020')).toBe('pp12-15')
  })

  it('uses the LAST number or range in the text, not the first', () => {
    expect(extractLegacyCitationNote('(Smith, 2020, see also p. 5, cited at p. 12)', '2020')).toBe('p12')
  })

  it('returns an empty string when there are no digits anywhere', () => {
    expect(extractLegacyCitationNote('(Smith, n.d.)', undefined)).toBe('')
  })

  it('returns an empty string when the only number in the text is the source\'s own publication year', () => {
    expect(extractLegacyCitationNote('(Smith, 2020)', '2020')).toBe('')
  })

  it('still returns the page when the text mentions both the year and a real page, even if the page equals the year', () => {
    // Contrived, but unambiguous: two separate numbers, not one.
    expect(extractLegacyCitationNote('(Smith, 2020, p. 2020)', '2020')).toBe('p2020')
  })

  it('does not apply the year exclusion when there is no year to compare against', () => {
    expect(extractLegacyCitationNote('(Smith, n.d., p. 2020)', undefined)).toBe('p2020')
  })

  it('does not apply the year exclusion to a lone number that just does not happen to equal the year', () => {
    expect(extractLegacyCitationNote('(Smith, p. 5)', '2021')).toBe('p5')
  })

  it('excludes a year that was itself written as "N-N" (the same year twice) rather than misreading it as a page range', () => {
    // A real reported bug: a source whose year field used to be "2020-2020"
    // (now fixed to plain "2020") left old citations rendering a bogus
    // "pp2020-2020" note — the range-matching branch below used to skip
    // the exclusion check entirely whenever the lone match looked like a
    // range at all, regardless of whether it was actually the year.
    expect(extractLegacyCitationNote('(Smith, 2020-2020)', '2020')).toBe('')
  })

  it('excludes a year range when the new, fixed year matches either half of the old range', () => {
    // The source's year was fixed from a genuine two-year range down to
    // just one of those two years — still recognizable as "this was the
    // year slot", not a page range.
    expect(extractLegacyCitationNote('(Smith, 2020-2021)', '2020')).toBe('')
    expect(extractLegacyCitationNote('(Smith, 2020-2021)', '2021')).toBe('')
  })

  it('still reads a genuine page range when it does not match the year at all', () => {
    expect(extractLegacyCitationNote('(Smith, 2020, pp. 12-15)', '2020')).toBe('pp12-15')
  })
})
