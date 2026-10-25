import type { EditorState, Transaction } from 'prosemirror-state'
import { essaySchema as schema } from './schema'
import { id } from './id'

type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean

function newSectionNode() {
  return schema.nodes.section.create({ id: id() }, [schema.nodes.section_title.create(), schema.nodes.paragraph.create()])
}

/** Inserts a new sibling `section` right after whichever section the selection is currently inside — the structural-node equivalent of the old app's "add a sibling subsection" tree action. */
export const insertSiblingSection: Cmd = (state, dispatch) => {
  const { $from } = state.selection
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'section') {
      if (dispatch) dispatch(state.tr.insert($from.after(d), newSectionNode()).scrollIntoView())
      return true
    }
  }
  return false
}

/** Inserts a new `section` as the last child of whichever section the selection is currently inside. */
export const insertChildSection: Cmd = (state, dispatch) => {
  const { $from } = state.selection
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'section') {
      if (dispatch) dispatch(state.tr.insert($from.end(d), newSectionNode()).scrollIntoView())
      return true
    }
  }
  return false
}

export function insertCitation(sourceId: string, note: string | null): Cmd {
  return (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(schema.nodes.citation.create({ sourceId, note })))
    return true
  }
}

export const insertFootnote: Cmd = (state, dispatch) => {
  const node = schema.nodes.footnote.create(null, schema.text('note'))
  if (dispatch) dispatch(state.tr.replaceSelectionWith(node))
  return true
}

/** Applies a fresh `comment_anchor` mark across the current selection — requires a real (non-empty) selection, same as the old app's own text-anchored comment creation did. */
export const addCommentAnchor: Cmd = (state, dispatch) => {
  const { from, to, empty } = state.selection
  if (empty) return false
  if (dispatch) dispatch(state.tr.addMark(from, to, schema.marks.comment_anchor.create({ commentId: id() })))
  return true
}
