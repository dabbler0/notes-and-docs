/** DOM Range helpers used by the editor's citation/quote-insert/split/move actions. */
import { emptyMathMarkers } from './math'

/** Formatting-related CSS properties `stripInlineFormatting` strips off an inline `style` attribute — deliberately not *every* style property, since this app never has a legitimate reason to leave, say, a layout property on pasted text either, but naming only the formatting-facing ones documents intent rather than "whatever happens to be in a pasted style attribute." */
const FORMATTING_STYLE_PROPS = ['font-family', 'font-size', 'font-weight', 'font-style', 'color', 'background-color', 'text-decoration', 'line-height', 'letter-spacing']

/**
 * Supplements `document.execCommand('removeFormat')`, whose own handling of
 * an inline `style` attribute (as opposed to a `<b>`/`<i>`/legacy `<font>`
 * tag) is inconsistent across browsers — pasted content from Word, Google
 * Docs, or a styled web page typically carries its own font/size/color as
 * exactly that kind of inline `style` on a wrapping `<span>`, which is
 * precisely the case `removeFormat` alone can leave untouched (confirmed
 * directly: a paste that visibly changed font/size still looked exactly the
 * same after `removeFormat` on its own in Chrome). Walks every element
 * `range` actually touches, strips just the formatting-related style
 * properties above off each one, and unwraps a `<span>`/legacy `<font>` left
 * with nothing else (no remaining attributes) to justify still being there
 * — called right after `removeFormat` itself, which already handles the
 * ordinary `<b>`/`<i>`/`<u>` and other command-recognized cases this doesn't
 * need to duplicate.
 */
export function stripInlineFormatting(range: Range): void {
  const root = range.commonAncestorContainer
  const container = (root.nodeType === Node.ELEMENT_NODE ? root : root.parentElement) as Element | null
  if (!container) return
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => (range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  })
  const toUnwrap: HTMLElement[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const el = node as HTMLElement
    if (el.tagName === 'FONT') {
      toUnwrap.push(el)
      continue
    }
    if (el.style.length > 0) {
      for (const prop of FORMATTING_STYLE_PROPS) el.style.removeProperty(prop)
      if (el.getAttribute('style') === '') el.removeAttribute('style')
    }
    if (el.tagName === 'SPAN' && el.attributes.length === 0) toUnwrap.push(el)
  }
  for (const el of toUnwrap) {
    const parent = el.parentNode
    if (!parent) continue
    while (el.firstChild) parent.insertBefore(el.firstChild, el)
    parent.removeChild(el)
  }
}

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
  // The extracted fragment can carry a `.math-inline`/`.math-block`
  // equation marker straight out of the live, already-rendered editor —
  // `emptyMathMarkers` (lib/math.ts) strips its baked-in rendered children
  // back out before this becomes a saved string (this function's one job),
  // same reasoning as `reconstructContent`'s own call to it: a marker
  // persisted with its rendered children still attached duplicates the
  // equation the next time whatever this string lands in loads fresh.
  return emptyMathMarkers(div).innerHTML
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
