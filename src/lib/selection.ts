/** DOM Range helpers used by the editor's citation/quote-insert/split/move actions. */

export function getRangeWithin(container: HTMLElement): Range | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!container.contains(range.commonAncestorContainer)) return null
  return range.cloneRange()
}

export function insertNodeAtRange(range: Range, node: Node) {
  range.deleteContents()
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

export function insertHtmlAtRange(range: Range, html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  const frag = template.content
  const lastNode = frag.lastChild
  range.deleteContents()
  range.insertNode(frag)
  if (lastNode) {
    range.setStartAfter(lastNode)
    range.collapse(true)
    const sel = document.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
}

/** Removes the range's contents from the DOM and returns their HTML. */
export function extractRangeHtml(range: Range): string {
  const frag = range.extractContents()
  const div = document.createElement('div')
  div.appendChild(frag)
  return div.innerHTML
}

export function plainTextOfRange(range: Range): string {
  return range.toString()
}
