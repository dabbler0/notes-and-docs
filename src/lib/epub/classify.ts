/**
 * Turns a source's already-extracted `pageHtml` into an ordered `DocBlock[]`
 * — the structural guess (headings, body paragraphs, footnotes, section
 * breaks) `buildEpub.ts` needs to produce a real, navigable EPUB instead of
 * one long undifferentiated blob of text. Best-effort by nature: nothing
 * about `pageHtml` says "this line is a running header" or "this paragraph
 * is a section title," so every signal here is inferred from position,
 * repetition, and font size, and can guess wrong on an unusual layout —
 * same spirit as `lib/citationParse.ts`'s best-effort citation parsing.
 *
 * Two extraction modes produce very different raw material (see
 * `lib/textExtraction.ts`), so there are two classifiers:
 *
 * - `'layout'` mode keeps each run's real position and font size, which is
 *   most of what makes any of this possible: a running header/footer lives
 *   in a predictable band at the top/bottom of every page, a footnote is
 *   reliably *smaller* than body text, and a section heading is reliably
 *   *larger*. `classifyLayoutPages` uses all three.
 * - `'plain'` mode has thrown all of that away — every page is bare
 *   `<p>`/`<br>` HTML with no position or size information at all — so
 *   `classifyPlainPages` can only lean on repetition (a running
 *   header/footer's *text* still repeats near the top/bottom of many pages)
 *   and a few textual conventions (a short, punctuation-free, isolated line
 *   reads as a heading; a line starting with a digit/symbol marker at a
 *   page's tail reads as a footnote) — meaningfully weaker, and footnote
 *   detection in particular is far less reliable without a font-size cue to
 *   confirm it, but still better than treating the whole document as one
 *   undifferentiated stream.
 */
import { htmlToPlainText } from '../textExtraction'
import { isLayoutHtml, parseLayoutPage, type LayoutLine } from './layoutParser'
import type { BlockType, DocBlock } from './types'

const FOOTNOTE_MARKER_RE = /^(\d{1,3}|[*†‡§¶])[.):]?\s+/
const MIN_PAGES_FOR_EDGE_DETECTION = 3
const EDGE_BAND_FRACTION = 0.12

/**
 * Which classifier a source's `pageHtml` actually needs is decided by
 * checking *every* non-empty page for the layout extractor's signature,
 * not just the first one — a layout-mode page containing only an image
 * (a masthead/cover photo, a full-page figure, anything with no running
 * text on it at all) has `position: absolute` on its `<img>` but no
 * `font-size` anywhere, since only a text `<span>` ever carries one (see
 * `isLayoutHtml`'s own doc comment). Sampling only the first non-empty
 * page — the original version of this function — misclassified exactly
 * this as `'plain'`-mode whenever a genuinely layout-mode document's
 * *first* page happened to be image-only, routing the whole document
 * through `classifyPlainPages`, which looks for `<p>` tags the layout
 * extractor never produces at all: every page then parsed to zero lines,
 * and the resulting EPUB came out essentially empty. Confirmed directly
 * as a real bug, not a hypothetical. Checking every page instead costs a
 * few extra cheap regex tests but only has to find *one* real text page
 * to route correctly.
 */
export function classifyPages(pageHtml: string[]): DocBlock[] {
  const nonEmpty = pageHtml.filter((h) => h && h.trim())
  if (nonEmpty.length === 0) return []
  return nonEmpty.some(isLayoutHtml) ? classifyLayoutPages(pageHtml) : classifyPlainPages(pageHtml)
}

// ---- shared: repetition-based running header/footer detection -----------

function normalizeForRepetition(text: string): string {
  return text.trim().toLowerCase().replace(/\d+/g, '#')
}

/** Given one representative candidate line per page per edge (top/bottom),
 * decides which candidates are actually a *running* header/footer rather
 * than ordinary page content that happens to sit near an edge — repeated
 * (after digits are folded to a placeholder, so a page number counts as
 * "repeating" against itself) on a large enough fraction of pages. Returns
 * the set of page numbers where the top/bottom candidate should be
 * excluded from the body. Requires a minimum page count: a 1-2 page
 * document doesn't have enough samples for "repeats across pages" to mean
 * anything, so nothing gets stripped rather than risk a false positive on
 * genuine content. */
function repeatedEdgePages(candidates: { page: number; text: string }[], totalPages: number): Set<number> {
  const excluded = new Set<number>()
  if (totalPages < MIN_PAGES_FOR_EDGE_DETECTION || candidates.length === 0) return excluded
  const groups = new Map<string, number[]>()
  for (const c of candidates) {
    const key = normalizeForRepetition(c.text)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(c.page)
  }
  const threshold = Math.max(3, Math.ceil(totalPages * 0.4))
  for (const pages of groups.values()) {
    if (pages.length >= threshold) pages.forEach((p) => excluded.add(p))
  }
  return excluded
}

// ---- layout-mode classifier -----------------------------------------------

interface ParagraphUnit {
  lines: LayoutLine[]
  startY: number
  endY: number
  height: number
}

function groupLinesIntoParagraphs(lines: LayoutLine[]): ParagraphUnit[] {
  const units: ParagraphUnit[] = []
  let current: LayoutLine[] = []
  for (const line of lines) {
    const prev = current[current.length - 1]
    const startsNew = current.length === 0 || line.newParagraph || (prev && Math.abs(line.height - prev.height) > 1)
    if (startsNew && current.length > 0) {
      units.push(finishParagraph(current))
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) units.push(finishParagraph(current))
  return units
}

function finishParagraph(lines: LayoutLine[]): ParagraphUnit {
  const last = lines[lines.length - 1]
  return {
    lines,
    startY: lines[0].y,
    endY: last.y + last.height,
    height: Math.max(...lines.map((l) => l.height)),
  }
}

function paragraphText(unit: ParagraphUnit): string {
  return unit.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim()
}

/** The weighted-mode line height across the document — weighted by
 * character count so a document's actual body text (the overwhelming bulk
 * of its characters) determines this, not a handful of short, differently-
 * sized headings or captions outvoting it by line count alone. */
function estimateBodyFontSize(allLines: LayoutLine[]): number {
  if (allLines.length === 0) return 12
  const weights = new Map<number, number>()
  for (const line of allLines) {
    const bucket = Math.round(line.height * 2) / 2 // nearest 0.5px
    weights.set(bucket, (weights.get(bucket) ?? 0) + Math.max(1, line.text.length))
  }
  let best = allLines[0].height
  let bestWeight = -1
  for (const [size, weight] of weights) {
    if (weight > bestWeight) {
      bestWeight = weight
      best = size
    }
  }
  return best
}

function looksAllCaps(text: string): boolean {
  return /[A-Z]/.test(text) && text === text.toUpperCase()
}

/** Best-effort split of a page's trailing small-font lines into individual
 * footnotes. Scanning from the *bottom* of the page upward for a
 * contiguous run of undersized lines (rather than scanning the whole page
 * for any small text) means an unrelated small caption sitting mid-page —
 * under a figure, say — isn't swept in as a footnote just for being small;
 * only a block that actually trails off the bottom of the page qualifies,
 * which is where a real footnote block always lives. */
function splitFootnoteBlock(lines: LayoutLine[], bodyFontSize: number): { body: LayoutLine[]; footnoteLines: LayoutLine[] } {
  const threshold = bodyFontSize * 0.85
  let cut = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].height < threshold) cut = i
    else break
  }
  return { body: lines.slice(0, cut), footnoteLines: lines.slice(cut) }
}

function footnotesFromBlockLines(lines: LayoutLine[]): string[] {
  const notes: string[] = []
  for (const line of lines) {
    if (FOOTNOTE_MARKER_RE.test(line.text) || notes.length === 0) {
      notes.push(line.text)
    } else {
      notes[notes.length - 1] += ' ' + line.text
    }
  }
  return notes.map((n) => n.trim()).filter(Boolean)
}

function classifyLayoutPages(pageHtml: string[]): DocBlock[] {
  const pages = pageHtml.map((html, i) => ({ page: i + 1, ...parseLayoutPage(html) }))
  const allLines = pages.flatMap((p) => p.lines)
  if (allLines.length === 0) return []
  const bodyFontSize = estimateBodyFontSize(allLines)

  // Running headers/footers: one representative candidate per page per edge
  // — the first line inside the top band, the last line inside the bottom
  // band — since a genuine running head/foot is a single line, and taking
  // every line that happens to fall in the band would risk sweeping in the
  // page's real opening/closing content on a page with a tall header.
  const topCandidates: { page: number; text: string }[] = []
  const bottomCandidates: { page: number; text: string }[] = []
  for (const p of pages) {
    if (p.pageHeight <= 0) continue
    const topBand = p.pageHeight * EDGE_BAND_FRACTION
    const bottomBand = p.pageHeight * (1 - EDGE_BAND_FRACTION)
    const top = p.lines.find((l) => l.y <= topBand)
    if (top) topCandidates.push({ page: p.page, text: top.text })
    const bottom = [...p.lines].reverse().find((l) => l.y >= bottomBand)
    if (bottom) bottomCandidates.push({ page: p.page, text: bottom.text })
  }
  const totalPages = pages.length
  const headerPages = repeatedEdgePages(topCandidates, totalPages)
  const footerPages = repeatedEdgePages(bottomCandidates, totalPages)
  const headerText = new Map(topCandidates.map((c) => [c.page, c.text]))
  const footerText = new Map(bottomCandidates.map((c) => [c.page, c.text]))

  // Heading font-size buckets: every distinct size that's meaningfully
  // bigger than body text, largest first, mapped to levels 1, 2, 3, ...
  // (capped at 3 — EPUB nav gets unwieldy past a few levels, and a document
  // whose headings actually need more than 3 distinct sizes is rare).
  const largeSizes = Array.from(new Set(allLines.filter((l) => l.height > bodyFontSize * 1.15).map((l) => Math.round(l.height))))
    .sort((a, b) => b - a)
  function levelForSize(size: number): number {
    const idx = largeSizes.findIndex((s) => Math.abs(s - Math.round(size)) <= 1)
    return Math.min(3, idx === -1 ? largeSizes.length + 1 : idx + 1)
  }

  function classifyUnit(unit: ParagraphUnit, text: string): { type: BlockType; level?: number } {
    const singleLine = unit.lines.length === 1
    if (singleLine && unit.height > bodyFontSize * 1.15) {
      return { type: 'heading', level: levelForSize(unit.height) }
    }
    if (singleLine && text.length <= 80 && !/[,;]$/.test(text) && looksAllCaps(text)) {
      return { type: 'heading', level: largeSizes.length > 0 ? Math.min(3, largeSizes.length + 1) : 1 }
    }
    return { type: 'paragraph' }
  }

  // First pass: per-page line/paragraph grouping, done once and reused by
  // both the gap-statistics pass below and the emission pass after it.
  const perPage = pages.map((p) => {
    const headerLine = headerPages.has(p.page) ? headerText.get(p.page) : undefined
    const footerLine = footerPages.has(p.page) ? footerText.get(p.page) : undefined
    const bodyLines = p.lines.filter((l) => l.text !== headerLine && l.text !== footerLine)
    const { body: contentLines, footnoteLines } = splitFootnoteBlock(bodyLines, bodyFontSize)
    const units = groupLinesIntoParagraphs(contentLines)
    return { page: p.page, units, footnoteLines }
  })

  // A section break is only a *deliberate*, unusually large gap the author
  // left between two ordinary body paragraphs — meaningful only relative to
  // how much space this document normally puts between two paragraphs, not
  // relative to the (much smaller) gap between two wrapped lines *within*
  // one paragraph, which is a different measurement on a different scale
  // and was the previous version of this heuristic's actual bug: comparing
  // a paragraph-to-paragraph gap against a same-paragraph line-wrap gap
  // meant almost every ordinary paragraph boundary looked "unusually large"
  // by comparison and got misflagged as a break. Collected document-wide
  // (rather than per-page) since a single page often has too few paragraph
  // transitions on its own to calibrate against; with too few samples
  // altogether, break detection is skipped rather than guessed from an
  // arbitrary fallback constant.
  const paragraphGaps: number[] = []
  for (const { units } of perPage) {
    for (let i = 1; i < units.length; i++) {
      const prevText = paragraphText(units[i - 1])
      const text = paragraphText(units[i])
      if (!prevText || !text) continue
      if (classifyUnit(units[i - 1], prevText).type !== 'paragraph' || classifyUnit(units[i], text).type !== 'paragraph') continue
      paragraphGaps.push(units[i].startY - units[i - 1].endY)
    }
  }
  paragraphGaps.sort((a, b) => a - b)
  const typicalParagraphGap = paragraphGaps.length > 0 ? paragraphGaps[Math.floor(paragraphGaps.length / 2)] : null
  const canDetectBreaks = paragraphGaps.length >= 3

  const blocks: DocBlock[] = []
  let openParagraph: { block: DocBlock; endsWithSentence: boolean } | null = null

  for (const { page, units, footnoteLines } of perPage) {
    let prevUnitClassifiedParagraph: ParagraphUnit | null = null
    for (const unit of units) {
      const text = paragraphText(unit)
      if (!text) continue
      const { type, level } = classifyUnit(unit, text)

      if (type === 'paragraph' && prevUnitClassifiedParagraph && canDetectBreaks && typicalParagraphGap !== null) {
        const gap = unit.startY - prevUnitClassifiedParagraph.endY
        if (gap > typicalParagraphGap * 1.8 && gap - typicalParagraphGap > bodyFontSize) {
          blocks.push({ type: 'break', text: '', page })
          openParagraph = null
        }
      }

      if (type === 'paragraph') {
        // Cross-page sentence continuation: a body paragraph that doesn't
        // end mid-sentence has nothing to merge into, and a fresh paragraph
        // that doesn't *start* mid-sentence (capital letter, or anything
        // other than a lowercase continuation) is never merged backward —
        // this only fires for the specific, low-false-positive case of a
        // sentence visibly broken across a page boundary by pagination
        // alone, not for two paragraphs that simply happen to sit next to
        // each other.
        if (openParagraph && !openParagraph.endsWithSentence && /^[a-z]/.test(text)) {
          openParagraph.block.text = `${openParagraph.block.text} ${text}`.trim()
          openParagraph.endsWithSentence = /[.!?"'”’)]$/.test(text)
          prevUnitClassifiedParagraph = unit
          continue
        }
        const block: DocBlock = { type, text, page }
        blocks.push(block)
        openParagraph = { block, endsWithSentence: /[.!?"'”’)]$/.test(text) }
        prevUnitClassifiedParagraph = unit
      } else {
        blocks.push({ type, text, level, page })
        openParagraph = null
        prevUnitClassifiedParagraph = null
      }
    }

    for (const note of footnotesFromBlockLines(footnoteLines)) {
      blocks.push({ type: 'footnote', text: note, page })
    }
  }

  return blocks
}

// ---- plain-mode classifier -------------------------------------------------

interface PlainLine {
  page: number
  paragraphIndex: number
  lineIndexInParagraph: number
  linesInParagraph: number
  text: string
}

function parsePlainPage(html: string, page: number): PlainLine[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const out: PlainLine[] = []
  const paragraphs = Array.from(doc.body.querySelectorAll('p'))
  paragraphs.forEach((p, paragraphIndex) => {
    const lines = htmlToPlainText(p.innerHTML)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    lines.forEach((text, lineIndexInParagraph) => out.push({ page, paragraphIndex, lineIndexInParagraph, linesInParagraph: lines.length, text }))
  })
  return out
}

/**
 * Weaker sibling of `classifyLayoutPages` for a source extracted with the
 * default `'plain'` mode, which keeps reading-order paragraphs but throws
 * away every bit of position/size information (see this file's own doc
 * comment). Running headers/footers still work reasonably well (repetition
 * alone gets most of the way there); headings are guessed from being a
 * short, isolated, punctuation-free single-line paragraph; footnotes are
 * guessed from a marker-prefixed short paragraph near a page's end — both
 * considerably less reliable without a font-size cue to confirm them, so
 * false negatives (an un-detected heading rendered as an ordinary
 * paragraph) are expected and are the honest failure mode here, not a bug.
 */
function classifyPlainPages(pageHtml: string[]): DocBlock[] {
  const pages = pageHtml.map((html, i) => parsePlainPage(html, i + 1))
  const totalPages = pages.length

  const topCandidates: { page: number; text: string }[] = []
  const bottomCandidates: { page: number; text: string }[] = []
  pages.forEach((lines, i) => {
    if (lines.length === 0) return
    topCandidates.push({ page: i + 1, text: lines[0].text })
    bottomCandidates.push({ page: i + 1, text: lines[lines.length - 1].text })
  })
  const headerPages = repeatedEdgePages(topCandidates, totalPages)
  const footerPages = repeatedEdgePages(bottomCandidates, totalPages)
  const headerText = new Map(topCandidates.map((c) => [c.page, c.text]))
  const footerText = new Map(bottomCandidates.map((c) => [c.page, c.text]))

  const blocks: DocBlock[] = []
  pages.forEach((lines, pageIdx) => {
    const page = pageIdx + 1
    const filtered = lines.filter((l) => !(headerPages.has(page) && l.text === headerText.get(page)) && !(footerPages.has(page) && l.text === footerText.get(page)))

    // Trailing marker-led short paragraphs read as footnotes; everything
    // before them is body.
    let footnoteStart = filtered.length
    for (let i = filtered.length - 1; i >= 0; i--) {
      const l = filtered[i]
      const isParagraphStart = l.lineIndexInParagraph === 0
      if (isParagraphStart && l.linesInParagraph <= 2 && FOOTNOTE_MARKER_RE.test(l.text)) {
        footnoteStart = i
      } else if (l.lineIndexInParagraph === 0) {
        break
      }
    }
    const bodyLines = filtered.slice(0, footnoteStart)
    const footnoteLines = filtered.slice(footnoteStart)

    // Group back into paragraphs (paragraphIndex boundaries), classify each
    // single-line, short, punctuation-free, isolated paragraph as a heading.
    const paragraphs = new Map<number, string[]>()
    for (const l of bodyLines) {
      if (!paragraphs.has(l.paragraphIndex)) paragraphs.set(l.paragraphIndex, [])
      paragraphs.get(l.paragraphIndex)!.push(l.text)
    }
    for (const paraLines of paragraphs.values()) {
      const text = paraLines.join(' ').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const isHeadingCandidate = paraLines.length === 1 && text.length <= 80 && !/[,;]$/.test(text) && (looksAllCaps(text) || !/[.!?]$/.test(text))
      if (isHeadingCandidate) {
        blocks.push({ type: 'heading', text, level: 1, page })
      } else {
        blocks.push({ type: 'paragraph', text, page })
      }
    }

    const notes: string[] = []
    for (const l of footnoteLines) {
      if (FOOTNOTE_MARKER_RE.test(l.text) || notes.length === 0) notes.push(l.text)
      else notes[notes.length - 1] += ' ' + l.text
    }
    for (const note of notes) {
      const trimmed = note.trim()
      if (trimmed) blocks.push({ type: 'footnote', text: trimmed, page })
    }
  })

  return blocks
}
