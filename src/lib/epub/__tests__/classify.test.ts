import { describe, expect, it } from 'vitest'
import { classifyPages, detectEdgeGroups } from '../classify'
import { plainTextToHtml } from '../../textExtraction'

function span(text: string, x: number, y: number, fontSize: number): string {
  return `<span style="position:absolute;left:${x}px;top:${y}px;font-size:${fontSize}px;font-family:sans-serif;color:#000;white-space:pre;">${text}</span>`
}

function page(inner: string, width = 400, height = 600): string {
  return `<div style="position:relative;width:${width}px;height:${height}px;background:#fff;overflow:hidden;">${inner}</div>`
}

/** A single page of "body text" with a running header at the top, a page
 * number at the bottom, and a heading, using body font-size 12 and heading
 * font-size 20 — the shape most of these tests build multiple copies of to
 * get past the 3-page minimum repetition detection needs. */
function bodyPage(pageNum: number, headingText: string | null, bodyLines: string[], footnote?: string): string {
  // Every pair of distinct lines needs an explicit <br> (or <br><br> for a
  // paragraph gap) between them — the real extractor always inserts one
  // (see `separatorForGap`); without it, `parseLayoutPage` has no way to
  // tell two spans apart as separate lines at all; see `layoutParser.ts`'s
  // own doc comment for why it deliberately trusts that markup rather than
  // re-deriving line breaks from raw y-coordinates.
  const parts: string[] = []
  let y = 20
  parts.push(span('Running Title', 10, y, 9))
  parts.push('<br><br>')
  y += 30
  if (headingText) {
    parts.push(span(headingText, 10, y, 20))
    parts.push('<br><br>')
    y += 40
  }
  for (const line of bodyLines) {
    parts.push(span(line, 10, y, 12))
    parts.push('<br>')
    y += 20
  }
  parts.push('<br><br>')
  if (footnote) {
    parts.push(span(footnote, 10, 560, 9))
    parts.push('<br>')
  }
  parts.push(span(String(pageNum), 190, 580, 9))
  return page(parts.join(''))
}

describe('classifyPages: layout mode', () => {
  it('strips a running header and page-number footer repeated across pages', () => {
    const pages = [1, 2, 3, 4].map((n) => bodyPage(n, null, [`Body text on page ${n}.`]))
    const blocks = classifyPages(pages)
    const texts = blocks.map((b) => b.text)
    expect(texts.some((t) => t.includes('Running Title'))).toBe(false)
    expect(texts).not.toContain('1')
    expect(texts).not.toContain('2')
    expect(blocks.every((b) => b.type !== 'heading' || b.text !== 'Running Title')).toBe(true)
  })

  it('classifies a much-larger-font single line as a heading', () => {
    const pages = [1, 2, 3].map((n) => bodyPage(n, n === 1 ? 'Chapter One' : null, [`Body text ${n}.`]))
    const blocks = classifyPages(pages)
    const heading = blocks.find((b) => b.type === 'heading')
    expect(heading?.text).toBe('Chapter One')
    expect(heading?.level).toBe(1)
  })

  it('keeps body paragraphs as plain paragraph blocks', () => {
    const pages = [1, 2, 3].map((n) => bodyPage(n, null, [`This is ordinary body text on page ${n}.`]))
    const blocks = classifyPages(pages)
    const paragraph = blocks.find((b) => b.type === 'paragraph')
    expect(paragraph?.text).toContain('ordinary body text')
  })

  it('detects a small trailing line as a footnote, separate from body', () => {
    // Realistically long body text, so its characters dominate the
    // weighted body-font-size estimate the way a real page's would —
    // a page whose body text is barely longer than its header/footer/
    // footnote combined (unlike any real document) isn't what this
    // heuristic is meant to handle; see `estimateBodyFontSize`'s own doc
    // comment.
    const pages = [1, 2, 3].map((n) =>
      bodyPage(n, null, [`This is a full paragraph of ordinary body text on page ${n}, long enough to dominate the page's character count.`], n === 2 ? '1. This is a footnote explaining something.' : undefined),
    )
    const blocks = classifyPages(pages)
    const footnote = blocks.find((b) => b.type === 'footnote')
    expect(footnote?.text).toBe('1. This is a footnote explaining something.')
    // The footnote's own text never leaks into a body paragraph.
    expect(blocks.some((b) => b.type === 'paragraph' && b.text.includes('footnote explaining'))).toBe(false)
  })

  it('merges a sentence broken across a page boundary back into one paragraph', () => {
    const p1 = bodyPage(1, null, ['This sentence continues onto the next'])
    const p2 = bodyPage(2, null, ['page without a capital letter starting it.'])
    const blocks = classifyPages([p1, p2, bodyPage(3, null, ['Filler for page count.'])])
    const merged = blocks.find((b) => b.type === 'paragraph' && b.text.startsWith('This sentence continues'))
    expect(merged?.text).toBe('This sentence continues onto the next page without a capital letter starting it.')
  })

  it('does not merge two paragraphs that both read as complete sentences', () => {
    const p1 = bodyPage(1, null, ['A complete sentence ends here.'])
    const p2 = bodyPage(2, null, ['Another complete sentence starts here.'])
    const blocks = classifyPages([p1, p2, bodyPage(3, null, ['Filler for page count.'])])
    const paragraphs = blocks.filter((b) => b.type === 'paragraph')
    expect(paragraphs.some((b) => b.text === 'A complete sentence ends here.')).toBe(true)
    expect(paragraphs.some((b) => b.text === 'Another complete sentence starts here.')).toBe(true)
  })

  it('treats an ALL-CAPS isolated short line at body size as a heading', () => {
    const withHeading = [span('INTRODUCTION', 10, 20, 12), '<br><br>', span('Body text follows the caption.', 10, 60, 12), '<br>'].join('')
    const plain = (n: number) => [span(`Filler text on page ${n}.`, 10, 20, 12), '<br>'].join('')
    // Only page 1 has the all-caps line — if it repeated on every page it
    // would (correctly) look like a running header instead of a heading.
    const pages = [page(withHeading), page(plain(2)), page(plain(3))]
    const blocks = classifyPages(pages)
    expect(blocks.some((b) => b.type === 'heading' && b.text === 'INTRODUCTION')).toBe(true)
  })

  it('does not mistake an ordinary paragraph-to-paragraph gap for a section break', () => {
    // Regression test for a real bug found against actual extracted PDF
    // text: break detection used to compare a paragraph-to-paragraph gap
    // against the much smaller same-paragraph line-wrap gap, so almost
    // every ordinary paragraph boundary looked "unusually large" by
    // comparison and got wrongly flagged as a break. Every page here has
    // two single-line paragraphs separated by a perfectly ordinary
    // <br><br> gap and nothing else — there should be no `break` block
    // anywhere in the output.
    const twoParagraphPage = (n: number) =>
      page(
        [
          span('Running Title', 10, 20, 9),
          '<br><br>',
          span(`First paragraph on page ${n}.`, 10, 60, 12),
          '<br><br>',
          span(`Second paragraph on page ${n}.`, 10, 100, 12),
          '<br><br>',
          span(String(n), 190, 580, 9),
        ].join(''),
      )
    const blocks = classifyPages([1, 2, 3].map(twoParagraphPage))
    expect(blocks.some((b) => b.type === 'break')).toBe(false)
    expect(blocks.filter((b) => b.type === 'paragraph')).toHaveLength(6)
  })

  it('does detect a genuinely oversized gap between two paragraphs as a break', () => {
    const normalPage = (n: number) =>
      page(
        [span('Running Title', 10, 20, 9), '<br><br>', span(`Paragraph A on page ${n}.`, 10, 60, 12), '<br><br>', span(`Paragraph B on page ${n}.`, 10, 100, 12), '<br><br>', span(String(n), 190, 580, 9)].join(''),
      )
    // Page 3 leaves a much bigger gap (y jumps from 60 to 300 instead of
    // the usual ~40px) between its two paragraphs than every other page —
    // a deliberate scene break, not just normal paragraph spacing.
    const bigGapPage = page(
      [span('Running Title', 10, 20, 9), '<br><br>', span('Paragraph A on page 3.', 10, 60, 12), '<br><br>', span('Paragraph B on page 3.', 10, 300, 12), '<br><br>', span('3', 190, 580, 9)].join(''),
    )
    const blocks = classifyPages([normalPage(1), normalPage(2), bigGapPage, normalPage(4), normalPage(5)])
    expect(blocks.some((b) => b.type === 'break')).toBe(true)
  })

  it('does not touch header/footer detection on a document with too few pages', () => {
    const pages = [bodyPage(1, null, ['Only one page.'])]
    const blocks = classifyPages(pages)
    expect(blocks.some((b) => b.text.includes('Running Title'))).toBe(true)
  })

  it('returns an empty array for a source with no pages at all', () => {
    expect(classifyPages([])).toEqual([])
    expect(classifyPages(['', ''])).toEqual([])
  })

  it('still routes to the layout classifier when the first page is image-only (a cover/masthead page with no text)', () => {
    // Regression test for a real bug: a layout-mode page containing only
    // an <img> has `position: absolute` on the image but no `font-size`
    // anywhere (only a text <span> ever carries one), so it alone doesn't
    // look like layout-mode HTML. Sampling only the *first* non-empty page
    // to decide which classifier to use misrouted a genuinely layout-mode
    // document whose first page happened to be image-only (a cover photo,
    // a masthead) through the plain-mode classifier instead — which looks
    // for <p> tags the layout extractor never produces — so every page
    // parsed to zero lines and the resulting EPUB came out essentially
    // empty, even though the rest of the document was full of real,
    // properly-extracted text.
    const imageOnlyCoverPage = page('<img src="data:image/png;base64,x" alt="" style="position:absolute;left:0px;top:0px;width:400px;height:600px;">')
    const pages = [imageOnlyCoverPage, bodyPage(2, 'Introduction', ['Real body text on page two.']), bodyPage(3, null, ['More real body text on page three.'])]
    const blocks = classifyPages(pages)
    expect(blocks.some((b) => b.type === 'heading' && b.text === 'Introduction')).toBe(true)
    expect(blocks.some((b) => b.type === 'paragraph' && b.text.includes('Real body text'))).toBe(true)
  })
})

describe('classifyPages: plain mode', () => {
  it('routes plain-extractor HTML through the weaker plain-mode classifier without throwing', () => {
    const pages = [1, 2, 3].map((n) => plainTextToHtml(`Running Header\n\nThis is body text on page ${n}.\n\n${n}`))
    const blocks = classifyPages(pages)
    expect(blocks.length).toBeGreaterThan(0)
    // The repeated header/footer-shaped lines should be stripped just like in layout mode.
    expect(blocks.some((b) => b.text === 'Running Header')).toBe(false)
  })

  it('guesses a short, isolated, unpunctuated paragraph is a heading', () => {
    const pages = [plainTextToHtml('Chapter One\n\nA full sentence follows it, with punctuation.')]
    const blocks = classifyPages(pages)
    expect(blocks.find((b) => b.type === 'heading')?.text).toBe('Chapter One')
  })
})

describe('classifyPages: layout mode centered headings', () => {
  it('classifies a same-size, centered isolated line as a heading', () => {
    // "Chapter One" (11 chars) at height 12 estimates to ~66px wide; x=167
    // centers that on a 400px-wide page — well clear of the body's own
    // left margin (x=10) but not any larger a font, the shape a real
    // centered section title takes that font-size detection alone can't
    // catch.
    const centeredHeading = [span('Chapter One', 167, 20, 12), '<br><br>', span('Body text follows the centered title.', 10, 60, 12), '<br>'].join('')
    const plain = (n: number) => [span(`Filler text on page ${n}.`, 10, 20, 12), '<br>'].join('')
    const pages = [page(centeredHeading), page(plain(2)), page(plain(3))]
    const blocks = classifyPages(pages)
    expect(blocks.some((b) => b.type === 'heading' && b.text === 'Chapter One')).toBe(true)
  })

  it('does not mistake a short line merely offset from the margin (not actually centered) for a heading', () => {
    // Sits well clear of the left margin, same as a real centered heading
    // would, but far off toward the page's right edge rather than its
    // horizontal center.
    const rightAligned = [span('Signed, X.', 300, 20, 12), '<br><br>', span('Body text follows.', 10, 60, 12), '<br>'].join('')
    const plain = (n: number) => [span(`Filler text on page ${n}.`, 10, 20, 12), '<br>'].join('')
    const pages = [page(rightAligned), page(plain(2)), page(plain(3))]
    const blocks = classifyPages(pages)
    expect(blocks.some((b) => b.type === 'heading' && b.text === 'Signed, X.')).toBe(false)
  })
})

describe('classifyPages: layout mode footnote paragraph gaps', () => {
  it('splits multiple unmarked footnotes on the same page at paragraph gaps, not just explicit markers', () => {
    const withFootnotes = page(
      [
        span('Running Title', 10, 20, 9),
        '<br><br>',
        span("This is a full paragraph of ordinary body text on page 2, long enough to dominate the page's character count.", 10, 60, 12),
        '<br><br>',
        span('First unmarked footnote text.', 10, 540, 9),
        '<br><br>',
        span('Second unmarked footnote text.', 10, 560, 9),
        '<br>',
        span('2', 190, 580, 9),
      ].join(''),
    )
    const plain = (n: number) =>
      page(
        [
          span('Running Title', 10, 20, 9),
          '<br><br>',
          span(`This is a full paragraph of ordinary body text on page ${n}, long enough to dominate the page's character count.`, 10, 60, 12),
          '<br><br>',
          span(String(n), 190, 580, 9),
        ].join(''),
      )
    const blocks = classifyPages([plain(1), withFootnotes, plain(3)])
    const footnotes = blocks.filter((b) => b.type === 'footnote')
    expect(footnotes.map((f) => f.text)).toEqual(['First unmarked footnote text.', 'Second unmarked footnote text.'])
  })
})

describe('detectEdgeGroups', () => {
  it('returns every repeated header/footer candidate, flagged with whether it meets the automatic threshold', () => {
    const pages = [1, 2, 3, 4].map((n) => bodyPage(n, null, [`Body text on page ${n}.`]))
    const { header, footer } = detectEdgeGroups(pages)
    expect(header.some((g) => g.sampleText === 'Running Title' && g.suggested && g.pages.length === 4)).toBe(true)
    expect(footer.some((g) => g.suggested)).toBe(true) // the running page-number footer
  })

  it('suggests nothing on a document with too few pages to detect repetition', () => {
    const pages = [bodyPage(1, null, ['Only one page.'])]
    const { header, footer } = detectEdgeGroups(pages)
    expect(header.every((g) => !g.suggested)).toBe(true)
    expect(footer.every((g) => !g.suggested)).toBe(true)
  })

  it('returns a candidate that falls short of the automatic threshold too, just not suggested', () => {
    // "Special Note" repeats on only 2 of 5 pages — below the threshold for
    // 5 pages (max(3, ceil(5*0.4)) = 3) — so it should show up as a
    // candidate a person could still confirm, just not pre-suggested.
    const withNote = (n: number) => page([span('Special Note', 10, 15, 9), '<br><br>', span(`Body text on page ${n}.`, 10, 200, 12), '<br>'].join(''))
    const withoutNote = (n: number) => page([span(`Body text on page ${n}.`, 10, 200, 12), '<br>'].join(''))
    const pages = [withNote(1), withoutNote(2), withNote(3), withoutNote(4), withoutNote(5)]
    const { header } = detectEdgeGroups(pages)
    const group = header.find((g) => g.sampleText === 'Special Note')
    expect(group?.suggested).toBe(false)
    expect(group?.pages).toEqual([1, 3])
  })
})

describe('classifyPages: EdgeOverride', () => {
  it('rejecting every header candidate keeps it as ordinary body text', () => {
    const pages = [1, 2, 3, 4].map((n) => bodyPage(n, null, [`Body text on page ${n}.`]))
    const blocks = classifyPages(pages, { header: new Set() })
    expect(blocks.some((b) => b.text.includes('Running Title'))).toBe(true)
  })

  it('a person can force-accept a header candidate that fell just short of the automatic threshold', () => {
    const withNote = (n: number) => page([span('Special Note', 10, 15, 9), '<br><br>', span(`Body text on page ${n}.`, 10, 200, 12), '<br>'].join(''))
    const withoutNote = (n: number) => page([span(`Body text on page ${n}.`, 10, 200, 12), '<br>'].join(''))
    const pages = [withNote(1), withoutNote(2), withNote(3), withoutNote(4), withoutNote(5)]
    const { header } = detectEdgeGroups(pages)
    const group = header.find((g) => g.sampleText === 'Special Note')!
    expect(group.suggested).toBe(false)

    const defaultBlocks = classifyPages(pages)
    expect(defaultBlocks.some((b) => b.text === 'Special Note')).toBe(true)

    const overridden = classifyPages(pages, { header: new Set([group.key]) })
    expect(overridden.some((b) => b.text === 'Special Note')).toBe(false)
  })
})
