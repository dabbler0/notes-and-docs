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

/**
 * Splits `container`'s current content into (before, selected, after) HTML
 * strings around `range`, removing the "selected" and "after" pieces from
 * the live DOM as it goes (used by the "split into subsection" action: the
 * leftover before/after text needs to become its own section(s) too, since
 * a node is only meant to keep its own text as long as nobody has carved a
 * subsection out of it). `container`'s innerHTML holds exactly the "before"
 * piece once this returns.
 */
export function extractAroundRange(container: HTMLElement, range: Range): { before: string; selected: string; after: string } {
  let after = ''
  try {
    if (container.lastChild) {
      const afterRange = document.createRange()
      afterRange.setStart(range.endContainer, range.endOffset)
      afterRange.setEndAfter(container.lastChild)
      if (!afterRange.collapsed) after = extractRangeHtml(afterRange)
    }
  } catch {
    /* selection already ran to the end of the container */
  }
  const selected = extractRangeHtml(range)
  const before = container.innerHTML
  container.innerHTML = ''
  return { before, selected, after }
}
