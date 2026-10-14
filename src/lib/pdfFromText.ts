/**
 * Renders a text-only source's extracted `pageHtml` into a brand new,
 * minimal PDF — plain running text, no attempt at reproducing the
 * original's layout (images, columns, fonts), just enough for a usable
 * downloadable file when there's no original PDF left to hand out
 * byte-for-byte (see `handleDownloadPdf` in SourceWorkspace.tsx, used
 * whenever `source.pdfBlobId` is still around — this is the fallback for
 * everywhere that isn't true, including a source converted via "Discard
 * PDF, keep text only").
 *
 * Built with `pdf-lib` alone, already a dependency for the OCR text-layer
 * work in `lib/ocr.ts` — no extra font-embedding library (`fontkit`),
 * which isn't installed here, so this is limited to pdf-lib's built-in
 * Standard 14 fonts and their WinAnsiEncoding character set (ordinary
 * Latin-script text, accented Latin letters included, plus the common
 * "smart" typography substituted below). A character outside that —
 * most CJK/Cyrillic/Greek text, mathematical symbols — can't be drawn at
 * all and falls back to a literal `?`. Acceptable for a lightweight
 * fallback export of mostly-Latin-script academic text; not meant to
 * replace the original.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
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
  ' ': ' ',
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
  /** One entry per original source page, in order — real HTML (`Source.pageHtml`), reduced to plain text internally via `htmlToPlainText`. */
  pageHtml: string[]
}

export async function buildSimplePdfFromText({ title, subtitle, pageHtml }: SimplePdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold)
  const supported = new Set(font.getCharacterSet())
  const supportedBold = new Set(boldFont.getCharacterSet())

  let page: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  let cursorY = PAGE_HEIGHT - MARGIN

  function drawLine(line: string, opts: { font: PDFFont; size: number; leading: number; color: ReturnType<typeof rgb>; supported: Set<number>; center?: boolean }) {
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
