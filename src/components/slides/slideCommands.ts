import type { EditorView } from 'prosemirror-view'
import { TextSelection } from 'prosemirror-state'
import { Fragment } from 'prosemirror-model'
import type { ResolvedPos } from 'prosemirror-model'
import { slideSchema } from '../../lib/slideSchema'
import { pageNote } from '../../lib/bibtex'
import { id } from '../../lib/id'
import type { Source } from '../../models/types'

function resolveNote(source: Source, opts: { note?: string; page?: number }): string | null {
  const note = opts.note?.trim() || pageNote(source, opts.page)
  return note || null
}

/** Same shape as `pmCommands.ts`'s own `insertCitation` — see its doc comment. */
export function insertCitation(view: EditorView, source: Source, note?: string): void {
  const { state } = view
  const citationNode = slideSchema.nodes.citation.create({ sourceId: source.id, note: resolveNote(source, { note }) })
  const tr = state.tr.replaceSelectionWith(citationNode, false)
  tr.insertText(' ')
  view.dispatch(tr)
  view.focus()
}

/** Same shape as `pmCommands.ts`'s own `insertQuoteBlock`. */
export function insertQuoteBlock(view: EditorView, source: Source, quoteText: string, page: number): void {
  const { state } = view
  const quoteNode = slideSchema.nodes.blockquote.create(null, slideSchema.nodes.paragraph.create(null, slideSchema.text(quoteText)))
  const citationNode = slideSchema.nodes.citation.create({ sourceId: source.id, note: resolveNote(source, { page }) })
  const citationPara = slideSchema.nodes.paragraph.create(null, citationNode)
  const tr = state.tr.replaceSelectionWith(quoteNode, false)
  tr.insert(tr.selection.to, citationPara)
  view.dispatch(tr)
  view.focus()
}

/** Same shape as `pmCommands.ts`'s own `insertQuoteInline`. */
export function insertQuoteInline(view: EditorView, source: Source, quoteText: string, page: number): void {
  const { state } = view
  const mark = slideSchema.marks.quote_inline.create({ sourceId: source.id, page })
  const citationNode = slideSchema.nodes.citation.create({ sourceId: source.id, note: resolveNote(source, { page }) })
  const tr = state.tr.insertText(`“${quoteText}”`)
  tr.addMark(tr.selection.to - quoteText.length - 2, tr.selection.to, mark)
  tr.insertText(' ')
  tr.replaceSelectionWith(citationNode, false)
  tr.insertText(' ')
  view.dispatch(tr)
  view.focus()
}

/** The depth of the nearest enclosing `section` around `$pos`, or `0` (the document itself) if it isn't inside any — shared by `insertDivider` (lands as a direct child of this container, not nested any deeper) and anything else that needs "which block actually owns this position" without caring about plain non-section wrappers like a list or blockquote in between. */
function nearestSectionOrDocDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth; d >= 0; d--) {
    if (d === 0 || $pos.node(d).type.name === 'section') return d
  }
  return 0
}

/**
 * Inserts a divider node (`slide_break`/`fragment_break`) — both commands
 * below go through this. Always lands right after the current top-level
 * block *of its own enclosing section* (or the document itself, if not
 * inside any section), never mid-paragraph and never nested any deeper:
 *
 * - `slideSerializer.ts` reads a slide's own title/eyebrow from whichever
 *   `section`(s) actually enclose its `slide_break` — nested inside a
 *   list or blockquote wouldn't change that, but nested *past* a section
 *   boundary (lifted all the way out to the document) would silently
 *   change which slide's title it is. Landing a divider as a direct child
 *   of its nearest enclosing section (not lifted past it, but also not
 *   left nested a level or two deeper inside a list/blockquote the cursor
 *   happened to be in — easy to end up inside otherwise, e.g. pressing
 *   Enter inside a bullet list, then immediately asking for a slide
 *   change) keeps both of those intact.
 * - A content-less atom's own post-insert selection isn't safe to depend
 *   on either way — `replaceSelectionWith`'s own choice of where the
 *   selection lands next can end up a `NodeSelection` *on* the atom just
 *   inserted rather than a `TextSelection` after it (confirmed live:
 *   typing a new slide's title right after clicking "Slide" was silently
 *   replacing the divider itself with the first character typed). Always
 *   following the break with a real, explicit empty paragraph of our own
 *   — only when one doesn't already immediately follow — and placing the
 *   selection inside *that* sidesteps the question entirely: it's always
 *   a plain `TextSelection`, ready to type straight into, every time.
 */
function insertDivider(view: EditorView, breakNode: ReturnType<typeof slideSchema.nodes.slide_break.create>): void {
  const { state } = view
  const containerDepth = nearestSectionOrDocDepth(state.selection.$from)
  const pos = state.selection.$from.after(containerDepth + 1)
  const tr = state.tr.insert(pos, breakNode)
  const afterBreak = pos + breakNode.nodeSize
  const followingNode = tr.doc.nodeAt(afterBreak)
  if (!followingNode || !followingNode.isTextblock) {
    tr.insert(afterBreak, slideSchema.nodes.paragraph.create())
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterBreak + 1), 1))
  view.dispatch(tr)
  view.focus()
}

/** "Slide change" — the editor-toolbar/keyboard-shortcut counterpart to typing plain prose. See `insertDivider`'s own doc comment for exactly where it lands. */
export function insertSlideBreak(view: EditorView, layout: 'section' | 'content' = 'content'): void {
  insertDivider(view, slideSchema.nodes.slide_break.create({ id: id(), layout }))
}

/** "Fragmented reveal": everything from here to the next divider (of either kind) becomes the next reveal step when presenting (see `slideSerializer.ts`). See `insertDivider`'s own doc comment for exactly where it lands. */
export function insertFragmentBreak(view: EditorView): void {
  insertDivider(view, slideSchema.nodes.fragment_break.create({ id: id() }))
}

export function setSlideBreakLayout(view: EditorView, pos: number, layout: string): void {
  const { state } = view
  const node = state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'slide_break') return
  view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, layout }))
  // The `<select>` itself just took real DOM focus (a native form control,
  // not part of ProseMirror's own contentEditable surface) — without this,
  // the very next keystroke goes to whatever focus the browser leaves
  // sitting on that dropdown instead of back into the document.
  view.focus()
}

/** Deletes the divider at `pos` outright — since neither divider has any content of its own, this is already the entire "merge this slide into the previous one" / "drop this fragment boundary" operation; nothing else needs to happen. */
export function deleteBreak(view: EditorView, pos: number): void {
  const { state } = view
  const node = state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(state.tr.delete(pos, pos + node.nodeSize))
}

/**
 * "New section": promotes the current selection into a new child
 * `section` right at that position — same shape and same requirement
 * (a non-empty selection whose own block range sits directly inside
 * either another `section` or, here, the document itself) as
 * `pmCommands.ts`'s own `splitIntoSection`, generalized to also allow a
 * brand-new *top-level* section (an essay only ever has the one single
 * root section everything already lives inside; a deck's own `doc` allows
 * any number of top-level sections side by side — see `slideSchema.ts`'s
 * own doc comment).
 */
export function insertSection(view: EditorView): boolean {
  const { state } = view
  const { $from, $to, empty } = state.selection
  if (empty) return false
  const range = $from.blockRange($to)
  if (!range || (range.parent.type.name !== 'section' && range.parent.type.name !== 'doc')) return false
  const slice = state.doc.slice(range.start, range.end)
  const titleNode = slideSchema.nodes.section_title.create()
  const content = Fragment.from(titleNode).append(slice.content)
  const newSection = slideSchema.nodes.section.create({ id: id() }, content)
  const tr = state.tr.replaceWith(range.start, range.end, newSection)
  view.dispatch(tr)
  view.focus()
  return true
}
