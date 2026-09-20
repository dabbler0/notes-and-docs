import { describe, expect, it } from 'vitest'
import { reconstructSelectedText, type SelectableTextItem } from '../pdfSelection'

/** Builds a text-layer div matching what PdfViewer creates: one
 * `data-item-index`-tagged `<span>` per item, holding the item's string —
 * optionally split into extra child text nodes (simulating a search-hit
 * `<mark>` splitting one item's text). Returns the layer plus the matching
 * `SelectableTextItem[]` (same `y`/height` shape `reflowTextItems` uses). */
function buildLayer(strs: string[], ys: number[], height = 10): { layer: HTMLDivElement; pageItems: SelectableTextItem[] } {
  const layer = document.createElement('div')
  const pageItems: SelectableTextItem[] = []
  strs.forEach((str, i) => {
    const span = document.createElement('span')
    span.dataset.itemIndex = String(i)
    span.textContent = str
    layer.appendChild(span)
    pageItems.push({ str, transform: [height, 0, 0, height, 0, ys[i]] })
  })
  document.body.appendChild(layer)
  return { layer, pageItems }
}

function rangeOverWholeLayer(layer: HTMLDivElement): Range {
  const range = document.createRange()
  range.selectNodeContents(layer)
  return range
}

describe('reconstructSelectedText', () => {
  it('joins same-line items with a single space', () => {
    const { layer, pageItems } = buildLayer(['Hello', 'world.'], [700, 700])
    expect(reconstructSelectedText(rangeOverWholeLayer(layer), pageItems)).toBe('Hello world.')
  })

  it('inserts a line break for a moderate vertical gap', () => {
    const { layer, pageItems } = buildLayer(['Line one.', 'Line two.'], [700, 688])
    expect(reconstructSelectedText(rangeOverWholeLayer(layer), pageItems)).toBe('Line one.\nLine two.')
  })

  it('inserts a paragraph break for a large vertical gap', () => {
    const { layer, pageItems } = buildLayer(['First paragraph.', 'Second paragraph.'], [700, 660])
    expect(reconstructSelectedText(rangeOverWholeLayer(layer), pageItems)).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('preserves inter-word spacing for a tesseract-style PDF where every word is its own item', () => {
    // This is exactly the reported bug: one word per text item, on the same
    // line, with nothing but geometry to tell them apart.
    const { layer, pageItems } = buildLayer(['The', 'quick', 'brown', 'fox'], [700, 700, 700, 700])
    expect(reconstructSelectedText(rangeOverWholeLayer(layer), pageItems)).toBe('The quick brown fox')
  })

  it('does not insert a separator inside one item split into multiple text nodes (a search-hit mark)', () => {
    const layer = document.createElement('div')
    const span = document.createElement('span')
    span.dataset.itemIndex = '0'
    span.appendChild(document.createTextNode('hello '))
    const mark = document.createElement('mark')
    mark.textContent = 'world'
    span.appendChild(mark)
    span.appendChild(document.createTextNode('!'))
    layer.appendChild(span)
    document.body.appendChild(layer)
    const pageItems: SelectableTextItem[] = [{ str: 'hello world!', transform: [10, 0, 0, 10, 0, 700] }]
    expect(reconstructSelectedText(rangeOverWholeLayer(layer), pageItems)).toBe('hello world!')
  })

  it('handles a partial selection starting mid-item', () => {
    const { layer, pageItems } = buildLayer(['Hello', 'world.'], [700, 700])
    const range = document.createRange()
    const firstText = layer.firstElementChild!.firstChild!
    range.setStart(firstText, 3) // "lo world."
    range.setEndAfter(layer.lastElementChild!)
    expect(reconstructSelectedText(range, pageItems)).toBe('lo world.')
  })

  it('returns an empty string for a collapsed/empty range', () => {
    const { layer, pageItems } = buildLayer(['Hello'], [700])
    const range = document.createRange()
    range.selectNodeContents(layer.firstElementChild!)
    range.collapse(true)
    expect(reconstructSelectedText(range, pageItems)).toBe('')
  })
})
