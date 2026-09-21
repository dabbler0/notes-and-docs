import { describe, expect, it } from 'vitest'
import { parseCitationFields } from '../citationParse'

describe('parseCitationFields', () => {
  it('returns nothing for blank input', () => {
    expect(parseCitationFields('')).toEqual({})
    expect(parseCitationFields('   ')).toEqual({})
  })

  it('parses an APA journal article with two authors, a DOI, and pages', () => {
    const result = parseCitationFields(
      'Smith, J. A., & Doe, J. B. (2020). Title of the article goes here. Journal of Examples, 12(3), 45-67. https://doi.org/10.1234/jex.2020.001',
    )
    expect(result.author).toBe('Smith, J. A. and Doe, J. B.')
    expect(result.year).toBe('2020')
    expect(result.title).toBe('Title of the article goes here')
    expect(result.journal).toBe('Journal of Examples, 12(3), 45–67')
    expect(result.doi).toBe('10.1234/jex.2020.001')
    expect(result.url).toBeUndefined()
  })

  it('parses an APA book (single author, no volume/pages)', () => {
    const result = parseCitationFields('Smith, J. A. (2020). Title of the book. Publisher Name.')
    expect(result.author).toBe('Smith, J. A.')
    expect(result.year).toBe('2020')
    expect(result.title).toBe('Title of the book')
    expect(result.journal).toBe('Publisher Name')
  })

  it('parses an APA-style website citation with a URL and no DOI', () => {
    const result = parseCitationFields('Doe, Jane. (2021). How to write a citation. Example Site. https://example.com/how-to-cite')
    expect(result.author).toBe('Doe, Jane')
    expect(result.year).toBe('2021')
    expect(result.title).toBe('How to write a citation')
    expect(result.url).toBe('https://example.com/how-to-cite')
  })

  it('parses an MLA journal article with vol./no./pp.', () => {
    const result = parseCitationFields('Smith, John. "Title of the Article." Journal of Examples, vol. 12, no. 3, 2020, pp. 45-67.')
    expect(result.author).toBe('Smith, John')
    expect(result.title).toBe('Title of the Article')
    expect(result.year).toBe('2020')
    expect(result.journal).toBe('Journal of Examples, 12(3), 45–67')
  })

  it('parses an MLA-style website citation with multiple authors joined by "and"', () => {
    const result = parseCitationFields('Smith, John, and Jane Doe. "Title of the Web Page." Example Site, 12 Jan. 2020, www.example.com/page.')
    expect(result.author).toBe('Smith, John and Jane Doe')
    expect(result.title).toBe('Title of the Web Page')
  })

  it('parses a Chicago author-date citation', () => {
    const result = parseCitationFields('Smith, John. 2020. "Title of the Article." Journal of Examples 12 (3): 45-67.')
    expect(result.author).toBe('Smith, John')
    expect(result.year).toBe('2020')
    expect(result.title).toBe('Title of the Article')
  })

  it('parses an IEEE-style citation with initials-first authors', () => {
    const result = parseCitationFields('A. Smith and B. Doe, "Title of paper," Journal of Examples, vol. 12, no. 3, pp. 45-67, 2020.')
    expect(result.author).toBe('A. Smith and B. Doe')
    expect(result.title).toBe('Title of paper')
    expect(result.year).toBe('2020')
  })

  it('parses a Harvard-style citation', () => {
    const result = parseCitationFields("Smith, A.A. (2020) 'Title of article', Journal of Examples, 12(3), pp. 45-67.")
    expect(result.author).toBe('Smith, A.A.')
    expect(result.year).toBe('2020')
    expect(result.title).toBe('Title of article')
  })

  it('handles three-or-more authors joined with commas and "and"', () => {
    const result = parseCitationFields('Smith, John, Jane Doe, and Alex Lee. "Title of the Article." Journal of Examples, 2020.')
    expect(result.author).toBe('Smith, John and Jane Doe and Alex Lee')
  })

  it('handles "et al." by tagging the remainder as "others"', () => {
    const result = parseCitationFields('Smith, John, et al. (2020). Title of the article. Journal of Examples.')
    expect(result.author).toBe('Smith, John and others')
  })

  it('extracts a DOI given as a bare "doi:" prefix', () => {
    const result = parseCitationFields('Smith, J. (2020). Title. Journal, 1(1), 1-2. doi:10.1000/xyz123')
    expect(result.doi).toBe('10.1000/xyz123')
  })

  it('extracts a plain URL when no DOI is present', () => {
    const result = parseCitationFields('Smith, J. (2020). Title. https://example.com/article')
    expect(result.url).toBe('https://example.com/article')
    expect(result.doi).toBeUndefined()
  })

  it('falls back to using the whole input as the title when no year or quotes are found', () => {
    const result = parseCitationFields('Just some pasted text with no recognizable citation structure at all')
    expect(result.title).toBe('Just some pasted text with no recognizable citation structure at all')
    expect(result.author).toBeUndefined()
  })

  it('strips a leading numbered-list marker like "[1] "', () => {
    const result = parseCitationFields('[1] A. Smith, "Title of paper," Journal of Examples, 2020.')
    expect(result.author).toBe('A. Smith')
    expect(result.title).toBe('Title of paper')
  })

  it('does not mistake a page number or volume for a year', () => {
    const result = parseCitationFields('Smith, J. (2020). Title of the article. Journal of Examples, 45(6), 1200-1250.')
    expect(result.year).toBe('2020')
    expect(result.journal).toBe('Journal of Examples, 45(6), 1200–1250')
  })

  it('keeps a disambiguated year suffix out of the numeric year field', () => {
    const result = parseCitationFields('Smith, J. (2020a). Title of the article. Journal of Examples.')
    expect(result.year).toBe('2020')
  })

  it('leaves author blank rather than mislabeling a long author-less title before the year', () => {
    // The genuinely hard case this module doesn't try to fully solve (see
    // `looksLikeAuthorList`'s own doc comment) — but it shouldn't
    // confidently mislabel "A Long Article Title With No Author At All"
    // as if it were a person's name either.
    const result = parseCitationFields('A Long Article Title With No Author At All. (2023). In Wikipedia. https://en.wikipedia.org/wiki/Example')
    expect(result.author).toBeUndefined()
  })

  it('still treats a short, unseparated single name as an author', () => {
    const result = parseCitationFields('Smith (2020). Title of the article. Journal of Examples.')
    expect(result.author).toBe('Smith')
  })
})
