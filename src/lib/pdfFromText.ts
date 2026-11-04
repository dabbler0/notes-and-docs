/**
 * Renders a text-only source's extracted `pageHtml` into a brand new PDF —
 * a usable downloadable file when there's no original PDF left to hand out
 * byte-for-byte (see `handleDownloadPdf` in SourceWorkspace.tsx, used
 * whenever `source.pdfBlobId` is still around — this is the fallback for
 * everywhere that isn't true, including a source converted via "Discard
 * PDF, keep text only").
 *
 * Two different output shapes, chosen per page by what `pageHtml` actually
 * contains (`isLayoutPageHtml`):
 *
 * - Layout-mode `pageHtml` (`extractLayoutPageHtml` in `lib/textExtraction.ts`
 *   — the sole extractor for a while now, so this is what almost every real
 *   source's `pageHtml` actually looks like) already carries each text run's
 *   own position, size, color, and any recovered images, each as its own
 *   absolutely-positioned element inside a page-sized wrapper `<div>`. This
 *   renderer reads that positioning straight back out and draws each run/
 *   image at its own real spot on a PDF page sized to match the original —
 *   not just reflowed into plain running paragraphs — so columns, captions,
 *   footnotes, and figures land back where they were instead of being
 *   flattened into one linear stream of text.
 * - Older/legacy `pageHtml` (migrated plain text, or a source extracted
 *   before layout extraction existed) has no position information at all —
 *   just plain `<p>`/`<br>` structure — and falls back to the original
 *   flowing-paragraph rendering this file always used: one continuous body
 *   of text, paginated as it overflows, with a "— page N —" marker between
 *   each original page's worth of text.
 *
 * Built with `pdf-lib` alone, already a dependency for the OCR text-layer
 * work in `lib/ocr.ts` — no extra font-embedding library (`fontkit`),
 * which isn't installed here, so both renderers are limited to pdf-lib's
 * built-in Standard 14 fonts and their WinAnsiEncoding character set
 * (ordinary Latin-script text, accented Latin letters included, plus the
 * common "smart" typography substituted below). A character outside that —
 * most CJK/Cyrillic/Greek text, mathematical symbols — can't be drawn at
 * all and falls back to a literal `?`. Acceptable for a lightweight
 * fallback export of mostly-Latin-script academic text; not meant to
 * replace the original. The layout-mode renderer has one further
 * limitation beyond the flowing one's: it has no way to non-uniformly
 * squeeze a run horizontally the way a real browser rendering it can
 * (`extractLayoutPageHtml`'s own `scaleX`, there to correct for
 * font-substitution/OCR width mismatches) — pdf-lib's text drawing has no
 * equivalent, so an occasional run may run slightly wider than its
 * original box instead.
 */
import { PDFDocument, StandardFonts, rgb, degrees, type Color, type PDFFont, type PDFPage } from 'pdf-lib'
import { htmlToPlainText } from './textExtraction'

const PAGE_WIDTH = 612 // US Letter, in points
const PAGE_HEIGHT = 792
const MARGIN = 56
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2
const BODY_SIZE = 10.5
const BODY_LEADING = 14
const PARAGRAPH_GAP = 6
const TITLE_SIZE = 16
const TITLE_LEADING = 21
const SUBTITLE_SIZE = 10
const SUBTITLE_LEADING = 14
const MARKER_SIZE = 8
const INK = rgb(0.1, 0.1, 0.1)
const MUTED = rgb(0.45, 0.45, 0.45)

/**
 * Typographic characters common in real-world extracted text that
 * WinAnsiEncoding's Standard 14 fonts can't draw without `fontkit` —
 * mapped to plain-ASCII equivalents so the common case (curly quotes, an
 * em dash, an ellipsis) still looks intentional, rather than falling
 * through to `sanitizeForFont`'s catch-all `?` below.
 */
const TYPOGRAPHIC_FALLBACKS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': ',',
  '“': '"',
  '”': '"',
  '„': '"',
  '–': '-',
  '—': '--',
  '−': '-',
  '…': '...',
  '•': '*',
  ' ': ' ',
  '­': '',
}

function sanitizeForFont(text: string, supported: Set<number>): string {
  let out = ''
  for (const ch of text) {
    const mapped = TYPOGRAPHIC_FALLBACKS[ch]
    if (mapped !== undefined) {
      out += mapped
      continue
    }
    out += supported.has(ch.codePointAt(0)!) ? ch : '?'
  }
  return out
}

/**
 * Greedy word-wrap against `font`'s own metrics — a word longer than
 * `maxWidth` on its own (a long URL, say) is kept whole on its own line
 * rather than split mid-word. `text` must already be sanitized for
 * `font`'s character set (`sanitizeForFont`) before this is called:
 * `widthOfTextAtSize` throws outright on a character the font can't
 * encode, rather than measuring it as anything — the `?` fallback has to
 * already be in place for the one measurement this function needs to be
 * able to trust.
 */
function wrapParagraph(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const lines: string[] = []
  let current = words[0]
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`
    if (font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  lines.push(current)
  return lines
}

export interface SimplePdfOptions {
  title: string
  /** A one-paragraph formatted citation, shown under the title on the first page — e.g. `formatCitation(source.bibtex)`. Omitted if blank. */
  subtitle?: string
  /** One entry per original source page, in order — real HTML (`Source.pageHtml`). */
  pageHtml: string[]
}

/**
 * Layout-mode `pageHtml`'s own fixed shape (`extractLayoutPageHtml`): one
 * `<div style="position:relative;width:…px;height:…px;…">` wrapping every
 * run/image for that page, each absolutely positioned — nothing else ever
 * produces a page-sized positioned wrapper like this, so its presence
 * alone is enough to tell a layout-mode page apart from legacy/plain
 * `<p>`/`<br>` HTML (`plainTextToHtml`, or whatever the now-removed plain
 * extractor used to produce), which has no wrapping element at all.
 */
function isLayoutPageHtml(html: string): boolean {
  if (!html) return false
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const root = dom.body.firstElementChild
  return !!root && root.tagName === 'DIV' && (root as HTMLElement).style.position === 'relative' && (root as HTMLElement).style.width !== '' && (root as HTMLElement).style.height !== ''
}

export async function buildSimplePdfFromText({ title, subtitle, pageHtml }: SimplePdfOptions): Promise<Uint8Array> {
  if (pageHtml.some(isLayoutPageHtml)) return buildLayoutAwarePdf({ title, subtitle, pageHtml })
  return buildFlowingPdf({ title, subtitle, pageHtml })
}

/** The original, position-blind renderer — one continuous flowing body of text, paginated as it overflows. Used whenever none of `pageHtml` is layout-mode (see `isLayoutPageHtml`): a source extracted before layout extraction existed, or migrated from old plain-text storage, has no position information to render with in the first place. */
async function buildFlowingPdf({ title, subtitle, pageHtml }: SimplePdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)
  const supported = new Set(font.getCharacterSet())
  const supportedBold = new Set(boldFont.getCharacterSet())

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let cursorY = PAGE_HEIGHT - MARGIN

  function drawLine(line: string, opts: { font: PDFFont; size: number; leading: number; color: Color; supported: Set<number>; center?: boolean }) {
    if (cursorY - opts.leading < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
      cursorY = PAGE_HEIGHT - MARGIN
    }
    const text = sanitizeForFont(line, opts.supported)
    const x = opts.center ? MARGIN + (CONTENT_WIDTH - opts.font.widthOfTextAtSize(text, opts.size)) / 2 : MARGIN
    page.drawText(text, { x, y: cursorY - opts.size, size: opts.size, font: opts.font, color: opts.color })
    cursorY -= opts.leading
  }

  // Title + subtitle, first page only — everything below is the body.
  for (const line of wrapParagraph(sanitizeForFont(title || 'Untitled source', supportedBold), boldFont, TITLE_SIZE, CONTENT_WIDTH)) {
    drawLine(line, { font: boldFont, size: TITLE_SIZE, leading: TITLE_LEADING, color: INK, supported: supportedBold })
  }
  if (subtitle?.trim()) {
    cursorY -= 2
    for (const line of wrapParagraph(sanitizeForFont(subtitle.trim(), supported), font, SUBTITLE_SIZE, CONTENT_WIDTH)) {
      drawLine(line, { font, size: SUBTITLE_SIZE, leading: SUBTITLE_LEADING, color: MUTED, supported })
    }
  }
  cursorY -= 14

  const perPageText = pageHtml.map(htmlToPlainText)
  const hasAnyText = perPageText.some((t) => t.trim() !== '')

  if (!hasAnyText) {
    drawLine('No extracted text was available for this source.', { font, size: BODY_SIZE, leading: BODY_LEADING, color: MUTED, supported })
  } else {
    perPageText.forEach((text, idx) => {
      if (pageHtml.length > 1) {
        drawLine(`— page ${idx + 1} —`, { font, size: MARKER_SIZE, leading: MARKER_SIZE + 10, color: MUTED, supported, center: true })
      }
      const paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
      if (paragraphs.length === 0) {
        drawLine('(no extracted text on this page)', { font, size: BODY_SIZE, leading: BODY_LEADING, color: MUTED, supported })
        return
      }
      for (const para of paragraphs) {
        const flattened = sanitizeForFont(para.replace(/\s*\n\s*/g, ' '), supported)
        for (const line of wrapParagraph(flattened, font, BODY_SIZE, CONTENT_WIDTH)) {
          drawLine(line, { font, size: BODY_SIZE, leading: BODY_LEADING, color: INK, supported })
        }
        cursorY -= PARAGRAPH_GAP
      }
    })
  }

  return doc.save()
}

/** One Standard-14 font family's four weight/style variants, plus each one's own supported character set (`sanitizeForFont` needs the set that actually matches whichever variant a given run ends up drawn with). */
interface FontVariants {
  regular: PDFFont
  bold: PDFFont
  italic: PDFFont
  boldItalic: PDFFont
  supported: { regular: Set<number>; bold: Set<number>; italic: Set<number>; boldItalic: Set<number> }
}

interface FontSet {
  helvetica: FontVariants
  times: FontVariants
  courier: FontVariants
}

async function embedFontVariants(doc: PDFDocument, names: [StandardFonts, StandardFonts, StandardFonts, StandardFonts]): Promise<FontVariants> {
  const [regular, bold, italic, boldItalic] = await Promise.all(names.map((n) => doc.embedFont(n)))
  return {
    regular,
    bold,
    italic,
    boldItalic,
    supported: {
      regular: new Set(regular.getCharacterSet()),
      bold: new Set(bold.getCharacterSet()),
      italic: new Set(italic.getCharacterSet()),
      boldItalic: new Set(boldItalic.getCharacterSet()),
    },
  }
}

async function embedFontSet(doc: PDFDocument): Promise<FontSet> {
  const [helvetica, times, courier] = await Promise.all([
    embedFontVariants(doc, [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique]),
    embedFontVariants(doc, [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic]),
    embedFontVariants(doc, [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]),
  ])
  return { helvetica, times, courier }
}

/**
 * Maps a run's own recorded `font-family` (`styles[item.fontName]?.fontFamily`
 * in `extractLayoutPageHtml` — pdf.js's own CSS-ready family string for
 * that font, a generic `sans-serif`/`serif`/`monospace` fallback when it
 * has nothing better) onto one of pdf-lib's Standard 14 fonts — the
 * closest this can get without `fontkit` to embed the PDF's own actual
 * fonts. `bold`/`italic`/`oblique` substrings (case-insensitive) inside
 * that same family string pick the matching weight/style variant, same
 * idea `cite`-style inference elsewhere in this codebase uses for "guess
 * from the available text rather than a dedicated field," since
 * `extractLayoutPageHtml` never records weight/style as their own
 * attributes.
 */
function pickFont(fontFamily: string, fonts: FontSet): { font: PDFFont; supported: Set<number> } {
  const f = fontFamily.toLowerCase()
  const bold = /\bbold\b/.test(f)
  const italic = /italic|oblique/.test(f)
  const variants = /mono|courier|consolas/.test(f) ? fonts.courier : /serif/.test(f) && !/sans-serif/.test(f) ? fonts.times : fonts.helvetica
  if (bold && italic) return { font: variants.boldItalic, supported: variants.supported.boldItalic }
  if (bold) return { font: variants.bold, supported: variants.supported.bold }
  if (italic) return { font: variants.italic, supported: variants.supported.italic }
  return { font: variants.regular, supported: variants.supported.regular }
}

/** Parses the two color forms `sampleTextColor` (`lib/textExtraction.ts`) ever actually produces — `'#000'` (3-digit hex) or `'rgb(r, g, b)'` — into a pdf-lib `Color`. Falls back to plain black for anything else (shouldn't happen against real extracted HTML, but a CSS color string this doesn't recognize is a far better place to degrade than a thrown exception). */
function parseColor(css: string): Color {
  const rgbMatch = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(css.trim())
  if (rgbMatch) return rgb(Number(rgbMatch[1]) / 255, Number(rgbMatch[2]) / 255, Number(rgbMatch[3]) / 255)
  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim())
  if (hexMatch) {
    const hex = hexMatch[1]
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex
    const n = parseInt(full, 16)
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
  }
  return INK
}

/** A CSS length like `"123.4px"` (every `left`/`top`/`font-size`/`width`/`height` `extractLayoutPageHtml` ever writes) parsed down to its plain number — `0` for anything unset/unparseable, same as reading an absent CSS property would behave visually (nothing drawn there is better than `NaN` propagating into every position downstream of it). */
function px(value: string): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

/** Draws one layout-mode page's worth of already-positioned runs/images onto a brand-new PDF page sized to match the original exactly (`extractLayoutPageHtml`'s own wrapper `<div>` records the real page dimensions it extracted at) — the core of what makes this renderer actually respect the layout `pageHtml` carries, instead of flattening it into a reflowed stream of text the way `buildFlowingPdf` has to for genuinely position-less HTML. */
async function drawLayoutPage(doc: PDFDocument, html: string, fonts: FontSet): Promise<void> {
  const dom = new DOMParser().parseFromString(html, 'text/html')
  const root = dom.body.firstElementChild as HTMLElement
  const pageWidth = px(root.style.width) || PAGE_WIDTH
  const pageHeight = px(root.style.height) || PAGE_HEIGHT
  const page = doc.addPage([pageWidth, pageHeight])

  for (const el of Array.from(root.children)) {
    if (el.tagName === 'IMG') {
      await drawLayoutImage(doc, page, el as HTMLElement, pageHeight)
    } else if (el.tagName === 'SPAN') {
      drawLayoutSpan(page, el as HTMLElement, pageHeight, fonts)
    }
    // `<br>`/a bare `&nbsp;` text node between two runs (the gap-carrying
    // separators `extractLayoutPageHtml` inserts purely for native
    // text-selection to pick up real whitespace — see its own doc
    // comment) have no position and nothing to draw; every real run
    // already carries its own absolute coordinates, so skipping anything
    // that isn't a `<span>`/`<img>` loses nothing visual.
  }
}

/** One text run — `extractLayoutPageHtml`'s own `<span style="position:absolute;left:…;top:…;font-size:…;font-family:…;color:…;...">`. `top` is the CSS/top-down position of the run's own *box top*, not its baseline (`tx[5] - height`, in that extractor); pdf-lib's `drawText` positions by baseline in a bottom-up coordinate system, so the box-top has to be converted both ways: `top + fontSize` recovers the baseline's own top-down position (mirroring how the extractor derived `top` from the baseline in the first place), and `pageHeight - that` flips it into pdf-lib's own bottom-up `y`. A `rotate(…rad)` transform (rare — only ever set for genuinely rotated text, `extractLayoutPageHtml`'s own `angle`) is negated before converting to degrees: that angle was read off `viewport.transform`, which mirrors the vertical axis converting PDF space to top-down CSS space, flipping the rotation's own handedness along with it — negating it here undoes exactly that mirroring, landing back in the same (mathematical, counter-clockwise-positive) sense pdf-lib's own `rotate` expects. A `scaleX(…)` on the same transform (the OCR-width correction `extractLayoutPageHtml` sometimes adds) has no pdf-lib equivalent and is left unapplied — see this file's own doc comment. */
function drawLayoutSpan(page: PDFPage, el: HTMLElement, pageHeight: number, fonts: FontSet): void {
  const text = el.textContent ?? ''
  if (!text) return
  const left = px(el.style.left)
  const top = px(el.style.top)
  const fontSize = px(el.style.fontSize) || BODY_SIZE
  const { font, supported } = pickFont(el.style.fontFamily || '', fonts)
  const color = parseColor(el.style.color || '#000')
  const rotateMatch = /rotate\(\s*([-\d.eE]+)rad\s*\)/.exec(el.style.transform || '')
  const rotateDegrees = rotateMatch ? -(parseFloat(rotateMatch[1]) * 180) / Math.PI : 0

  const baselineTopDown = top + fontSize
  const x = left
  const y = pageHeight - baselineTopDown

  page.drawText(sanitizeForFont(text, supported), {
    x,
    y,
    size: fontSize,
    font,
    color,
    ...(rotateDegrees ? { rotate: degrees(rotateDegrees) } : {}),
  })
}

/** One recovered image — `extractLayoutPageHtml`'s own `<img src="data:image/png;base64,…" style="position:absolute;left:…;top:…;width:…;height:…;">` (always a PNG — `cropImageRegion`, `lib/textExtraction.ts`, only ever produces one via `canvas.toDataURL('image/png')`). Same top-down-box-to-bottom-up-origin conversion `drawLayoutSpan` needs, just simpler: an image's own `top` is already its box's own top edge (no baseline involved), so the drawn origin is `pageHeight - top - height` — the box's *bottom* edge in pdf-lib's bottom-up space, matching `drawImage`'s own `y` convention (origin at the image's bottom-left corner). */
async function drawLayoutImage(doc: PDFDocument, page: PDFPage, el: HTMLElement, pageHeight: number): Promise<void> {
  const src = el.getAttribute('src') || ''
  if (!src.startsWith('data:image/png')) return // the only kind extractLayoutPageHtml ever produces; defensive against anything else slipping through
  let embedded
  try {
    embedded = await doc.embedPng(src)
  } catch {
    return // a corrupt/truncated data URL shouldn't take the whole export down with it
  }
  const left = px(el.style.left)
  const top = px(el.style.top)
  const width = px(el.style.width) || embedded.width
  const height = px(el.style.height) || embedded.height
  page.drawImage(embedded, { x: left, y: pageHeight - top - height, width, height })
}

/** The layout-aware renderer — used whenever at least one of `pageHtml` is layout-mode (`isLayoutPageHtml`). Title/subtitle get their own dedicated cover page rather than sharing space with the first real page's own positioned content (a layout-mode page is a full replica of the original, with nowhere safe to also fit a header without risking an overlap) — then every source page becomes its own PDF page: a real, position-respecting one (`drawLayoutPage`) for layout-mode HTML, or the same plain flowing-paragraph rendering `buildFlowingPdf` uses, started fresh, for a legacy/plain page mixed in among layout-mode ones (an unusual case in practice — a whole source is extracted once, by one method — but not one this needs to handle badly just because it's rare). */
async function buildLayoutAwarePdf({ title, subtitle, pageHtml }: SimplePdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const fonts = await embedFontSet(doc)
  const helv = fonts.helvetica

  const cover = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let cursorY = PAGE_HEIGHT - MARGIN

  function drawCoverLine(line: string, opts: { font: PDFFont; size: number; leading: number; color: Color; supported: Set<number> }) {
    const text = sanitizeForFont(line, opts.supported)
    cover.drawText(text, { x: MARGIN, y: cursorY - opts.size, size: opts.size, font: opts.font, color: opts.color })
    cursorY -= opts.leading
  }

  for (const line of wrapParagraph(sanitizeForFont(title || 'Untitled source', helv.supported.bold), helv.bold, TITLE_SIZE, CONTENT_WIDTH)) {
    drawCoverLine(line, { font: helv.bold, size: TITLE_SIZE, leading: TITLE_LEADING, color: INK, supported: helv.supported.bold })
  }
  if (subtitle?.trim()) {
    cursorY -= 2
    for (const line of wrapParagraph(sanitizeForFont(subtitle.trim(), helv.supported.regular), helv.regular, SUBTITLE_SIZE, CONTENT_WIDTH)) {
      drawCoverLine(line, { font: helv.regular, size: SUBTITLE_SIZE, leading: SUBTITLE_LEADING, color: MUTED, supported: helv.supported.regular })
    }
  }

  const hasAnyText = pageHtml.some((html) => htmlToPlainText(html).trim() !== '')
  if (!hasAnyText) {
    cursorY -= 14
    drawCoverLine('No extracted text was available for this source.', { font: helv.regular, size: BODY_SIZE, leading: BODY_LEADING, color: MUTED, supported: helv.supported.regular })
  }

  for (const html of pageHtml) {
    if (!html) continue
    if (isLayoutPageHtml(html)) {
      await drawLayoutPage(doc, html, fonts)
    } else {
      drawPlainPage(doc, html, helv)
    }
  }

  return doc.save()
}

/** A legacy/plain-mode source page mixed in among layout-mode ones (see `buildLayoutAwarePdf`'s own doc comment) — its own fresh PDF page(s), flowing text top-down exactly the way `buildFlowingPdf` does, just scoped to one page's worth of text rather than the whole source. */
function drawPlainPage(doc: PDFDocument, html: string, helv: FontVariants): void {
  const text = htmlToPlainText(html).trim()
  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let cursorY = PAGE_HEIGHT - MARGIN

  function drawLine(line: string) {
    if (cursorY - BODY_LEADING < MARGIN) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
      cursorY = PAGE_HEIGHT - MARGIN
    }
    page.drawText(sanitizeForFont(line, helv.supported.regular), { x: MARGIN, y: cursorY - BODY_SIZE, size: BODY_SIZE, font: helv.regular, color: INK })
    cursorY -= BODY_LEADING
  }

  if (!text) {
    drawLine('(no extracted text on this page)')
    return
  }
  for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    const flattened = para.replace(/\s*\n\s*/g, ' ')
    for (const line of wrapParagraph(flattened, helv.regular, BODY_SIZE, CONTENT_WIDTH)) drawLine(line)
    cursorY -= PARAGRAPH_GAP
  }
}
