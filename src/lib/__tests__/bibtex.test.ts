import { describe, expect, it } from 'vitest'
import { citationHtml, citationPage } from '../bibtex'
import type { Source } from '../../models/types'

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 's1',
    bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith', year: '2020' } },
    comment: '',
    pageTexts: [],
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
