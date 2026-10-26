import { Fragment, DOMSerializer, DOMParser as PMDOMParser } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode, Mark, ResolvedPos } from 'prosemirror-model'
import { essaySchema } from '../../lib/pmSchema'
import { pageNote } from '../../lib/bibtex'
import { id } from '../../lib/id'
import type { Source } from '../../models/types'

/** Walks up from `$pos` to the nearest enclosing `section` — shared by "Send to graveyard" (`sendSelectionToGraveyard`, EssayWorkspace.tsx) and comment-anchor insertion below, both of which need "which section does this position belong to" as a best-effort reference (never dereferenced structurally — a section can be renamed/moved/deleted without anything here needing to follow it). */
export function findEnclosingSection($pos: ResolvedPos): { id: string; title: string } | null {
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d)
    if (node.type.name === 'section') {
      return { id: node.attrs.id, title: node.firstChild?.textContent || 'Untitled section' }
    }
  }
  return null
}

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
 * Inserts a `footnote` at the current selection (replacing it, same as
 * every other insertion command here) and places the cursor right inside
 * its own body, ready to type immediately: the toolbar's "Insert
 * footnote" button, the PM-native counterpart of the old model's own
 * `insertFootnote` (which created a separate `Footnote` record *and*
 * spliced a `<sup class="footnote-ref">` marker into the text — see
 * `pmSchema.ts`'s own doc comment on why a footnote's body is real
 * document content now, with nothing else to create alongside it).
 *
 * Seeded with one zero-width space rather than left genuinely empty —
 * confirmed live that a truly empty `footnote` (an inline, non-textblock
 * node — see `FootnoteView`'s own doc comment) gives the browser nothing
 * to actually land a real cursor on, so the selection silently fell back
 * to wherever it was *before* the insert instead, and everything typed
 * right after landed in the surrounding paragraph, not the footnote at
 * all. The same placeholder `pmMigration.ts`'s own `walkInline` already
 * uses for a migrated empty comment anchor, for the same underlying
 * reason (see `insertCommentAnchorMark`, above).
 */
export function insertFootnote(view: EditorView): void {
  const { state } = view
  const from = state.selection.from
  const footnoteNode = essaySchema.nodes.footnote.create(null, essaySchema.text('​'))
  const tr = state.tr.replaceSelectionWith(footnoteNode, false)
  tr.setSelection(TextSelection.create(tr.doc, from + 2))
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

/**
 * Flips a section's own `collapsed` attr by its stable `id` — the one
 * command shared by both collapse affordances (the in-document chevron,
 * `pmNodeViews.ts`'s `SectionView`, which already has its own position via
 * `getPos()` and dispatches directly instead of calling this; and the
 * outline sidebar's chevron, `NodeTree.tsx`, which only has the section's
 * `id` and needs a doc walk to find it). Both ultimately write the same
 * attr on the same document, so the sidebar and the document itself can
 * never show a section as open in one place and folded in the other.
 */
export function toggleSectionCollapsed(view: EditorView, sectionId: string): void {
  const hits: { pos: number; node: PMNode }[] = []
  view.state.doc.descendants((n, p) => {
    if (hits.length) return false
    if (n.type.name === 'section' && n.attrs.id === sectionId) hits.push({ pos: p, node: n })
    return true
  })
  const hit = hits[0]
  if (!hit) return
  view.dispatch(view.state.tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, collapsed: !hit.node.attrs.collapsed }))
}

/** Serializes a document slice to plain HTML via the schema's own `toDOM` — `pmSchema.ts` already defines exactly this for every node/mark, so no separate HTML-rendering logic is needed here. Used by "Send to graveyard," which keeps its own storage format (`GraveyardFragment.html`) unchanged regardless of what model the live editor uses. */
export function sliceToHtml(slice: { content: Fragment }): string {
  const serializer = DOMSerializer.fromSchema(essaySchema)
  const fragmentDom = serializer.serializeFragment(slice.content)
  const div = document.createElement('div')
  div.appendChild(fragmentDom)
  return div.innerHTML
}

/**
 * Wraps the current selection in a `comment_anchor` mark carrying a fresh
 * `commentId` — the PM-native counterpart of the old app's own
 * `insertCommentAnchor`, a real document edit (a `Transaction`) rather
 * than DOM surgery on a live `contentEditable` shard. With nothing
 * selected (an "inline comment, right here" — see `Comment.displayMode`'s
 * own doc comment), there's no existing content to mark — PM can't apply
 * a mark to a zero-length range — so this inserts one zero-width space
 * first and marks that: the exact same placeholder `pmMigration.ts`'s own
 * `walkInline` already invents when converting an old empty `<mark></mark>`
 * anchor, so an essay's zero-width anchors look identical regardless of
 * whether they were just created here or migrated from pre-PM data.
 * Returns the anchor's own plain text (empty for a zero-width one), the id
 * of its enclosing section, and the position right after it — the first
 * two are what `essayCommentActions.ts` needs to build the `Comment`
 * record itself; the third is where `EssayWorkspace.tsx`'s own
 * `beginComment` positions the composer popup (`view.coordsAtPos`).
 */
export function insertCommentAnchorMark(view: EditorView, commentId: string): { anchorText: string; sectionId: string | null; pos: number } {
  const { state } = view
  const { $from, empty } = state.selection
  const section = findEnclosingSection($from)
  const mark = essaySchema.marks.comment_anchor.create({ commentId })
  if (empty) {
    const tr = state.tr.insertText('​')
    const end = tr.selection.to
    tr.addMark(end - 1, end, mark)
    view.dispatch(tr)
    return { anchorText: '', sectionId: section?.id ?? null, pos: end }
  }
  const { from, to } = state.selection
  const anchorText = state.doc.textBetween(from, to, ' ').trim()
  view.dispatch(state.tr.addMark(from, to, mark))
  return { anchorText, sectionId: section?.id ?? null, pos: to }
}

/** Every `(from, to, mark)` hit for `commentId`'s own `comment_anchor` mark, across however many adjacent text runs it happens to span (a bold word in the middle of an otherwise-plain highlighted phrase is two text nodes carrying the same mark, not one) — the shared lookup `removeCommentAnchorMark`/`pmCommentPlugin.ts`'s inline-preview placement both need. */
function findCommentAnchorHits(doc: PMNode, commentId: string): { from: number; to: number; mark: Mark; text: string }[] {
  const hits: { from: number; to: number; mark: Mark; text: string }[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'comment_anchor' && m.attrs.commentId === commentId)
    if (mark) hits.push({ from: pos, to: pos + node.nodeSize, mark, text: node.text ?? '' })
  })
  return hits
}

/**
 * Removes `commentId`'s own `comment_anchor` mark from wherever it sits in
 * the live document — a run that's nothing but the zero-width-space
 * placeholder `insertCommentAnchorMark` invents for an empty selection is
 * deleted outright (nothing real to keep); a run of genuine highlighted
 * text is just unmarked, keeping the text itself exactly as `unwrapCommentMark`
 * (essaysRepo.ts) already does for the old model. Used both to cancel an
 * in-progress (not-yet-submitted) comment composer and, from
 * `essayCommentActions.ts`, to clean up a deleted top-level comment's own
 * anchor. `placeCursorAfter` — used by "promote" — leaves the selection
 * collapsed right where the (possibly now-shorter) anchor used to end, so
 * a follow-up `insertHtmlAtSelection` call lands in exactly the right spot.
 */
export function removeCommentAnchorMark(view: EditorView, commentId: string, opts: { placeCursorAfter?: boolean } = {}): void {
  const hits = findCommentAnchorHits(view.state.doc, commentId)
  if (!hits.length) return
  let tr = view.state.tr
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]
    if (/^​+$/.test(h.text)) tr = tr.delete(h.from, h.to)
    else tr = tr.removeMark(h.from, h.to, h.mark)
  }
  if (opts.placeCursorAfter) {
    const mapped = tr.mapping.map(hits[hits.length - 1].to)
    tr = tr.setSelection(TextSelection.create(tr.doc, mapped))
  }
  view.dispatch(tr)
}

/** The end position of `commentId`'s own `comment_anchor` mark — the last point it reaches, if it spans more than one text run — or `null` if it isn't anchored anywhere in the main document at all (an `'inline'`-anchorKind comment, whose anchor lives inside another comment's own `body` HTML instead — see `Comment`'s own doc comment). Exported for `pmCommentPlugin.ts`'s own inline-preview widget placement. */
export function commentAnchorEndPos(doc: PMNode, commentId: string): number | null {
  const hits = findCommentAnchorHits(doc, commentId)
  if (!hits.length) return null
  return Math.max(...hits.map((h) => h.to))
}

/** Parses `html` (a comment's own rich-text `body`) through the schema's own `parseDOM` rules and inserts it at the current selection — the PM-native inverse of `sliceToHtml` above, used only by "promote," which needs to turn a comment's body back into ordinary document content. */
export function insertHtmlAtSelection(view: EditorView, html: string): void {
  const dom = document.createElement('div')
  dom.innerHTML = html
  const slice = PMDOMParser.fromSchema(essaySchema).parseSlice(dom, { preserveWhitespace: true })
  view.dispatch(view.state.tr.replaceSelection(slice))
}
