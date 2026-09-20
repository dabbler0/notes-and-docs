import { describe, expect, it } from 'vitest'
import { looksLikeScannedPdf } from '../ocr'

describe('looksLikeScannedPdf', () => {
  it('is false for a document with no pages at all', () => {
    expect(looksLikeScannedPdf([])).toBe(false)
  })

  it('is true for pages with completely empty text', () => {
    expect(looksLikeScannedPdf(['', '', ''])).toBe(true)
  })

  it('is true for pages with only a stray character or two, like a scanned page number', () => {
    expect(looksLikeScannedPdf(['3', '', '5'])).toBe(true)
  })

  it('is false for a page with a real paragraph of text', () => {
    expect(looksLikeScannedPdf(['This is a normal page with plenty of real extracted text on it, several sentences long.'])).toBe(false)
  })

  it('is false when only some pages are sparse, as long as the document average has real content', () => {
    expect(looksLikeScannedPdf(['This is a completely normal, text-rich page with lots of real content on it.', '', 'Another substantial page of real, extracted body text goes here as well.'])).toBe(false)
  })

  it('is true when every page individually is sparse, even if the whole document is longer', () => {
    const pages = Array.from({ length: 20 }, () => '1')
    expect(looksLikeScannedPdf(pages)).toBe(true)
  })
})
