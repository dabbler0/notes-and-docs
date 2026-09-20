import { createWorker } from 'tesseract.js'
import { PDFDocument } from 'pdf-lib'
import { renderPageToCanvas, type PdfDoc } from './pdf'

/** Rendered noticeably higher than the ~1.3x scale used for on-screen
 * viewing (see PdfViewer.tsx) — OCR accuracy depends heavily on image
 * resolution, especially for smaller body text. */
const OCR_SCALE = 2.5

export interface OcrProgress {
  page: number
  totalPages: number
  status: string
}

/** A readable message for whatever OCR failed with — tesseract.js's worker
 * can reject with a plain string, an ErrorEvent, or other non-Error value
 * depending on where it failed (a network error loading its engine from
 * the CDN looks nothing like a recognition-time error), so `e.message`
 * alone is often `undefined`. */
export function describeOcrError(e: unknown): string {
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  return 'an unknown error — check your internet connection, since OCR needs to fetch its engine from a CDN the first time it runs'
}

/**
 * Whether a PDF's already-extracted `pageTexts` look like they came from a
 * scanned document with no real text layer at all, rather than one that
 * simply has short pages. A scan can still yield a handful of stray
 * characters per page (a page number some scanners embed as plain text,
 * or a stamp), so the bar is "next to nothing across the whole document,"
 * not "literally zero."
 */
export function looksLikeScannedPdf(pageTexts: string[]): boolean {
  if (pageTexts.length === 0) return false
  const totalChars = pageTexts.reduce((sum, t) => sum + t.replace(/\s/g, '').length, 0)
  return totalChars < pageTexts.length * 5
}

/**
 * Merges page 0 of `textLayerPdfBytes` (a single-page PDF containing only
 * an invisible text layer — the shape tesseract.js's `pdfTextOnly` output
 * takes) onto `outDoc`'s page at `pageIndex`, stretched to exactly match
 * that page's own width/height. `drawPage` adds to a page's existing
 * content rather than replacing it, so whatever the target page already
 * had (its scanned image, any existing vector content) is left completely
 * alone underneath the new, invisible text.
 */
export async function overlayTextLayer(outDoc: PDFDocument, pageIndex: number, textLayerPdfBytes: Uint8Array): Promise<void> {
  const textLayerDoc = await PDFDocument.load(textLayerPdfBytes)
  const [embeddedTextLayer] = await outDoc.embedPdf(textLayerDoc, [0])
  const targetPage = outDoc.getPages()[pageIndex]
  // Tesseract sizes its text-only PDF page to match the canvas it was
  // given, not the original page's own point dimensions — stretch it to
  // fit exactly, which realigns every word's relative position correctly
  // since the canvas was rendered at a uniform scale of this same page in
  // both dimensions.
  targetPage.drawPage(embeddedTextLayer, { x: 0, y: 0, width: targetPage.getWidth(), height: targetPage.getHeight() })
}

/**
 * Recognizes the text in a single image — a photo of a page, a screenshot
 * of a quote, whatever's easiest to get a hand-typed quote from without
 * actually typing it — and returns it as plain text. Used for a source
 * with no PDF and no extracted text at all, where there's nothing to
 * drag-select from, as an alternative to typing the quote in by hand.
 * Runs entirely client-side, same as `ocrPdf` (see its own doc comment
 * for the CDN-fetched-engine caveat, which applies here too).
 */
export async function ocrImage(image: File | Blob): Promise<string> {
  const worker = await createWorker('eng')
  try {
    const { data } = await worker.recognize(image)
    return (data.text ?? '').trim()
  } finally {
    await worker.terminate()
  }
}

/**
 * Runs OCR against every page of a PDF and returns a new PDF — same pages,
 * same visual appearance — with an invisible, selectable text layer burned
 * into each one, ready to be treated exactly like a PDF that had real text
 * all along (re-extracted via `extractPageTexts`, searched, quoted from).
 *
 * The approach: render each page to a canvas at OCR resolution, ask
 * tesseract.js to recognize it and hand back a *text-only* single-page PDF
 * (`pdfTextOnly: true` — invisible text, no re-rendered image) sized to
 * that canvas, then use pdf-lib to embed that page as an object on top of
 * the corresponding *original* page, stretched to exactly match its own
 * dimensions. The original page's own content (whatever image or vector
 * data it already had) is left completely alone — only an invisible text
 * layer is added on top of it.
 *
 * Everything here runs in the browser: page images are rendered locally
 * and never leave it. tesseract.js does fetch its OCR engine and language
 * model from a CDN the first time it's used (the same jsDelivr-hosted
 * pattern this app already relies on for pdf.js's own cmap/font data —
 * see PDFJS_VERSION in pdf.ts) — that's the OCR *software*, not anything
 * derived from the user's document.
 */
export async function ocrPdf(originalBytes: ArrayBuffer, doc: PdfDoc, onProgress?: (p: OcrProgress) => void): Promise<Uint8Array> {
  const worker = await createWorker('eng')
  try {
    const outDoc = await PDFDocument.load(originalBytes)
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.({ page: i, totalPages: doc.numPages, status: 'Rendering page…' })
      const canvas = document.createElement('canvas')
      await renderPageToCanvas(doc, i, canvas, OCR_SCALE)

      onProgress?.({ page: i, totalPages: doc.numPages, status: 'Recognizing text…' })
      const { data } = await worker.recognize(canvas, { pdfTextOnly: true }, { pdf: true })

      if (data.pdf && data.pdf.length > 0) {
        await overlayTextLayer(outDoc, i - 1, new Uint8Array(data.pdf))
      }
    }
    onProgress?.({ page: doc.numPages, totalPages: doc.numPages, status: 'Saving…' })
    return await outDoc.save()
  } finally {
    await worker.terminate()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not encode a rendered page as an image'))), type, quality)
  })
}

/**
 * Re-runs OCR on a PDF that may already have a text layer of its own —
 * either from a previous run of `ocrPdf`, or genuine embedded text the
 * document had all along. `ocrPdf` draws its new invisible text layer on
 * top of whatever a page already had, which is correct and lossless the
 * *first* time (there's nothing there yet to collide with) but would leave
 * two overlapping, simultaneously-selectable text layers behind here —
 * every re-recognized page would extract as its own text doubled up and
 * interleaved with itself, which defeats the entire point of letting
 * someone compare a fresh OCR pass against what they already had.
 *
 * Instead, each page is rebuilt from a blank slate: rendered to an image
 * (discarding whatever content — real text, vector art, a prior OCR pass's
 * invisible layer — the page already had) at the same OCR resolution
 * `ocrPdf` recognizes against, reusing that exact rendering as both the new
 * page's own visible content and tesseract's input, then given a single,
 * fresh invisible text layer over that image via the same `overlayTextLayer`
 * `ocrPdf` uses — exactly the shape a brand new scan-and-OCR would produce,
 * regardless of what this PDF looked like internally beforehand. Visually
 * the same (each page is reproduced at high resolution, sized back down to
 * the original page's own dimensions), still entirely client-side, and
 * still needs tesseract's CDN-hosted engine on first use (see `ocrPdf`'s
 * own doc comment for that caveat).
 *
 * Deliberately returns just the new bytes rather than saving them as this
 * source's PDF — the caller (`SourceDetailDialog`) is expected to let the
 * user preview the result before deciding whether to keep it or discard it
 * in favor of what they already had.
 */
export async function reOcrPdf(doc: PdfDoc, onProgress?: (p: OcrProgress) => void): Promise<Uint8Array> {
  const worker = await createWorker('eng')
  try {
    const outDoc = await PDFDocument.create()
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress?.({ page: i, totalPages: doc.numPages, status: 'Rendering page…' })
      const canvas = document.createElement('canvas')
      await renderPageToCanvas(doc, i, canvas, OCR_SCALE)

      const pdfPage = await doc.getPage(i)
      const { width, height } = pdfPage.getViewport({ scale: 1 })
      const outPage = outDoc.addPage([width, height])
      const imageBytes = await (await canvasToBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer()
      const image = await outDoc.embedJpg(imageBytes)
      outPage.drawImage(image, { x: 0, y: 0, width, height })

      onProgress?.({ page: i, totalPages: doc.numPages, status: 'Recognizing text…' })
      const { data } = await worker.recognize(canvas, { pdfTextOnly: true }, { pdf: true })

      if (data.pdf && data.pdf.length > 0) {
        await overlayTextLayer(outDoc, i - 1, new Uint8Array(data.pdf))
      }
    }
    onProgress?.({ page: doc.numPages, totalPages: doc.numPages, status: 'Saving…' })
    return await outDoc.save()
  } finally {
    await worker.terminate()
  }
}
