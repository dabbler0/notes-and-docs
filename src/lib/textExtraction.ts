/**
 * Turns a PDF into `Source.pageHtml` — one HTML string per page, the thing
 * `TextViewer` actually renders and `htmlToPlainText` (below) reduces back
 * down to plain text for search/snippets/scanned-detection. Two extractors:
 *
 * - `'plain'` (the default, and the only one that existed before this file
 *   did): reuses `reflowTextItems`'s existing line/paragraph-break
 *   heuristic, then bakes the result into plain, unstyled HTML
 *   (`plainTextToHtml`) — a `<p>` per paragraph, a `<br>` per line break
 *   inside one. This is also exactly what migrates an old source's
 *   already-extracted plain text (from before `pageHtml` existed) into the
 *   new shape — see `plainTextToHtml`'s own doc comment.
 * - `'layout'` (experimental — see `extractLayoutPageHtml`'s own doc
 *   comment): attempts to reproduce the PDF page's actual visual
 *   appearance — each text run's own position, size, and color, plus
 *   images pulled out of the page and reinserted where they were — instead
 *   of collapsing everything down to plain reading-order prose.
 */
import * as pdfjsLib from 'pdfjs-dist'
import { escapeHtml, escapeAttr } from './html'
import { reflowTextItems, renderPageToCanvas, separatorForGap, textItemHeight, type PdfDoc } from './pdf'
import { sanitizePageHtml } from './sanitizeHtml'

export type ExtractionMode = 'plain' | 'layout'

/**
 * Turns plain text (paragraphs separated by a blank line, single line
 * breaks preserved within one) into the equivalent HTML — a `<p>` per
 * paragraph, a `<br>` per line break inside it — that renders identically
 * to how `TextViewer` used to render the plain text directly, but as
 * actual markup rather than leaning on the viewer's own CSS
 * (`white-space: pre`) to reproduce the line breaks. Two uses: the `'plain'`
 * extractor's own output, and migrating an old source's plain-text
 * `pageTexts` (from before `pageHtml` existed) into the new shape with
 * (by construction) an identical rendered appearance — see
 * `migratePlainTextSources` in `sourcesRepo.ts`.
 *
 * Every escaped character and fixed tag here already makes this output
 * safe by construction — no attributes, nothing derived from anything but
 * `escapeHtml` and a literal `<p>`/`<br>` — but it still goes through
 * `sanitizePageHtml` before returning, same as the layout extractor's own
 * output, so *every* path that produces `pageHtml` is sanitized at
 * extraction time without relying on each one to remember to call it
 * separately (see `sanitizePageHtml`'s own doc comment for the render-time
 * half of this).
 */
export function plainTextToHtml(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  return sanitizePageHtml(paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join(''))
}

/**
 * The inverse of `plainTextToHtml` (though not its exact left-inverse for
 * `'layout'`-mode HTML, which has no paragraphs at all — see below): reduces
 * a page's stored HTML back down to plain text, for everywhere pageHtml
 * needs to be searched, scanned for "does this look like a scanned PDF," or
 * turned into a short snippet rather than actually rendered. A `<br>` or a
 * `<p>`/`<div>` boundary becomes a line break (two, for the block case, to
 * keep reading as a paragraph break); an `<img>` contributes nothing (it
 * has no text); everything else's own text content is kept as-is. Good
 * enough for whitespace-tolerant search (`buildSearchRegex`) and for the
 * "mostly empty" check `looksLikeScannedPdf` runs, even though it doesn't
 * attempt to reconstruct layout-mode HTML's own reading order perfectly
 * (that HTML has no paragraph structure to begin with — every run is its
 * own absolutely-positioned element with no ancestor of its own to signal
 * a paragraph break, so this just falls through to concatenating them in
 * document order, separated by whatever the extractor left as an invisible
 * separator span between runs).
 */
export function htmlToPlainText(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node as Element
    if (el.tagName === 'BR') return '\n'
    if (el.tagName === 'IMG') return ''
    const inner = Array.from(el.childNodes).map(walk).join('')
    return el.tagName === 'P' || el.tagName === 'DIV' ? inner + '\n\n' : inner
  }
  return Array.from(doc.body.childNodes)
    .map(walk)
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Extracts `Source.pageHtml` for every page of `doc`, using whichever
 * extractor `mode` names. `onProgress` (1-based page number, total pages)
 * lets a caller show status for the slower `'layout'` mode, the same way
 * OCR already does. */
export async function extractPageHtml(doc: PdfDoc, mode: ExtractionMode = 'plain', onProgress?: (page: number, totalPages: number) => void): Promise<string[]> {
  const pages: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    onProgress?.(p, doc.numPages)
    pages.push(mode === 'layout' ? await extractLayoutPageHtml(doc, p) : await extractPlainPageHtml(doc, p))
  }
  return pages
}

async function extractPlainPageHtml(doc: PdfDoc, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber)
  const content = await page.getTextContent()
  return plainTextToHtml(reflowTextItems(content.items as any[]))
}

// Rendered at a higher resolution than viewing scale for the same reason
// OCR renders at OCR_SCALE — color sampling and image cropping both read
// pixels back off this canvas, and a low-resolution render would sample
// blurry, anti-aliased edge pixels far more often than clean ink/background.
const LAYOUT_RENDER_SCALE = 2

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Experimental: attempts to reproduce a PDF page's actual visual appearance
 * instead of collapsing it to plain reading-order prose — each text run
 * positioned, sized, and colored the way it was in the original, with
 * images pulled out of the page and placed back where they were. Marked
 * experimental (see the UI's own "Re-extract (experimental layout)" and
 * "Use experimental layout-preserving extraction" labels) because none of
 * this is exact:
 *
 * - Position and size come straight from the same raw pdf.js text-item
 *   transforms `reflowTextItems` already uses — reliable, the one part of
 *   this that isn't a heuristic.
 * - Color has no equivalent in pdf.js's `getTextContent()` at all (it only
 *   reports position, size, and font, not fill color) — the actual PDF
 *   content stream would need interpreting to get that properly. Instead,
 *   `sampleTextColor` renders the page to a canvas and samples a handful of
 *   pixels near where each run's glyphs should be, picking whichever
 *   sampled pixel looks most like ink rather than background. Works well
 *   for the common case (dark text on a light page); can sample the wrong
 *   pixel entirely for light text on a dark background, a tightly rotated
 *   run, or text sitting on a busy image.
 * - Images aren't decoded from the PDF's own embedded XObject data at all
 *   (variable color spaces and filters make that its own project) —
 *   `computeImageRegions` instead walks the page's operator list purely to
 *   find *where* an image was painted (tracking the same save/restore/
 *   transform state a real PDF renderer would), then `cropImageRegion`
 *   crops that exact rectangle back out of the already-rendered canvas.
 *   Simple and always visually correct for what it does capture, but it
 *   only finds axis-aligned-enough regions and won't separate two images
 *   placed right next to each other with nothing in between.
 * - There's no paragraph structure at all — every run is its own
 *   absolutely-positioned element, with an `&nbsp;` or a `<br>` (the same
 *   gap heuristic `reflowTextItems` uses — see `separatorForGap`) sitting
 *   between two runs to carry the whitespace that belongs there. Not a
 *   plain space or `\n` character: a native selection dropped exactly that
 *   kind of plain, collapsible whitespace sitting between two
 *   independently-positioned elements when serialized — confirmed
 *   directly, the same whitespace bug `pdfSelection.ts` already had to
 *   work around for `PdfViewer`'s own synthetic text layer — while `&nbsp;`
 *   (which never collapses) and `<br>` (which a browser always serializes
 *   as a real line break) both survive it with no extra machinery needed.
 *   That's what lets a normal drag-selection across the page still pick up
 *   real spaces and line breaks the way it would from flowing text, even
 *   though every run is independently positioned with nothing visually
 *   between them.
 */
async function extractLayoutPageHtml(doc: PdfDoc, pageNumber: number): Promise<string> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const opList = await page.getOperatorList()

  const renderCanvas = document.createElement('canvas')
  await renderPageToCanvas(doc, pageNumber, renderCanvas, LAYOUT_RENDER_SCALE)
  const renderCtx = renderCanvas.getContext('2d')!
  const pixels = renderCtx.getImageData(0, 0, renderCanvas.width, renderCanvas.height)

  const parts: string[] = []

  for (const region of computeImageRegions(opList, viewport)) {
    const dataUrl = cropImageRegion(renderCanvas, region)
    if (dataUrl) {
      parts.push(`<img src="${escapeAttr(dataUrl)}" alt="" style="position:absolute;left:${region.x}px;top:${region.y}px;width:${region.width}px;height:${region.height}px;">`)
    }
  }

  const styles = (content.styles ?? {}) as Record<string, { fontFamily?: string }>
  let prevY: number | null = null
  let prevHeight = 10
  for (const item of content.items as any[]) {
    if (!('str' in item) || !item.str) continue
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
    const height = Math.hypot(tx[2], tx[3]) || prevHeight
    const angle = Math.atan2(tx[1], tx[0])
    const y = item.transform[5]

    if (prevY !== null) {
      // A native browser selection dropping a plain, collapsible ' ' or
      // '\n' character that sits between two independently-positioned
      // elements — exactly this situation — is the very whitespace bug
      // pdfSelection.ts already had to work around for PdfViewer's own
      // synthetic text layer. Sidestepping it here is simpler than
      // reconstructing a selection after the fact: `&nbsp;` never
      // collapses away (a plain space between two absolutely-positioned
      // siblings does), and a `<br>` always serializes as a real line
      // break — both survive `Selection.toString()` with no extra
      // machinery needed, unlike a zero-size span carrying a plain
      // whitespace character (which a real browser *does* collapse away
      // to nothing, verified directly before settling on this instead).
      const sep = separatorForGap(prevY - y, height)
      parts.push(sep === ' ' ? '&nbsp;' : sep === '\n' ? '<br>' : '<br><br>')
    }

    if (item.str.trim()) {
      const color = sampleTextColor(pixels, tx, height, item.str.length)
      const fontFamily = styles[item.fontName]?.fontFamily || 'sans-serif'
      const rotate = angle ? `transform:rotate(${angle}rad);transform-origin:0% 0%;` : ''
      parts.push(
        `<span style="position:absolute;left:${tx[4]}px;top:${tx[5] - height}px;font-size:${height}px;font-family:${escapeAttr(fontFamily)};color:${color};white-space:pre;${rotate}">${escapeHtml(item.str)}</span>`,
      )
    }

    prevY = y
    prevHeight = height
  }

  // Sanitized before returning (see sanitizePageHtml's own doc comment) —
  // this is the extractor with actual attributes and a data-URL image to
  // worry about, unlike the plain extractor's fixed tags with no
  // attributes at all, so this is the pass that actually does something:
  // stripping anything DOMPurify wouldn't recognize, and restricting the
  // image's own `src` to the `data:` URI it already is.
  return sanitizePageHtml(`<div style="position:relative;width:${viewport.width}px;height:${viewport.height}px;background:#fff;overflow:hidden;">${parts.join('')}</div>`)
}

/** Walks a page's operator list purely to find where an image was painted
 * — tracking `save`/`restore`/`transform` the way a real PDF renderer would
 * — mapping each hit's unit square through the accumulated transform (and
 * then through `viewport`) to a page-space rectangle. Never touches the
 * image's own encoded data at all; see `extractLayoutPageHtml`'s doc
 * comment for why (`cropImageRegion` gets the actual pixels some other
 * way). */
function computeImageRegions(opList: { fnArray: number[]; argsArray: unknown[] }, viewport: { transform: number[] }): Rect[] {
  const OPS = pdfjsLib.OPS
  const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat])
  const regions: Rect[] = []
  let ctm: number[] = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i]
    if (fn === OPS.save) {
      stack.push(ctm)
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm
    } else if (fn === OPS.transform) {
      const args = opList.argsArray[i] as number[]
      ctm = pdfjsLib.Util.transform(ctm, args)
    } else if (IMAGE_OPS.has(fn)) {
      const full = pdfjsLib.Util.transform(viewport.transform, ctm)
      const corners = [applyMatrix(full, 0, 0), applyMatrix(full, 1, 0), applyMatrix(full, 0, 1), applyMatrix(full, 1, 1)]
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const width = Math.max(...xs) - x
      const height = Math.max(...ys) - y
      if (width > 2 && height > 2) regions.push({ x, y, width, height })
    }
  }
  return regions
}

function applyMatrix(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/** Crops `region` (page-space, i.e. `viewport({scale: 1})` units) directly
 * out of the already-rendered `renderCanvas` (rendered at
 * `LAYOUT_RENDER_SCALE`) and returns it as a PNG data URL — see
 * `extractLayoutPageHtml`'s doc comment for why this reads the rendered
 * pixels rather than the image's own embedded data. */
function cropImageRegion(renderCanvas: HTMLCanvasElement, region: Rect): string | null {
  const sx = Math.max(0, Math.round(region.x * LAYOUT_RENDER_SCALE))
  const sy = Math.max(0, Math.round(region.y * LAYOUT_RENDER_SCALE))
  const sw = Math.min(renderCanvas.width - sx, Math.round(region.width * LAYOUT_RENDER_SCALE))
  const sh = Math.min(renderCanvas.height - sy, Math.round(region.height * LAYOUT_RENDER_SCALE))
  if (sw <= 0 || sh <= 0) return null
  const out = document.createElement('canvas')
  out.width = sw
  out.height = sh
  const ctx = out.getContext('2d')!
  ctx.drawImage(renderCanvas, sx, sy, sw, sh, 0, 0, sw, sh)
  return out.toDataURL('image/png')
}

/** Best-effort fill color for one text run: samples a handful of points
 * along its baseline (at `LAYOUT_RENDER_SCALE` resolution, matching
 * `pixels`) and picks whichever looks most like ink rather than background
 * — the darkest sample, on the (usually true) assumption that the page
 * itself is light. See `extractLayoutPageHtml`'s doc comment for when this
 * guesses wrong. */
function sampleTextColor(pixels: ImageData, tx: number[], height: number, strLength: number): string {
  const scale = LAYOUT_RENDER_SCALE
  const dirLen = Math.hypot(tx[0], tx[1]) || 1
  const ux = tx[0] / dirLen
  const uy = tx[1] / dirLen
  const estimatedWidth = height * strLength * 0.55
  const steps = Math.max(2, Math.min(6, strLength))
  let best: [number, number, number] | null = null
  let bestScore = -1
  for (let i = 0; i < steps; i++) {
    const t = (estimatedWidth * (i + 0.5)) / steps
    const px = Math.round((tx[4] + ux * t) * scale)
    const py = Math.round((tx[5] - height * 0.32) * scale)
    if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) continue
    const idx = (py * pixels.width + px) * 4
    const r = pixels.data[idx]
    const g = pixels.data[idx + 1]
    const b = pixels.data[idx + 2]
    const a = pixels.data[idx + 3]
    if (a === 0) continue
    const score = 255 * 3 - (r + g + b)
    if (score > bestScore) {
      bestScore = score
      best = [r, g, b]
    }
  }
  return best ? `rgb(${best[0]}, ${best[1]}, ${best[2]})` : '#000'
}
