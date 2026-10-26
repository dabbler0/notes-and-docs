import { Fragment, DOMSerializer } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { essaySchema } from '../../lib/pmSchema'
import { pageNote } from '../../lib/bibtex'
import { id } from '../../lib/id'
import type { Source } from '../../models/types'

/** `citationHtml`'s own `note` formatting (`lib/bibtex.ts`) — an explicit note wins, otherwise `pageNote` derives "p. N" from a page number (empty if the source has no page numbers at all). Shared by every insertion command below, same as the old HTML-chip path shared it through `citationHtml` itself. */
function resolveNote(source: Source, opts: { note?: string; page?: number }): string | null {
  const note = opts.note?.trim() || pageNote(source, opts.page)
  return note || null
}

/**
 * Every insertion command below builds its own transaction as a sequence
 * of plain edits-at-the-current-selection (`replaceSelectionWith`/
 * `insertText`, no explicit position arguments) rather than computing
 * positions by hand — each call leaves the transaction's own selection
 * collapsed right after whatever it just inserted (ProseMirror maps it
 * automatically), so the next call in the chain always lands in the right
 * place, the same way a real user's own sequential keystrokes would.
 */
export function insertCitation(view: EditorView, source: Source, note?: string): void {
  const { state } = view
  const citationNode = essaySchema.nodes.citation.create({ sourceId: source.id, note: resolveNote(source, { note }) })
  const tr = state.tr.replaceSelectionWith(citationNode, false)
  tr.insertText(' ')
  view.dispatch(tr)
  view.focus()
}

/**
 * A block quote pulled from a source, followed by its own citation — same
 * shape `insertQuote` in the old `EssayWorkspace.tsx` produced
 * (`<blockquote class="quote">` + a citation paragraph right after it).
 * The new `blockquote` node carries no `sourceId`/`page` attrs of its own
 * — same as a migrated essay's own blockquotes never got them either (see
 * `pmMigration.ts`'s own `blockquoteToPM`, which never special-cased a
 * `.quote` class) — the citation node right after it is already the real,
 * structural record of which source/page this quote came from.
 */
export function insertQuoteBlock(view: EditorView, source: Source, quoteText: string, page: number): void {
  const { state } = view
  const quoteNode = essaySchema.nodes.blockquote.create(null, essaySchema.nodes.paragraph.create(null, essaySchema.text(quoteText)))
  const citationNode = essaySchema.nodes.citation.create({ sourceId: source.id, note: resolveNote(source, { page }) })
  const citationPara = essaySchema.nodes.paragraph.create(null, citationNode)
  const tr = state.tr.replaceSelectionWith(quoteNode, false)
  tr.insert(tr.selection.to, citationPara)
  view.dispatch(tr)
  view.focus()
}

/** A quote excerpt set inline, mid-sentence — `quote_inline`-marked text (curly quotes, matching the old app's own rendering) plus the same trailing citation, right at the cursor with no paragraph break. */
export function insertQuoteInline(view: EditorView, source: Source, quoteText: string, page: number): void {
  const { state } = view
  const mark = essaySchema.marks.quote_inline.create({ sourceId: source.id, page })
  const citationNode = essaySchema.nodes.citation.create({ sourceId: source.id, note: resolveNote(source, { page }) })
  const tr = state.tr.insertText(`“${quoteText}”`)
  tr.addMark(tr.selection.to - quoteText.length - 2, tr.selection.to, mark)
  tr.insertText(' ')
  tr.replaceSelectionWith(citationNode, false)
  tr.insertText(' ')
  view.dispatch(tr)
  view.focus()
}

/** "Link to source": wraps the selection (or, with nothing selected, the source's own title) in a `source_link`-marked link, followed by a citation — same "always cite what a bare link points to" rule the old app's `insertSourceLink` followed. */
export function insertSourceLink(view: EditorView, source: Source, linkText: string): void {
  const { state } = view
  const mark = essaySchema.marks.source_link.create({ sourceId: source.id })
  const citationNode = essaySchema.nodes.citation.create({ sourceId: source.id, note: null })
  const tr = state.tr.insertText(linkText)
  tr.addMark(tr.selection.to - linkText.length, tr.selection.to, mark)
  tr.insertText(' ')
  tr.replaceSelectionWith(citationNode, false)
  tr.insertText(' ')
  view.dispatch(tr)
  view.focus()
}

/**
 * "Split into subsection": promotes the current selection into a new
 * child `section` right at that position — the structural-editing
 * counterpart to the old app's `beginSplit` (which sliced the live shard's
 * own HTML into before/selected/after strings and spliced in a marker).
 *
 * Operates at whole-block granularity: the selection is expanded to cover
 * every block it touches (`$from.blockRange($to)`), and that whole range
 * is lifted into the new section's own content — a deliberate
 * simplification from the old app's own mid-paragraph text split (which
 * could promote a few selected words out of the middle of a sentence into
 * their own subsection). Selecting one or more complete paragraphs — the
 * overwhelmingly common real case — behaves identically either way.
 */
export function splitIntoSection(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, $to, empty } = state.selection
  if (empty) return false
  const range = $from.blockRange($to)
  if (!range || range.parent.type.name !== 'section') return false
  if (dispatch) {
    const slice = state.doc.slice(range.start, range.end)
    const titleNode = essaySchema.nodes.section_title.create()
    const content = Fragment.from(titleNode).append(slice.content)
    const newSection = essaySchema.nodes.section.create({ id: id() }, content)
    const tr = state.tr.replaceWith(range.start, range.end, newSection)
    dispatch(tr)
  }
  return true
}

/**
 * "Demote": the inverse of `splitIntoSection` — folds the section
 * containing the selection back into its own parent, splicing its content
 * (everything but its own `section_title`, which is simply discarded —
 * same as the old app's own `demoteChild`, which only ever ported a
 * child's `draftContent` up, never its title) directly in at the position
 * the section itself used to occupy. Grandchildren (nested sections)
 * travel along for free, since they're just more content inside what gets
 * spliced in.
 */
export function demoteSection(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from } = state.selection
  let sectionDepth = -1
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === 'section') {
      sectionDepth = d
      break
    }
  }
  // Depth 1 is the document's own single root section — nothing to demote into.
  if (sectionDepth <= 1) return false
  if (dispatch) {
    const sectionNode = $from.node(sectionDepth)
    const start = $from.before(sectionDepth)
    const end = $from.after(sectionDepth)
    // Every child but the first (section_title) is what gets spliced in.
    const content = sectionNode.content.cut(sectionNode.firstChild!.nodeSize)
    const tr = state.tr.replaceWith(start, end, content)
    dispatch(tr)
  }
  return true
}

/** Serializes a document slice to plain HTML via the schema's own `toDOM` — `pmSchema.ts` already defines exactly this for every node/mark, so no separate HTML-rendering logic is needed here. Used by "Send to graveyard," which keeps its own storage format (`GraveyardFragment.html`) unchanged regardless of what model the live editor uses. */
export function sliceToHtml(slice: { content: Fragment }): string {
  const serializer = DOMSerializer.fromSchema(essaySchema)
  const fragmentDom = serializer.serializeFragment(slice.content)
  const div = document.createElement('div')
  div.appendChild(fragmentDom)
  return div.innerHTML
}
