/**
 * Ported from the real app's `lib/childMarkers.ts`, trimmed to just the two
 * pure, read-only functions `migrate.ts` actually needs (`getChildIds`,
 * `parseSegments`) — the rest of that file (`markerHtml`, `reconstructContent`,
 * `insertMarkerInContent`, etc.) is about the *live, editable* HTML-string
 * model this migration is converting *away from*, with nothing for a
 * one-way, read-only conversion to do with it.
 */

/** All child ids referenced by `html`, in document order. */
export function getChildIds(html: string): string[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll(`[data-child-id]`)).map((el) => el.getAttribute('data-child-id')!)
}

export type Segment = { kind: 'text'; html: string } | { kind: 'child'; childId: string }

/**
 * Splits `html` into the alternating (text, child, text, child, …, text)
 * sequence a node's content actually represents — same algorithm as the
 * real app's own `parseSegments`.
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
