import { describe, expect, it } from 'vitest'
import { reflowTextItems } from '../pdf'

/** A fake pdf.js text item — `transform` is `[scaleX, skewY, skewX, scaleY, x, y]`; only the font-height (`scaleY` here, via `Math.hypot(scaleX-ish, scaleY)`) and baseline `y` matter to `reflowTextItems`. */
function item(str: string, y: number, height = 10) {
  return { str, transform: [height, 0, 0, height, 0, y] }
}

// findPdfMatches/buildSearchRegex now live in pageSearchCore.ts (see that
// module's own tests) — pdf.ts just re-exports them for existing callers.

describe('reflowTextItems', () => {
  it('joins items on the same line with a single space', () => {
    const items = [item('Hello', 700), item('world.', 700)]
    expect(reflowTextItems(items)).toBe('Hello world.')
  })

  it('inserts a single line break for a real line break in the source document', () => {
    const items = [item('Line one.', 700), item('Line two, same paragraph.', 688)] // gap 12: 0.3*height (3) < 12 <= 1.6*height (16)
    expect(reflowTextItems(items)).toBe('Line one.\nLine two, same paragraph.')
  })

  it('inserts a paragraph break across a large vertical gap', () => {
    const items = [item('First paragraph.', 700), item('Second paragraph.', 660)] // gap 40 > 16
    expect(reflowTextItems(items)).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('handles more than one paragraph break', () => {
    const items = [item('First.', 700), item('Second.', 660), item('Third.', 620)]
    expect(reflowTextItems(items)).toBe('First.\n\nSecond.\n\nThird.')
  })

  it('handles a mix of same-line words, a line break, and a paragraph break', () => {
    const items = [item('One', 700), item('two', 700), item('three.', 688), item('New paragraph.', 640)]
    expect(reflowTextItems(items)).toBe('One two\nthree.\n\nNew paragraph.')
  })

  it('skips items with no string content', () => {
    const items = [item('Hello', 700), { transform: [10, 0, 0, 10, 0, 700] }, item('', 700), item('world.', 700)]
    expect(reflowTextItems(items)).toBe('Hello world.')
  })

  it('returns an empty string for no items', () => {
    expect(reflowTextItems([])).toBe('')
  })

  it('trims the result and collapses runs of internal spaces', () => {
    const items = [item('  Hello  ', 700), item('world.  ', 700)]
    expect(reflowTextItems(items)).toBe('Hello world.')
  })
})
