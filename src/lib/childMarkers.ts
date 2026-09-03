/**
 * How a node's own content embeds its subsections, modeled directly on how
 * HTML embeds child elements: a subsection is a literal, non-editable
 * marker element sitting wherever the text it was carved out of used to be,
 * with ordinary editable text free to come before, after, or between
 * markers. A node's `draftContent` is source-of-truth HTML containing these
 * markers; there is no separate child-list field — "what are this node's
 * children, and in what order" is simply "whatever marker elements appear
 * in its content, in document order."
 *
 * The live editor never actually mounts a marker div: SectionBlock renders
 * a real recursive child component in its place instead. So markers only
 * ever exist in the *stored* HTML string — parseSegments() reads them out
 * of a saved string, and reconstructContent() below writes fresh ones back
 * by walking the live DOM (where a mounted child shows up as a nested
 * `.section-block[data-node-id]`, not as a marker).
 */

const MARKER_CLASS = 'child-embed'

export function markerHtml(childId: string): string {
  return `<div class="${MARKER_CLASS}" data-child-id="${childId}" contenteditable="false"></div>`
}

/** All child ids referenced by `html`, in document order. */
export function getChildIds(html: string): string[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll(`[data-child-id]`)).map((el) => el.getAttribute('data-child-id')!)
}

export type Segment = { kind: 'text'; html: string } | { kind: 'child'; childId: string }

/**
 * Splits `html` into the alternating (text, child, text, child, …, text)
 * sequence a node's content actually represents, so the editor can render
 * each text run as its own small editable shard with the recursive child
 * sections mounted in between, in the same order they appear in the markup.
 */
export function parseSegments(html: string): Segment[] {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const container = doc.body
  const markers = Array.from(container.querySelectorAll('[data-child-id]'))
  if (markers.length === 0) return [{ kind: 'text', html }]

  const segments: Segment[] = []
  let cursor: { node: Node; offset: number } = { node: container, offset: 0 }

  for (const marker of markers) {
    const r = doc.createRange()
    r.setStart(cursor.node, cursor.offset)
    r.setEndBefore(marker)
    segments.push({ kind: 'text', html: rangeOuterHtml(r) })
    segments.push({ kind: 'child', childId: marker.getAttribute('data-child-id')! })
    const parent = marker.parentNode!
    const idx = Array.prototype.indexOf.call(parent.childNodes, marker)
    cursor = { node: parent, offset: idx + 1 }
  }
  const tail = doc.createRange()
  tail.setStart(cursor.node, cursor.offset)
  tail.setEndAfter(container.lastChild ?? container)
  segments.push({ kind: 'text', html: rangeOuterHtml(tail) })

  return segments
}

function rangeOuterHtml(range: Range): string {
  if (range.collapsed) return ''
  const frag = range.cloneContents()
  const div = document.createElement('div')
  div.appendChild(frag)
  return div.innerHTML
}

/**
 * Rebuilds a node's stored content string by walking its *live* rendered
 * DOM (found via `[data-node-id]` + the `.live-pane .section-body` wrapper
 * below it — `.live-pane` is always present, comparing-versions or not, so
 * this doesn't care which mode the section is in) — every `.node-content`
 * shard contributes its current (possibly just-edited) innerHTML, and every
 * nested `.section-block` contributes a fresh marker for that child. Two
 * optional edits can be folded in at the same time, so a single DOM read
 * stays the source of truth for the save:
 *  - `replace`: substitute a specific child's marker with different HTML
 *    outright (used by "demote", which inlines the child's own text).
 *  - `insertAfter`: splice extra HTML in right after a given live element
 *    (used by "split", to drop in the marker(s) for newly-created children
 *    next to the shard they were carved out of).
 * Returns null if this node isn't currently mounted (e.g. an ancestor is
 * collapsed away, or the essay view isn't open) — callers should fall back
 * to the last-saved draftContent in that case.
 */
export function reconstructContent(nodeId: string, opts?: { replace?: Map<string, string>; insertAfter?: { el: Element; html: string } }): string | null {
  const root = document.querySelector(`[data-node-id="${cssEscape(nodeId)}"]`)
  const wrapper = root?.querySelector(':scope > .section-content-row > .live-pane > .section-body')
  if (!wrapper) return null
  const parts: string[] = []
  for (const child of Array.from(wrapper.children)) {
    if (child.classList.contains('node-content')) {
      parts.push((child as HTMLElement).innerHTML)
    } else if (child.hasAttribute('data-node-id')) {
      const cid = child.getAttribute('data-node-id')!
      parts.push(opts?.replace?.get(cid) ?? markerHtml(cid))
    }
    if (opts?.insertAfter?.el === child) {
      parts.push(opts.insertAfter.html)
    }
  }
  return parts.join('')
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/**
 * Structural moves (drag-and-drop reordering/reparenting in the tree nav)
 * work purely on the saved content *string*, unlike split/demote — a drag
 * can target a node that's currently collapsed or off in another part of
 * the tree, so there's no guarantee the relevant DOM is even mounted. This
 * is safe because a marker's serialized form is always byte-identical
 * (markerHtml() is a pure function of the id), so it can be found and
 * spliced with a plain string search instead of a DOM parse.
 */
export function removeMarkerFromContent(html: string, childId: string): string {
  return html.split(markerHtml(childId)).join('')
}

export type MarkerPlacement = { beforeId: string } | { afterId: string } | { atStart: true } | { atEnd: true }

export function insertMarkerInContent(html: string, childId: string, placement: MarkerPlacement): string {
  const token = markerHtml(childId)
  if ('atStart' in placement) return token + html
  if ('beforeId' in placement) {
    const anchor = markerHtml(placement.beforeId)
    const idx = html.indexOf(anchor)
    if (idx === -1) return html + token
    return html.slice(0, idx) + token + html.slice(idx)
  }
  if ('afterId' in placement) {
    const anchor = markerHtml(placement.afterId)
    const idx = html.indexOf(anchor)
    if (idx === -1) return html + token
    return html.slice(0, idx + anchor.length) + token + html.slice(idx + anchor.length)
  }
  return html + token
}
