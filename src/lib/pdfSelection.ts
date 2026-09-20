import { normalizeReflowedText, separatorForGap, textItemHeight } from './pdf'

export interface SelectableTextItem {
  str: string
  transform: number[]
}

/**
 * Turns a live DOM `Range` over `PdfViewer`'s text layer into text with real
 * whitespace, instead of relying on `Selection.toString()` — which drops
 * whitespace entirely at every boundary between the layer's absolutely
 * positioned `<span>`s, since there's no actual space character between
 * them in the DOM. Normally that only costs line breaks (words on the same
 * line are usually one pdf.js text item, embedded spaces and all); for a
 * tesseract-OCR'd PDF, where each *word* is its own item, it silently
 * deletes every inter-word space too.
 *
 * `pageItems` must be the same `{str, transform}` items PdfViewer built the
 * current page's spans from, in the same order it tagged them with
 * `data-item-index` — this reapplies the identical gap-based heuristic
 * `reflowTextItems` already uses for the bulk-extracted page text, so a
 * selection spanning line and paragraph breaks gets the same breaks back.
 * Text nodes are grouped by their nearest `data-item-index` ancestor so a
 * search-highlight `<mark>` splitting one item's text into several DOM text
 * nodes doesn't get treated as a boundary between two different items.
 */
export function reconstructSelectedText(range: Range, pageItems: SelectableTextItem[]): string {
  const frag = range.cloneContents()
  const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT)
  let text = ''
  let prevIndex: number | null = null
  let prevHeight = 10
  let node: Node | null
  while ((node = walker.nextNode())) {
    const str = node.textContent
    if (!str) continue
    const el = node.parentElement?.closest('[data-item-index]')
    const idx = el ? Number(el.getAttribute('data-item-index')) : null

    if (prevIndex === null || idx === null || idx === prevIndex) {
      text += str
    } else {
      const prevItem = pageItems[prevIndex]
      const item = pageItems[idx]
      if (prevItem && item) {
        const height = textItemHeight(item, prevHeight)
        text += separatorForGap(prevItem.transform[5] - item.transform[5], height) + str
        prevHeight = height
      } else {
        text += ' ' + str
      }
    }
    if (idx !== null) prevIndex = idx
  }
  return normalizeReflowedText(text)
}
