import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import { slideSchema, slideJson } from '../../lib/slideSchema'
import { pageNote } from '../../lib/bibtex'
import { id } from '../../lib/id'
import type { Source } from '../../models/types'

function resolveNote(source: Source, note?: string): string | null {
  const trimmed = note?.trim() || pageNote(source, undefined)
  return trimmed || null
}

/** Same shape as `pmCommands.ts`'s own `insertCitation` — see its doc comment. */
export function insertCitation(view: EditorView, source: Source, note?: string): void {
  const { state } = view
  const citationNode = slideSchema.nodes.citation.create({ sourceId: source.id, note: resolveNote(source, note) })
  const tr = state.tr.replaceSelectionWith(citationNode, false)
  tr.insertText(' ')
  view.dispatch(tr)
  view.focus()
}

/** Finds the enclosing `slide` node's own position for wherever the selection currently is — every command below that acts "on the current slide" (new slide after it, delete it, change its layout from a per-slide control) needs this first. */
export function findEnclosingSlide(view: EditorView): { pos: number; node: PMNode } | null {
  const { $from } = view.state.selection
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'slide') return { pos: $from.before(d), node: $from.node(d) }
  }
  return null
}

/** Inserts a brand-new slide right after the one at `afterPos` (or at the document's end if omitted), focused into its own title. */
export function insertSlideAfter(view: EditorView, afterPos: number | null, layout: 'title' | 'section' | 'content' | 'bibliography' = 'content'): void {
  const { state } = view
  const insertPos = afterPos != null ? afterPos + state.doc.nodeAt(afterPos)!.nodeSize : state.doc.content.size
  const node = state.schema.nodeFromJSON(slideJson('', layout, id()))
  let tr = state.tr.insert(insertPos, node)
  // Lands the cursor inside the new slide's own (empty) title, same "ready
  // to type immediately" convention `pmCommands.ts`'s own insertion
  // commands already follow.
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(insertPos + 2)))
  view.dispatch(tr)
  view.focus()
}

/** Removes the slide at `pos` outright — refuses when it's the deck's only slide, since an empty deck has nothing for the editor/presenter to render. */
export function deleteSlide(view: EditorView, pos: number): boolean {
  const { state } = view
  if (state.doc.childCount <= 1) return false
  const node = state.doc.nodeAt(pos)
  if (!node) return false
  view.dispatch(state.tr.delete(pos, pos + node.nodeSize))
  return true
}

export function setSlideLayout(view: EditorView, pos: number, layout: string): void {
  const { state } = view
  const node = state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, layout }))
}
