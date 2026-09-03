import * as pdfjsLib from 'pdfjs-dist'
// Vite inlines this as a data: URI (see vite.config.ts assetsInlineLimit),
// so the worker ships inside the single-file build with no separate request.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type PdfDoc = pdfjsLib.PDFDocumentProxy

export async function loadPdf(data: ArrayBuffer): Promise<PdfDoc> {
  const task = pdfjsLib.getDocument({ data })
  return task.promise
}

/** Extracts plain text per page, for search indexing and quoting. */
export async function extractPageTexts(doc: PdfDoc): Promise<string[]> {
  const pages: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const text = content.items.map((it: any) => ('str' in it ? it.str : '')).join(' ')
    pages.push(text.replace(/\s+/g, ' ').trim())
  }
  return pages
}

export interface PageTextItem {
  str: string
  transform: number[]
  width: number
  height: number
}

export async function getPageTextItems(doc: PdfDoc, pageNumber: number): Promise<{ items: PageTextItem[]; viewportWidth: number; viewportHeight: number }> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  return {
    items: content.items as unknown as PageTextItem[],
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  }
}

export async function renderPageToCanvas(doc: PdfDoc, pageNumber: number, canvas: HTMLCanvasElement, scale: number): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(pageNumber)
  const viewport = page.getViewport({ scale })
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport }).promise
  return { width: viewport.width, height: viewport.height }
}
