/**
 * `overlayTextLayer`, the pdf-lib merge step `ocrPdf` uses to burn a
 * tesseract-produced "text-only" PDF page onto the corresponding page of
 * the original document. This is the part of OCR that's actually testable
 * offline — the OCR recognition step itself (tesseract.js) needs its
 * engine and language data from a CDN at runtime, which isn't available
 * in a sandboxed test environment, but the merge logic (embedding a
 * text-only page, stretching it to fit, leaving the original page's own
 * content alone) has nothing to do with tesseract and is fully exercised
 * here with a hand-built stand-in "text layer" PDF.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
// pdfjs-dist's regular build resolves its worker via a Vite-specific `?url`
// import (see lib/pdf.ts), which only works inside a real Vite dev/build
// pipeline. The Node-friendly "legacy" build works standalone, without a
// separate worker file, which is all this test's own verification step
// needs — the code actually under test here (overlayTextLayer) is pure
// pdf-lib and never touches pdf.js at all.
import * as pdfjsLegacy from 'pdfjs-dist/legacy/build/pdf.mjs'
import { overlayTextLayer } from '../ocr'

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer
}

async function extractedText(pdfBytes: Uint8Array): Promise<string> {
  const doc = await pdfjsLegacy.getDocument({ data: toArrayBuffer(pdfBytes) }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  return content.items.map((it: any) => ('str' in it ? it.str : '')).join(' ')
}

describe('overlayTextLayer', () => {
  it('adds selectable text to a page that previously had none', async () => {
    // A "scanned" base page: some drawn content, standing in for a page
    // image, but genuinely zero real text — exactly like a real scan.
    const baseDoc = await PDFDocument.create()
    const basePage = baseDoc.addPage([600, 800])
    basePage.drawRectangle({ x: 0, y: 0, width: 600, height: 800, color: rgb(0.9, 0.9, 0.9) })
    const baseBytes = await baseDoc.save()
    expect(await extractedText(baseBytes)).toBe('')

    // A "text layer" PDF, standing in for tesseract's own `pdfTextOnly`
    // output — same page size, one real text run (drawn visibly here,
    // purely so it's easy to eyeball if this test ever needs debugging;
    // overlayTextLayer doesn't care whether it's visible or not).
    const textLayerDoc = await PDFDocument.create()
    const font = await textLayerDoc.embedFont(StandardFonts.Helvetica)
    const textLayerPage = textLayerDoc.addPage([600, 800])
    textLayerPage.drawText('Recognized OCR text', { x: 50, y: 700, size: 24, font })
    const textLayerBytes = await textLayerDoc.save()

    const outDoc = await PDFDocument.load(baseBytes)
    await overlayTextLayer(outDoc, 0, textLayerBytes)
    const mergedBytes = await outDoc.save()

    expect(await extractedText(mergedBytes)).toContain('Recognized OCR text')
    // The page's own dimensions are unaffected by the overlay.
    const mergedPage = (await PDFDocument.load(mergedBytes)).getPages()[0]
    expect(mergedPage.getWidth()).toBe(600)
    expect(mergedPage.getHeight()).toBe(800)
  })

  it('stretches the text layer to fit when it was rendered at a different size than the target page', async () => {
    // The target page is a different size than the text-layer PDF —
    // exactly the real situation: tesseract sizes its output to the OCR
    // canvas's own pixel dimensions, not the PDF page's point dimensions.
    const baseDoc = await PDFDocument.create()
    baseDoc.addPage([300, 400])
    const baseBytes = await baseDoc.save()

    const textLayerDoc = await PDFDocument.create()
    const font = await textLayerDoc.embedFont(StandardFonts.Helvetica)
    const textLayerPage = textLayerDoc.addPage([600, 800])
    textLayerPage.drawText('Stretched text', { x: 50, y: 700, size: 24, font })
    const textLayerBytes = await textLayerDoc.save()

    const outDoc = await PDFDocument.load(baseBytes)
    await overlayTextLayer(outDoc, 0, textLayerBytes)
    const mergedBytes = await outDoc.save()

    expect(await extractedText(mergedBytes)).toContain('Stretched text')
    const mergedPage = (await PDFDocument.load(mergedBytes)).getPages()[0]
    expect(mergedPage.getWidth()).toBe(300)
    expect(mergedPage.getHeight()).toBe(400)
  })

  it('overlays only the requested page, leaving other pages untouched', async () => {
    const baseDoc = await PDFDocument.create()
    baseDoc.addPage([400, 500])
    baseDoc.addPage([400, 500])
    const baseBytes = await baseDoc.save()

    const textLayerDoc = await PDFDocument.create()
    const font = await textLayerDoc.embedFont(StandardFonts.Helvetica)
    textLayerDoc.addPage([400, 500]).drawText('Page two text', { x: 20, y: 400, size: 18, font })
    const textLayerBytes = await textLayerDoc.save()

    const outDoc = await PDFDocument.load(baseBytes)
    await overlayTextLayer(outDoc, 1, textLayerBytes)
    const mergedBytes = await outDoc.save()

    const doc = await pdfjsLegacy.getDocument({ data: toArrayBuffer(mergedBytes) }).promise
    const page1Content = await (await doc.getPage(1)).getTextContent()
    const page2Content = await (await doc.getPage(2)).getTextContent()
    expect(page1Content.items).toHaveLength(0)
    expect(page2Content.items.map((it: any) => it.str).join(' ')).toContain('Page two text')
  })
})
