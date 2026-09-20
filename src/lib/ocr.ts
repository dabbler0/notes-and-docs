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
