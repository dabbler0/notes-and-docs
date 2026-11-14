import { describe, expect, it } from 'vitest'
import { attributionDateText } from '../renderDate'

describe('attributionDateText', () => {
  it('formats a specific picked date', () => {
    expect(attributionDateText('2024-03-07')).toBe('March 7, 2024')
  })

  it('falls back to a formatted version of today when no date is given', () => {
    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    expect(attributionDateText(undefined)).toBe(today)
  })

  it('parses as a local calendar date, not shifted by the UTC-midnight parse a bare new Date(string) would do', () => {
    // A late-December date is the sharpest case: a UTC-midnight parse
    // shifted a day earlier in any negative-UTC-offset timezone would
    // land on a *different year* entirely (Dec 31 -> Dec 30, say), not
    // just a different day within the same month.
    expect(attributionDateText('2023-12-31')).toBe('December 31, 2023')
    expect(attributionDateText('2024-01-01')).toBe('January 1, 2024')
  })
})
