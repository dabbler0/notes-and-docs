import { describe, expect, it } from 'vitest'
import { computeTextBoxes, htmlToPlainText, plainTextToHtml, regionIsMostlyText, sampleTextColor, type Rect, type TextBox } from '../textExtraction'

/** Builds a minimal stand-in for the `ImageData` `sampleTextColor` reads
 * from — jsdom doesn't implement a full canvas/ImageData, so tests build
 * the same `{width, height, data}` shape directly rather than requiring a
 * real canvas. `paint(x, y, w, h, [r,g,b,a])` fills a solid rectangle,
 * letting a test describe "the ink is this rectangle" without needing a
 * literal glyph bitmap. */
interface FakePixels extends ImageData {
  paint(x: number, y: number, w: number, h: number, rgba: [number, number, number, number]): void
}

function makePixels(width: number, height: number, backgroundRgba: [number, number, number, number] = [255, 255, 255, 255]): FakePixels {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(backgroundRgba, i * 4)
  return {
    width,
    height,
    data,
    paint(x: number, y: number, w: number, h: number, rgba: [number, number, number, number]) {
      for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) {
          if (px < 0 || py < 0 || px >= width || py >= height) continue
          data.set(rgba, (py * width + px) * 4)
        }
      }
    },
  } as unknown as FakePixels
}

describe('plainTextToHtml', () => {
  it('wraps a single paragraph in <p>', () => {
    expect(plainTextToHtml('Hello world.')).toBe('<p>Hello world.</p>')
  })

  it('turns a blank-line-separated paragraph into its own <p>', () => {
    expect(plainTextToHtml('First paragraph.\n\nSecond paragraph.')).toBe('<p>First paragraph.</p><p>Second paragraph.</p>')
  })

  it('turns a single line break within a paragraph into <br>', () => {
    expect(plainTextToHtml('Line one.\nLine two.')).toBe('<p>Line one.<br>Line two.</p>')
  })

  it('escapes HTML-significant characters', () => {
    expect(plainTextToHtml('<script>alert(1)</script> & "quotes"')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "quotes"</p>')
  })

  it('drops blank/whitespace-only paragraphs and returns empty for blank input', () => {
    expect(plainTextToHtml('')).toBe('')
    expect(plainTextToHtml('   \n\n   ')).toBe('')
  })
})

describe('htmlToPlainText', () => {
  it('returns empty string for empty/falsy input', () => {
    expect(htmlToPlainText('')).toBe('')
  })

  it('reads plain text straight through', () => {
    expect(htmlToPlainText('<p>Hello world.</p>')).toBe('Hello world.')
  })

  it('turns <br> into a line break', () => {
    expect(htmlToPlainText('<p>Line one.<br>Line two.</p>')).toBe('Line one.\nLine two.')
  })

  it('turns adjacent <p> elements into a paragraph break', () => {
    expect(htmlToPlainText('<p>First.</p><p>Second.</p>')).toBe('First.\n\nSecond.')
  })

  it('contributes nothing for an <img>', () => {
    expect(htmlToPlainText('<p>Before</p><img src="data:image/png;base64,x"><p>After</p>')).toBe('Before\n\nAfter')
  })

  it('decodes HTML entities', () => {
    expect(htmlToPlainText('<p>&lt;tag&gt; &amp; "quotes"</p>')).toBe('<tag> & "quotes"')
  })

  it('round-trips plainTextToHtml output back to equivalent plain text', () => {
    const original = 'First paragraph,\nwith a line break.\n\nSecond paragraph.'
    expect(htmlToPlainText(plainTextToHtml(original))).toBe(original)
  })
})

describe('sampleTextColor', () => {
  // tx = [a, b, c, d, e, f] for an unrotated run: (a, d) is the font size in
  // each axis, (e, f) is the baseline origin — the same shape
  // `extractLayoutPageHtml` computes via `pdfjsLib.Util.transform`.
  const height = 20
  const tx = [height, 0, 0, height, 10, 50]

  it('finds ink sitting well outside the old fixed sampling height', () => {
    // Ink painted as a thin band near the top of the run's box (y fraction
    // ~0.66 above the baseline) — the single fixed height this function
    // used to sample at (~0.32) would land on plain background here and
    // report the background color instead, exactly the "much brighter
    // shade of gray, or almost white" bug this grid-sampling rewrite
    // fixes. A saturated, non-grayscale color makes it possible to tell
    // "found the ink" apart from "matched the grayscale fallback".
    const pixels = makePixels(300, 200)
    pixels.paint(15, 65, 120, 12, [0, 150, 0, 255])
    expect(sampleTextColor(pixels, tx, height, 5)).toBe('rgb(0, 150, 0)')
  })

  it('snaps a near-grayscale sample to black', () => {
    const pixels = makePixels(300, 200)
    pixels.paint(0, 0, 300, 200, [200, 200, 200, 255])
    expect(sampleTextColor(pixels, tx, height, 5)).toBe('#000')
  })

  it('keeps a genuinely colorful sample as-is', () => {
    const pixels = makePixels(300, 200)
    pixels.paint(0, 0, 300, 200, [200, 40, 40, 255])
    expect(sampleTextColor(pixels, tx, height, 5)).toBe('rgb(200, 40, 40)')
  })

  it('falls back to black when every sampled pixel is fully transparent', () => {
    const pixels = makePixels(300, 200, [255, 255, 255, 0])
    expect(sampleTextColor(pixels, tx, height, 5)).toBe('#000')
  })
})

describe('computeTextBoxes / regionIsMostlyText', () => {
  const viewport = { transform: [1, 0, 0, 1, 0, 0] }

  it('computes a bounding box and character count per non-blank text item', () => {
    const items = [
      { str: 'Hello', transform: [12, 0, 0, 12, 10, 50] },
      { str: '   ', transform: [12, 0, 0, 12, 10, 70] },
      { str: '', transform: [12, 0, 0, 12, 10, 90] },
    ]
    const boxes = computeTextBoxes(items, viewport)
    expect(boxes).toHaveLength(1)
    expect(boxes[0].chars).toBe(5)
    expect(boxes[0].height).toBe(12)
  })

  it('treats a region with only a small caption as not mostly text', () => {
    const region: Rect = { x: 0, y: 0, width: 400, height: 400 }
    const caption: TextBox = { x: 10, y: 380, width: 150, height: 12, chars: 20 }
    expect(regionIsMostlyText(region, [caption])).toBe(false)
  })

  it('treats a region densely covered by many lines of text as mostly text (the OCR-scan case)', () => {
    const region: Rect = { x: 0, y: 0, width: 400, height: 400 }
    const lines: TextBox[] = []
    for (let y = 0; y < 400; y += 20) {
      lines.push({ x: 10, y, width: 380, height: 14, chars: 60 })
    }
    expect(regionIsMostlyText(region, lines)).toBe(true)
  })

  it('requires a minimum amount of text even if coverage ratio alone would pass', () => {
    const region: Rect = { x: 0, y: 0, width: 100, height: 100 }
    const tinyBox: TextBox = { x: 0, y: 0, width: 100, height: 100, chars: 3 }
    expect(regionIsMostlyText(region, [tinyBox])).toBe(false)
  })

  it('returns false for a degenerate zero-area region', () => {
    const region: Rect = { x: 0, y: 0, width: 0, height: 0 }
    expect(regionIsMostlyText(region, [])).toBe(false)
  })
})
