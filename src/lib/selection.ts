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
 * the live DOM as it goes. Used by "split into subsection": the text after
 * the split point can't just get silently merged back in next to the text
 * before it — a marker is about to land between them — so the caller needs
 * "before" and "after" as two separate strings to put back on either side
 * of it. `container`'s innerHTML holds exactly the "before" piece once this
 * returns.
 */
export function extractAroundRange(container: HTMLElement, range: Range): { before: string; selected: string; after: string } {
  // Extract the user's own selection first, while its boundary points are
  // still exactly what they clicked-and-dragged — then collapse `range` to
  // that point and read "after" from there. Doing this the other way round
  // (extracting the trailing "after" text first) mutates the very text node
  // `range`'s own end boundary sits in whenever the selection runs right up
  // against it, which risks corrupting `range` before it's used.
  const selected = extractRangeHtml(range)
  range.collapse(true)
  let after = ''
  try {
    if (container.lastChild) {
      const afterRange = document.createRange()
      afterRange.setStart(range.startContainer, range.startOffset)
      afterRange.setEndAfter(container.lastChild)
      if (!afterRange.collapsed) after = extractRangeHtml(afterRange)
    }
  } catch {
    /* selection already ran to the end of the container */
  }
  const before = container.innerHTML
  container.innerHTML = ''
  return { before, selected, after }
}
