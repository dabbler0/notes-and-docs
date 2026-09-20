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
 *   images (raster ones, and anything vector-drawn that isn't text either —
 *   see `detectVectorArtRegions`) pulled out of the page and reinserted
 *   where they were — instead of collapsing everything down to plain
 *   reading-order prose.
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

export interface Rect {
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
 * - Position comes straight from the same raw pdf.js text-item transforms
 *   `reflowTextItems` already uses — reliable, not a heuristic. Size (both
 *   the font-size used for a run's `<span>` and the box it has to fit in)
 *   prefers pdf.js's own `item.height`/`item.width` ("device space," i.e.
 *   already in the same units as the transform) over deriving them from the
 *   transform matrix directly, which turned out to disagree with pdf.js's
 *   own metrics for exactly the runs most likely to look wrong afterward —
 *   footnotes, and other text at a size that differs from the surrounding
 *   body text. Width is then actively enforced, not just recorded: a run's
 *   natural rendered width (measured with a scratch canvas, at the same
 *   font-size/family the `<span>` will actually use — see
 *   `measureHorizontalScale`) is compared against `item.width`, and a
 *   `transform: scaleX(...)` squeezes the run down to fit whenever the
 *   browser would otherwise render it wider than the PDF says it should be.
 *   This is the same technique pdf.js's own built-in text layer uses to
 *   keep its selectable text aligned with the canvas rendering underneath
 *   it, and matters most for exactly the case that used to look worst here:
 *   an OCR'd PDF's own text layer, where a word's box width comes from
 *   Tesseract's guess rather than real font metrics, so without this a
 *   run's rendered text routinely overflowed into its neighbor's box and
 *   the two visually ran together in the same row.
 * - Images come from two different sources, merged into one list before
 *   `cropImageRegion` crops any of them out of the already-rendered canvas
 *   (never the PDF's own embedded image data — see that function's own doc
 *   comment):
 *   - Raster images aren't decoded from the PDF's own embedded XObject data
 *     at all (variable color spaces and filters make that its own project)
 *     — `computeImageRegions` instead walks the page's operator list purely
 *     to find *where* an image was painted (tracking the same
 *     save/restore/transform state a real PDF renderer would). Simple and
 *     always visually correct for what it does capture, but it only finds
 *     axis-aligned-enough regions and won't separate two images placed
 *     right next to each other with nothing in between. A region that
 *     `regionIsMostlyText` judges to already be mostly covered by text runs
 *     that are about to be rendered as their own `<span>`s anyway — the
 *     telltale shape of an OCR'd scan, where the "image" is a raster of the
 *     very words an invisible text layer already reproduces — is dropped
 *     rather than embedded, since keeping it would just double the page's
 *     size for a picture of text sitting right underneath that same text.
 *   - Not everything that looks like a picture on the page was painted with
 *     an image operator, though — a chart or diagram is very often drawn
 *     with the PDF's own vector path-fill/stroke operators instead, which
 *     `computeImageRegions` never looks at (walking every fill/stroke/clip
 *     operator, and figuring out which ones belong to the same picture, is
 *     a much bigger job than the handful of image-paint ops it already
 *     handles). `detectVectorArtRegions` finds these anyway, by working
 *     backwards from the rendered pixels: connected clusters of non-
 *     background ink that fall outside every already-known text or raster-
 *     image region are, by elimination, vector-drawn content, and get
 *     cropped out and re-inserted as their own `<img>` the same way a real
 *     raster image would be.
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
  const textBoxes = computeTextBoxes(content.items as any[], viewport)
  const rasterRegions = computeImageRegions(opList, viewport)
  const keptRasterRegions = rasterRegions.filter((region) => !regionIsMostlyText(region, textBoxes))
  // Every raster region counts as "covered" here even when it was just
  // dropped above for being mostly text — an OCR'd scan's own faint
  // background texture or a stray artifact inside it shouldn't get
  // rediscovered as "leftover vector art" and re-embedded right back after
  // being deliberately dropped a moment ago.
  const coverage = [...rasterRegions, ...textBoxes.map(padTextBoxForCoverage)]
  const vectorRegions = detectVectorArtRegions(pixels, coverage, LAYOUT_RENDER_SCALE)

  const embeddedRegions = [...keptRasterRegions, ...vectorRegions]
  for (const region of embeddedRegions) {
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
    const height = typeof item.height === 'number' && item.height > 0.5 ? item.height : Math.hypot(tx[2], tx[3]) || prevHeight
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

    if (item.str.trim() && !isMostlyInsideAnyRegion({ x: tx[4], y: tx[5] - height, width: item.width > 0 ? item.width : height * item.str.length * 0.55, height }, embeddedRegions)) {
      const declaredWidth = typeof item.width === 'number' && item.width > 0 ? item.width : height * item.str.length * 0.55
      const color = sampleTextColor(pixels, tx, height, declaredWidth)
      const fontFamily = styles[item.fontName]?.fontFamily || 'sans-serif'
      const scaleX = measureHorizontalScale(renderCtx, item.str, height, fontFamily, declaredWidth)
      const transforms: string[] = []
      if (scaleX < 0.999) transforms.push(`scaleX(${scaleX.toFixed(3)})`)
      if (angle) transforms.push(`rotate(${angle}rad)`)
      const transformStyle = transforms.length ? `transform:${transforms.join(' ')};transform-origin:0% 0%;` : ''
      parts.push(
        `<span style="position:absolute;left:${tx[4]}px;top:${tx[5] - height}px;font-size:${height}px;font-family:${escapeAttr(fontFamily)};color:${color};white-space:pre;${transformStyle}">${escapeHtml(item.str)}</span>`,
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

export interface TextBox {
  x: number
  y: number
  width: number
  height: number
  chars: number
}

/** A rough page-space bounding box (plus character count) for every
 * non-blank text item, in the same units `computeImageRegions` reports its
 * regions in — used purely to measure how much of an image region is
 * already covered by text that's about to be rendered as its own `<span>`s
 * (see `regionIsMostlyText`). Width is the same `height * length * 0.55`
 * estimate the main rendering loop below effectively uses for its own
 * separator-gap heuristic; exact glyph metrics aren't needed for a coverage
 * *estimate*. */
export function computeTextBoxes(items: any[], viewport: { transform: number[] }): TextBox[] {
  const boxes: TextBox[] = []
  for (const item of items) {
    if (!('str' in item) || !item.str || !item.str.trim()) continue
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
    const height = Math.hypot(tx[2], tx[3]) || 10
    const width = height * item.str.length * 0.55
    boxes.push({ x: tx[4], y: tx[5] - height, width, height, chars: item.str.trim().length })
  }
  return boxes
}

/** True when `region` is already mostly covered by text runs that will be
 * rendered as their own `<span>`s anyway — the shape of a page that's been
 * run through OCR, where the "image" is a raster of the very words an
 * invisible (or, after re-extraction, visible) text layer already
 * reproduces on top of it. Keeping that image would double the page's
 * size for a picture of text sitting directly underneath the same text,
 * defeating the point of extracting text in the first place.
 *
 * A real chart or figure's own title/axis labels/legend can add up to a
 * meaningful *area* fraction of the region without the region actually
 * being a text scan — a chart title alone can span most of its width — so
 * area coverage alone is only trusted at a high bar (`AREA_RATIO_THRESHOLD`,
 * along with a minimum absolute amount of text) as a fast path for the
 * unambiguous full-page-scan case. Short of that, the actual shape of OCR'd
 * paragraph text — several lines stacked one after another that *each*
 * individually stretch across most of the region's width — is what a
 * chart's comparatively sparse, scattered labels don't have: an axis's tick
 * labels or a legend entry sit in their own small cluster, and even a wide
 * chart usually has at most one or two rows (a long title, a row of x-axis
 * ticks) that span most of its width, never several in a row the way
 * justified or near-full paragraph lines do. Clustering the region's
 * overlapping text into rows by vertical position and summing how much of
 * each row's own width is actually covered by text (not the distance
 * between its leftmost and rightmost box — two small, widely-separated
 * labels sharing a row, like a y-axis tick and a legend entry, would
 * otherwise fake a "wide" row despite barely any of it being ink) catches
 * the genuine OCR-scan case — several such densely-covered rows in a row —
 * without the area check's false positives on a heavily-labeled chart. */
export function regionIsMostlyText(region: Rect, textBoxes: TextBox[]): boolean {
  const regionArea = region.width * region.height
  if (regionArea <= 0) return false

  const overlapping: { x0: number; x1: number; y0: number; y1: number }[] = []
  let coveredArea = 0
  let totalChars = 0
  for (const box of textBoxes) {
    const x0 = Math.max(region.x, box.x)
    const y0 = Math.max(region.y, box.y)
    const x1 = Math.min(region.x + region.width, box.x + box.width)
    const y1 = Math.min(region.y + region.height, box.y + box.height)
    if (x1 <= x0 || y1 <= y0) continue
    coveredArea += (x1 - x0) * (y1 - y0)
    totalChars += box.chars
    overlapping.push({ x0, y0, x1, y1 })
  }
  if (totalChars < 40) return false

  const AREA_RATIO_THRESHOLD = 0.35
  if (coveredArea / regionArea >= AREA_RATIO_THRESHOLD) return true

  overlapping.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1))
  const LINE_COVERAGE_RATIO_THRESHOLD = 0.5
  const MIN_DENSE_LINES = 3
  let denseLines = 0
  let i = 0
  while (i < overlapping.length) {
    let lineCoveredWidth = overlapping[i].x1 - overlapping[i].x0
    let lineMaxY1 = overlapping[i].y1
    const lineHeight = overlapping[i].y1 - overlapping[i].y0
    let j = i + 1
    while (j < overlapping.length && overlapping[j].y0 < lineMaxY1 - lineHeight * 0.4) {
      lineCoveredWidth += overlapping[j].x1 - overlapping[j].x0
      lineMaxY1 = Math.max(lineMaxY1, overlapping[j].y1)
      j++
    }
    if (lineCoveredWidth / region.width >= LINE_COVERAGE_RATIO_THRESHOLD) denseLines++
    i = j
  }
  return denseLines >= MIN_DENSE_LINES
}

/** True when `box` sits almost entirely inside at least one of `regions` —
 * used to skip rendering a text run's own `<span>` when it's already
 * pictured inside an embedded image (a chart's axis labels baked into its
 * own cropped screenshot, most commonly): drawing it a second time as a
 * separately-positioned `<span>` right on top only doubles the ink,
 * visibly bolding or blurring exactly the text that's already there. A
 * high containment threshold (rather than requiring 100%) tolerates the
 * crude length-based width estimate `computeTextBoxes`/this box may be
 * using slightly overshooting a region's true edge. */
function isMostlyInsideAnyRegion(box: Rect, regions: Rect[]): boolean {
  const boxArea = box.width * box.height
  if (boxArea <= 0) return false
  for (const region of regions) {
    const x0 = Math.max(region.x, box.x)
    const y0 = Math.max(region.y, box.y)
    const x1 = Math.min(region.x + region.width, box.x + box.width)
    const y1 = Math.min(region.y + region.height, box.y + box.height)
    if (x1 <= x0 || y1 <= y0) continue
    if (((x1 - x0) * (y1 - y0)) / boxArea >= 0.8) return true
  }
  return false
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

/** Best-effort fill color for one text run: samples a grid of points across
 * where its glyphs should sit (at `LAYOUT_RENDER_SCALE` resolution,
 * matching `pixels`) — several positions along the baseline direction
 * *and* several heights above it, rather than a single fixed height — and
 * picks whichever looks most like ink rather than background: the darkest
 * sample, on the (usually true) assumption that the page itself is light.
 * A single sampling height (this function's original approach) turned out
 * to miss real ink far more often than expected: a fixed fraction of a
 * run's height above the baseline lands inside the x-height band for some
 * glyphs but in the gap above or below the ink for others (an "n" and a
 * "p" don't have their strokes at the same height), so a short run
 * sampled at just one or two points along one height would frequently
 * catch nothing but anti-aliased edge or bare background — which is
 * exactly what a "much brighter shade of gray, or almost white" instead of
 * black looks like when it happens to ordinary black text. Sampling
 * several heights per position fixes the common case directly; the
 * grayscale check below is the backstop for whatever it still misses
 * (a page's actual body text is overwhelmingly black or a very dark near-
 * black, so a sample that comes back both colorless *and* clearly lighter
 * than that is far more likely a missed sample than a real light-gray
 * ink — snapping it to black is right far more often than not). Genuinely
 * colorful text (a blue link, a red heading) is untouched, since it isn't
 * grayscale at all. See `extractLayoutPageHtml`'s doc comment for the
 * cases (light text on dark, tightly rotated runs, text over a busy image)
 * this still can't fully solve. `width` is the run's actual declared width
 * (pdf.js's own `item.width` when available — see `extractLayoutPageHtml`
 * — falling back to the same crude length-based estimate `computeTextBoxes`
 * uses otherwise), not a character count: sampling positions spread across
 * the real width the run occupies, rather than guessing one from its
 * string length here too, catches short-but-wide and long-but-narrow runs
 * (a single wide character, dense CJK text) that a length-only estimate
 * would space samples badly for. */
export function sampleTextColor(pixels: ImageData, tx: number[], height: number, width: number): string {
  const scale = LAYOUT_RENDER_SCALE
  const dirLen = Math.hypot(tx[0], tx[1]) || 1
  const ux = tx[0] / dirLen
  const uy = tx[1] / dirLen
  const estimatedWidth = width || height
  const xSteps = Math.max(3, Math.min(10, Math.round(estimatedWidth / (height * 0.4))))
  const yFractions = [0.12, 0.3, 0.48, 0.66, 0.82]
  let best: [number, number, number] | null = null
  let bestScore = -1
  for (let i = 0; i < xSteps; i++) {
    const t = (estimatedWidth * (i + 0.5)) / xSteps
    for (const yFraction of yFractions) {
      const px = Math.round((tx[4] + ux * t) * scale)
      const py = Math.round((tx[5] - height * yFraction) * scale)
      if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) continue
      const idx = (py * pixels.width + px) * 4
      const a = pixels.data[idx + 3]
      if (a === 0) continue
      const r = pixels.data[idx]
      const g = pixels.data[idx + 1]
      const b = pixels.data[idx + 2]
      const score = 255 * 3 - (r + g + b)
      if (score > bestScore) {
        bestScore = score
        best = [r, g, b]
      }
    }
  }
  if (!best) return '#000'
  const [r, g, b] = best
  if (Math.max(r, g, b) - Math.min(r, g, b) < 18) return '#000'
  return `rgb(${r}, ${g}, ${b})`
}

/** The subset of `CanvasRenderingContext2D` `measureHorizontalScale` needs
 * — narrowed to a plain interface so a test can pass a fake measurer
 * without a real canvas (jsdom has none), and so the real caller can pass
 * `null` (in the unlikely event `renderCanvas.getContext('2d')` itself
 * failed) without a special case at the call site. */
export interface TextMeasurer {
  font: string
  measureText(text: string): { width: number }
}

/** How much to horizontally squeeze a text run's `<span>` (as a CSS
 * `scaleX(...)`) so it renders no wider than `declaredWidth` — pdf.js's own
 * `item.width` for this run, i.e. what the PDF itself says this text
 * should occupy. Left alone, the browser lays a run out at whatever width
 * its own font-matching and metrics produce for `height`/`fontFamily`,
 * which routinely disagrees with the PDF's own advance width: everyday
 * font-substitution differences for ordinary text, and often far worse for
 * an OCR'd PDF's own text layer, where a word's box comes from Tesseract's
 * guess rather than real font metrics at all. Without correcting for it, a
 * run that renders wider than its box spills into whatever's positioned
 * next to it — exactly the "text runs into each other" symptom this
 * exists to fix, worst for Tesseract output because its many independently
 * placed word/line boxes give it the most neighbors to run into.
 *
 * `measurer` renders the same string at the same `font-size`/`font-family`
 * the `<span>` will actually use (matching pdf.js's own text-layer
 * technique for the identical problem) purely to ask "how wide would the
 * browser actually render this," without needing to know which real font
 * ends up resolving — whatever it is, `measurer` and the `<span>` agree on
 * it, so the ratio between the two widths is meaningful regardless. Only
 * ever shrinks (never stretches: a run rendering *narrower* than its box is
 * not the problem being solved here, and stretching it to fill the box on
 * a possibly-imprecise `declaredWidth` risks distorting it for no reason),
 * and is floored well short of 0 so a wildly-off measurement doesn't
 * squash a run down to an unreadable sliver. */
export function measureHorizontalScale(measurer: TextMeasurer | null, text: string, height: number, fontFamily: string, declaredWidth: number): number {
  if (!measurer || !(declaredWidth > 0) || !(height > 0)) return 1
  measurer.font = `${height}px ${fontFamily}`
  const naturalWidth = measurer.measureText(text).width
  if (!(naturalWidth > 0)) return 1
  return Math.min(1, Math.max(0.35, declaredWidth / naturalWidth))
}

/** Widens a text box before it's used as "covered" ground for
 * `detectVectorArtRegions` (never for `regionIsMostlyText`'s own coverage
 * math, which wants the precise box) — `computeTextBoxes`' width is a
 * crude length-based estimate, and a glyph's own anti-aliased edges extend
 * a little past even an exact box, so without this margin a text run's own
 * ink could peek out as a spurious "leftover ink" cluster right next to
 * itself. */
function padTextBoxForCoverage(box: TextBox): Rect {
  const padX = box.height * 0.5
  const padY = box.height * 0.35
  return { x: box.x - padX, y: box.y - padY, width: box.width + padX * 2, height: box.height + padY * 2 }
}

// Grid cell size (in `LAYOUT_RENDER_SCALE`-scaled pixels) for
// `detectVectorArtRegions`'s connected-component search — coarse enough to
// keep a full-page scan cheap, fine enough not to merge genuinely separate
// pictures that sit reasonably close together.
const VECTOR_ART_CELL = 8
const VECTOR_ART_MIN_CELLS = 12
const VECTOR_ART_MIN_SPAN_CELLS = 4

/** Finds regions of visual content that are neither a detected raster
 * image nor (padded) text — see `extractLayoutPageHtml`'s doc comment for
 * why this is how a vector-drawn chart or diagram gets found at all, since
 * nothing else here ever looks at the PDF's own path-fill/stroke
 * operators. Works backwards from the fully-rendered page's own pixels
 * instead: `coveredPageRects` (page-space, i.e. the same units `Rect`
 * always uses here) marks off everywhere already accounted for — every
 * raster image region (kept or not; see the caller) and every padded text
 * box — and whatever non-background ink is left outside all of that is,
 * by elimination, vector-drawn content. Grouping is done on a coarse grid
 * (`VECTOR_ART_CELL`-pixel cells) rather than per-pixel purely for speed;
 * a page-sized image at `LAYOUT_RENDER_SCALE` has a few million pixels but
 * only a few thousand grid cells, and a chart's bars/lines/axes are large
 * enough that a grid this coarse doesn't lose them. Cells are merged into
 * clusters by 8-directional flood fill (diagonal adjacency, so a dashed
 * line or a scatter of data points still merges into one region rather
 * than fragmenting), and a cluster is discarded unless it clears both a
 * minimum cell count and a minimum span in each direction — small enough
 * thresholds to keep a real chart, large enough to throw out the odd
 * stray anti-aliasing artifact that padding didn't quite catch. */
export function detectVectorArtRegions(pixels: ImageData, coveredPageRects: Rect[], scale: number): Rect[] {
  const cell = VECTOR_ART_CELL
  const cols = Math.max(1, Math.ceil(pixels.width / cell))
  const rows = Math.max(1, Math.ceil(pixels.height / cell))
  const blocked = new Uint8Array(cols * rows)
  for (const r of coveredPageRects) {
    const x0 = Math.max(0, Math.floor((r.x * scale) / cell))
    const y0 = Math.max(0, Math.floor((r.y * scale) / cell))
    const x1 = Math.min(cols - 1, Math.ceil(((r.x + r.width) * scale) / cell))
    const y1 = Math.min(rows - 1, Math.ceil(((r.y + r.height) * scale) / cell))
    for (let cy = y0; cy <= y1; cy++) {
      const base = cy * cols
      for (let cx = x0; cx <= x1; cx++) blocked[base + cx] = 1
    }
  }

  const BACKGROUND_THRESHOLD = 245
  const ink = new Uint8Array(cols * rows)
  const data = pixels.data
  for (let y = 0; y < pixels.height; y++) {
    const cy = (y / cell) | 0
    const rowBase = cy * cols
    for (let x = 0; x < pixels.width; x++) {
      const idx = (y * pixels.width + x) * 4
      if (data[idx + 3] === 0) continue
      if (data[idx] < BACKGROUND_THRESHOLD || data[idx + 1] < BACKGROUND_THRESHOLD || data[idx + 2] < BACKGROUND_THRESHOLD) {
        ink[rowBase + ((x / cell) | 0)] = 1
      }
    }
  }

  const candidate = new Uint8Array(cols * rows)
  for (let i = 0; i < candidate.length; i++) candidate[i] = ink[i] && !blocked[i] ? 1 : 0

  const visited = new Uint8Array(cols * rows)
  const regions: Rect[] = []
  const stack: number[] = []
  for (let start = 0; start < candidate.length; start++) {
    if (!candidate[start] || visited[start]) continue
    stack.length = 0
    stack.push(start)
    visited[start] = 1
    let minCx = start % cols
    let maxCx = minCx
    let minCy = (start / cols) | 0
    let maxCy = minCy
    let cellCount = 0
    while (stack.length) {
      const idx = stack.pop()!
      cellCount++
      const cx = idx % cols
      const cy = (idx / cols) | 0
      if (cx < minCx) minCx = cx
      if (cx > maxCx) maxCx = cx
      if (cy < minCy) minCy = cy
      if (cy > maxCy) maxCy = cy
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
          const n = ny * cols + nx
          if (!candidate[n] || visited[n]) continue
          visited[n] = 1
          stack.push(n)
        }
      }
    }
    const spanCx = maxCx - minCx + 1
    const spanCy = maxCy - minCy + 1
    if (cellCount < VECTOR_ART_MIN_CELLS || spanCx < VECTOR_ART_MIN_SPAN_CELLS || spanCy < VECTOR_ART_MIN_SPAN_CELLS) continue
    regions.push({
      x: (minCx * cell) / scale,
      y: (minCy * cell) / scale,
      width: (spanCx * cell) / scale,
      height: (spanCy * cell) / scale,
    })
  }
  return regions
}
