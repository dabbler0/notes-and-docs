/**
 * Reduces one page's `'layout'`-mode `pageHtml` (see
 * `lib/textExtraction.ts`'s `extractLayoutPageHtml`) back down to an ordered
 * list of text lines, each carrying the position/size metadata the EPUB
 * classifier needs (`classify.ts`) that plain reading-order text alone
 * doesn't have: a line's vertical position on the page (for spotting a
 * running header/footer or a footnote block, which live in predictable
 * places) and its font size (for spotting a heading, which is usually
 * bigger than body text).
 *
 * Deliberately walks the extractor's own DOM structure rather than
 * re-deriving line breaks from scratch off each run's raw (x, y) — the
 * extractor already decided, per pair of adjacent runs, whether they sit on
 * the same line (`&nbsp;`), wrap to a new one (`<br>`), or start a new
 * paragraph (`<br><br>`) via its own gap heuristic (`separatorForGap`,
 * shared with the plain extractor's own reflow). Re-deriving that from y/x
 * clustering here too would duplicate that heuristic and could easily
 * disagree with it; reading the `<br>` markup instead reuses the same
 * decision that already went into producing this HTML in the first place.
 */
export interface LayoutLine {
  /** Top of the line's own bounding box, in the page's own coordinate space (same units as `pageHeight`). */
  y: number
  /** Left edge of the line's first run, in the page's own coordinate space (same units as `pageWidth`) — lets `classify.ts` notice a line that's centered rather than flush with the body's usual left margin, a heading convention font-size alone can't catch (a centered title set in the same size as body text). */
  x: number
  /** The line's dominant font size — the tallest run on it, in case of a mixed-size line (rare, but a stray superscript shouldn't set the whole line's height). */
  height: number
  text: string
  /** True when a `<br><br>` (paragraph gap) — not just a single `<br>` (line wrap) — separates this line from whatever came before it on the page. Always true for a page's very first line, whose real relationship to the previous page is decided by `classify.ts`, not here. */
  newParagraph: boolean
}

export interface ParsedLayoutPage {
  pageHeight: number
  pageWidth: number
  lines: LayoutLine[]
}

/**
 * Layout-mode `pageHtml` is the only shape that ever puts an inline
 * `position: absolute` + `font-size` style on a `<span>` — the plain
 * extractor's output is bare `<p>`/`<br>` with no attributes at all (see
 * `plainTextToHtml`). Good enough to route a source to the right classifier
 * without needing to know which mode originally produced it (not currently
 * stored on `Source` — see that type's own doc comment on `pageHtml`).
 */
export function isLayoutHtml(html: string): boolean {
  return /position:\s*absolute/.test(html) && /font-size:\s*[\d.]/.test(html)
}

function styleNum(style: string, prop: string): number | null {
  const m = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(-?[\\d.]+)px`))
  return m ? parseFloat(m[1]) : null
}

export function parseLayoutPage(html: string): ParsedLayoutPage {
  if (!html) return { pageHeight: 0, pageWidth: 0, lines: [] }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const outer = doc.body.firstElementChild
  if (!outer) return { pageHeight: 0, pageWidth: 0, lines: [] }
  const outerStyle = outer.getAttribute('style') || ''
  const pageHeight = styleNum(outerStyle, 'height') ?? 0
  const pageWidth = styleNum(outerStyle, 'width') ?? 0

  const lines: LayoutLine[] = []
  let current: { text: string; x: number; y: number; height: number }[] | null = null
  let currentIsNewParagraph = true
  let brStreak = 0

  function finishLine() {
    if (current && current.length > 0) {
      const text = current
        .map((r) => r.text)
        .join('')
        .replace(/ /g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
      if (text) lines.push({ y: current[0].y, x: current[0].x, height: Math.max(...current.map((r) => r.height)), text, newParagraph: currentIsNewParagraph })
    }
    current = null
  }

  function startLineIfNeeded() {
    if (current === null) {
      current = []
      currentIsNewParagraph = brStreak >= 2 || lines.length === 0
    }
  }

  for (const node of Array.from(outer.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      if (el.tagName === 'SPAN') {
        startLineIfNeeded()
        const style = el.getAttribute('style') || ''
        current!.push({ text: el.textContent || '', x: styleNum(style, 'left') ?? 0, y: styleNum(style, 'top') ?? 0, height: styleNum(style, 'font-size') ?? 10 })
        brStreak = 0
      } else if (el.tagName === 'BR') {
        finishLine()
        brStreak++
      }
      // <img>: no text, doesn't affect line/paragraph structure either way.
    } else if (node.nodeType === Node.TEXT_NODE) {
      // The literal `&nbsp;` (or occasional stray whitespace) the extractor
      // leaves between two runs on the same line.
      startLineIfNeeded()
      const last = current![current!.length - 1]
      current!.push({ text: node.textContent || '', x: last?.x ?? 0, y: last?.y ?? 0, height: last?.height ?? 10 })
      brStreak = 0
    }
  }
  finishLine()

  return { pageHeight, pageWidth, lines }
}
