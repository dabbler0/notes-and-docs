import { Fragment, Slice, DOMSerializer, DOMParser as PMDOMParser } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import type { Node as PMNode, Mark, ResolvedPos } from 'prosemirror-model'
import { essaySchema } from '../../lib/pmSchema'
import { pageNote } from '../../lib/bibtex'
import { id } from '../../lib/id'
import type { Comment, Source } from '../../models/types'

/** Walks up from `$pos` to the nearest enclosing `section` — shared by "Send to graveyard" (`sendSelectionToGraveyard`, EssayWorkspace.tsx), comment-anchor insertion below, and the Word Count dialog's own "this section" row, each of which needs "which section does this position belong to" as a best-effort reference (`id`/`title`; never dereferenced structurally — a section can be renamed/moved/deleted without anything here needing to follow it) or, for word count specifically, the actual live `node` to pull text out of. */
export function findEnclosingSection($pos: ResolvedPos): { id: string; title: string; node: PMNode } | null {
  for (let d = $pos.depth; d >= 0; d--) {
    const node = $pos.node(d)
    if (node.type.name === 'section') {
      return { id: node.attrs.id, title: node.firstChild?.textContent || 'Untitled section', node }
    }
  }
  return null
}

/**
 * Guards against a real, confirmed-live ProseMirror default-behavior bug:
 * pressing Backspace with the cursor at the very start of a section's own
 * first body block normally falls through to `prosemirror-commands`' own
 * default `joinBackward`, which treats the section's own title (`section_
 * title`, right before that first block) and the block itself as two
 * ordinary adjacent textblocks eligible to merge — both satisfy PM's own
 * `isTextblock`/`textblockAt` checks, nothing in the schema says a title
 * and a body paragraph shouldn't merge the way two paragraphs would. The
 * observed result: the block's own text got pulled into the section's
 * title (invisible for the essay's own root section — its title is
 * hidden, `styles.css`'s own `.pm-editor-root .ProseMirror > section >
 * .section-body > h2.section-title`) and the block itself disappeared,
 * reading as "my first paragraph just vanished."
 *
 * A section's own title is a distinct field, not "the block before this
 * one" the way two ordinary paragraphs are — Backspace reaching exactly
 * this boundary should do nothing. Bound ahead of `keymap(baseKeymap)`'s
 * own default Backspace chain (`PMEssayEditor.tsx`), so only this one
 * specific boundary is intercepted; every other Backspace (including the
 * common "merge this paragraph into the previous one" case) falls through
 * to the normal behavior completely unchanged.
 *
 * Mirrors just the piece of `prosemirror-commands`' own (unexported)
 * `findCutBefore` needed here: walk up from the cursor to the first
 * ancestor depth where it isn't its parent's first child, and look at the
 * sibling immediately before that point.
 */
export function preventJoinIntoSectionTitle(state: EditorState): boolean {
  const { selection } = state
  if (!(selection instanceof TextSelection) || !selection.empty) return false
  const $cursor = selection.$cursor
  if (!$cursor || $cursor.parentOffset > 0) return false
  for (let d = $cursor.depth; d >= 1; d--) {
    if ($cursor.node(d - 1).type.spec.isolating) return false
    if ($cursor.index(d - 1) > 0) {
      const before = $cursor.doc.resolve($cursor.before(d)).nodeBefore
      return !!before && before.type.name === 'section_title'
    }
  }
  return false
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
 *
 * With nothing selected, there's no existing content to promote — instead
 * this inserts a brand-new, empty subsection right at the cursor (see
 * `insertEmptySection`, below), the same "new (sub*)section" gesture with
 * nothing to carry over into it yet.
 */
export function splitIntoSection(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const { $from, $to, empty } = state.selection
  if (empty) return insertEmptySection(state, dispatch)
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
 * Inserts a brand-new, empty `section` (empty title, one empty paragraph
 * body) as a child of whichever section the cursor is currently in — right
 * after the current top-level block of that section, same landing spot
 * `insertDivider` (below) uses for a `slide_break`/`fragment_break`, and
 * for the same reason: a direct child of the *nearest enclosing* section,
 * never nested any deeper inside a list/blockquote the cursor happened to
 * be in. The selection lands inside the new section's own (empty) title,
 * ready to type a name for it immediately — mirroring `splitIntoSection`'s
 * own "promote this selection" case, where the title is similarly left
 * empty for the user to fill in right after.
 */
function insertEmptySection(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  const $from = state.selection.$from
  const containerDepth = nearestSectionDepth($from)
  const pos = $from.after(containerDepth + 1)
  if (dispatch) {
    const titleNode = essaySchema.nodes.section_title.create()
    const body = essaySchema.nodes.paragraph.create()
    const newSection = essaySchema.nodes.section.create({ id: id() }, Fragment.from(titleNode).append(Fragment.from(body)))
    const tr = state.tr.insert(pos, newSection)
    // Inside the section (+1) and inside its own (empty) title (+1) — ready to type a name for it right away.
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2), 1))
    dispatch(tr)
  }
  return true
}

/**
 * "Demote": the inverse of `splitIntoSection` — folds a section back into
 * its own parent, splicing its content (everything but its own
 * `section_title`, which is simply discarded — same as the old app's own
 * `demoteChild`, which only ever ported a child's `draftContent` up,
 * never its title) directly in at the position the section itself used
 * to occupy. Grandchildren (nested sections) travel along for free, since
 * they're just more content inside what gets spliced in.
 *
 * Driven by a known section position rather than the current selection —
 * `pmNodeViews.ts`'s own `SectionView` has its own `getPos()` already,
 * and its demote button (sitting in that section's own header, not the
 * toolbar) has to work regardless of whether the cursor is anywhere near
 * it. `pos` is the section's own start position (`getPos()`'s own
 * convention, same as every other NodeView-dispatched command in this
 * file) — resolving just inside it (`pos + 1`) lands at this section's
 * own nesting depth.
 */
export function demoteSectionAt(view: EditorView, pos: number): boolean {
  const $pos = view.state.doc.resolve(pos + 1)
  const sectionDepth = $pos.depth
  // Depth 1 is the document's own single root section — nothing to demote into.
  if (sectionDepth <= 1) return false
  const sectionNode = $pos.node(sectionDepth)
  const start = $pos.before(sectionDepth)
  const end = $pos.after(sectionDepth)
  const content = sectionNode.content.cut(sectionNode.firstChild!.nodeSize)
  view.dispatch(view.state.tr.replaceWith(start, end, content))
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

/** Finds a section node's own `{ pos, node }` by its stable id — `pos` is the position right before the section's own opening tag, same convention `getPos()` uses. Shared by `moveSectionTo`, below; `toggleSectionCollapsed`, above, inlines the same walk since it only ever needs the one hit. */
function findSectionById(doc: PMNode, sectionId: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'section' && node.attrs.id === sectionId) {
      found = { pos, node }
      return false
    }
    return true
  })
  return found
}

export type SectionDropZone = 'before' | 'after' | 'into'

/**
 * Drag-and-drop section reordering — `NodeTree.tsx`'s own outline sidebar.
 * Moves the whole `draggedId` section (its own title and all its content,
 * nested subsections included) to a new position relative to `targetId`:
 * `'before'`/`'after'` land it as target's own sibling, at *target's own*
 * nesting depth — so dropping onto the gap above/below a shallower or
 * deeper section re-parents the dragged one too, not just reorders it
 * among whatever siblings it already had, the usual drag-tree convention;
 * `'into'` lands it as target's own last child, one level deeper.
 *
 * Refuses (returns `false`, no transaction) three cases that would
 * otherwise corrupt the document or do nothing useful: dragging the
 * essay's own root section (`pos === 0` — nothing to reorder it relative
 * to, it's the whole essay), dropping a section onto itself, or dropping a
 * section into its own descendant (would create a cycle the schema has no
 * way to represent).
 *
 * Implemented as a plain cut-and-reinsert: delete the dragged section's
 * own range first, then insert its own (unchanged — same id, same
 * content, nothing remapped) node at `target`'s own insertion point,
 * mapped through the delete step's own position shift — standard
 * ProseMirror idiom for "move a node," same shape `demoteSectionAt`'s own
 * `replaceWith` uses for a different kind of section move.
 */
export function moveSectionTo(view: EditorView, draggedId: string, targetId: string, zone: SectionDropZone): boolean {
  const { state } = view
  const dragged = findSectionById(state.doc, draggedId)
  const target = findSectionById(state.doc, targetId)
  if (!dragged || !target) return false
  if (dragged.pos === 0) return false
  const draggedEnd = dragged.pos + dragged.node.nodeSize
  if (target.pos === dragged.pos) return false
  if (target.pos > dragged.pos && target.pos < draggedEnd) return false

  let insertPos: number
  if (zone === 'before') insertPos = target.pos
  else if (zone === 'after') insertPos = target.pos + target.node.nodeSize
  else insertPos = target.pos + target.node.nodeSize - 1 // just inside target's own closing tag — becomes its new last child

  let tr = state.tr.delete(dragged.pos, draggedEnd)
  insertPos = tr.mapping.map(insertPos)
  tr = tr.insert(insertPos, dragged.node)
  view.dispatch(tr)
  view.focus()
  return true
}

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6'])

/** Parses a run of plain DOM child nodes (never containing a heading — every caller below only ever hands this the content strictly *between* two headings, or before the first one) into a PM `Fragment` via a flexible, not-top-node-constrained parse — same `parseSlice` technique `insertHtmlAtSelection`, above, already uses for the same reason: `essaySchema`'s own `doc` node requires exactly one `section` at the top level, which a plain parse (`DOMParser.parse`) would enforce and a bare run of paragraphs can't satisfy. */
function parseHtmlFragmentToPmFragment(nodes: ChildNode[]): Fragment {
  if (nodes.length === 0) return Fragment.empty
  const wrapper = document.createElement('div')
  for (const n of nodes) wrapper.appendChild(n.cloneNode(true))
  return PMDOMParser.fromSchema(essaySchema).parseSlice(wrapper, { preserveWhitespace: true }).content
}

/**
 * Pasting plain HTML from *outside* this app whose own headings
 * (`<h1>`–`<h6>`) were never wrapped in a real `<section>` — unlike
 * pasting a copy of this app's own content, where every heading already
 * sits inside a real `<section data-section-id>` (the ordinary default
 * paste path handles that fine; `dedupeSectionIds`/`pmSectionIdPlugin.ts`
 * cover any id collision it might carry) — hits a real, confirmed-live
 * ProseMirror parsing quirk: a bare `<h2>` with no enclosing `<section>`
 * still matches `section_title`'s own `parseDOM` (`pmSchema.ts`), but
 * `section_title` only has meaning *inside* a `section`'s own content
 * model, so ProseMirror's default parser auto-wraps it in a
 * freshly-synthesized `section` node of its own (`findWrapping`, its
 * usual "what ancestor would make this orphan fit" fallback) — with no
 * real DOM element behind that synthesized wrapper for `section`'s own
 * `getAttrs` to read an id from, so it's born with `id: null`
 * (`dedupeSectionIds` also treats that as needing a fresh one, but by
 * then the *structure* is already wrong). Worse, once auto-created, that
 * synthesized section stays the parser's own current insertion context
 * for everything parsed after it, so a *second* bare heading right after
 * the first gets wrapped *inside* the first section instead of becoming
 * its own sibling — confirmed live: pasting several flat, same-level
 * `<h2>`s produced an ever-deepening nest of subsections, not the flat
 * sequence the source HTML actually had.
 *
 * Bypasses that default parsing for exactly this case: splits the pasted
 * HTML on every heading — deliberately flat regardless of heading level
 * (h1 vs. h2 vs. h3), matching the source's own flat structure rather
 * than guessing a nesting depth from it — and builds one real `section`
 * node per heading by hand, each with its own freshly-minted id
 * (`lib/id.ts`, same as every other section-creating command in this
 * file) and the heading's own text as its title; everything up to the
 * next heading becomes that section's body. Plain content before the
 * first heading (if any) is inserted as-is, un-wrapped.
 *
 * Returns `false` — meaning "did nothing, handled the content the
 * default way" — when the pasted HTML has no heading tag outside of a
 * real `<section>` at all, which covers both plain prose paste and a
 * copy of this app's own content unchanged; the caller (`handlePaste`,
 * `PMEssayEditor.tsx`) falls back to ProseMirror's own default paste
 * handling in that case.
 */
export function pasteFlatSectionsFromHtml(view: EditorView, html: string): boolean {
  const container = document.createElement('div')
  container.innerHTML = html
  const isOrphanHeading = (n: ChildNode): n is HTMLElement => n.nodeType === 1 && HEADING_TAGS.has((n as HTMLElement).tagName) && !(n as HTMLElement).closest('section')
  const children = Array.from(container.childNodes)
  if (!children.some(isOrphanHeading)) return false

  const topNodes: PMNode[] = []
  let i = 0
  const preNodes: ChildNode[] = []
  while (i < children.length && !isOrphanHeading(children[i])) {
    preNodes.push(children[i])
    i++
  }
  parseHtmlFragmentToPmFragment(preNodes).forEach((n) => topNodes.push(n))

  while (i < children.length) {
    const headingEl = children[i] as HTMLElement
    const title = headingEl.textContent?.trim() ?? ''
    i++
    const bodyNodes: ChildNode[] = []
    while (i < children.length && !isOrphanHeading(children[i])) {
      bodyNodes.push(children[i])
      i++
    }
    let bodyContent = parseHtmlFragmentToPmFragment(bodyNodes)
    if (bodyContent.childCount === 0) bodyContent = Fragment.from(essaySchema.nodes.paragraph.create())
    const titleNode = essaySchema.nodes.section_title.create(null, title ? essaySchema.text(title) : undefined)
    topNodes.push(essaySchema.nodes.section.create({ id: id() }, Fragment.from(titleNode).append(bodyContent)))
  }

  if (topNodes.length === 0) return false
  // Plain `delete` (only when there's an actual selection to replace) +
  // sequential `insert` at a clean block-boundary position, not
  // `replaceSelection`/`replaceRange` — confirmed live: handing a
  // multi-top-level-node `Slice` to `replaceSelection` crashed with a
  // stack overflow, the same `ContentMatch` fragility noted elsewhere in
  // this codebase (`promoteSectionAt`'s own doc comment); `replaceRange`'s
  // own boundary-fitting heuristics (deciding how much of the surrounding
  // structure to absorb into the replacement) exercise that same
  // machinery. The insertion point itself is "after the current top-level
  // block of the nearest enclosing section" — same landing spot
  // `insertDivider`'s own doc comment explains, and for the same reason:
  // a raw cursor position can sit *inside* an existing paragraph's own
  // inline content, which isn't a valid place to insert a block-level
  // `section`/`paragraph` sibling at all (confirmed live: using the raw,
  // unmapped selection position here threw an out-of-range position
  // error on the second insert, once the first had already shifted
  // everything after it).
  const { state } = view
  let tr = state.tr
  if (!state.selection.empty) tr = tr.delete(state.selection.from, state.selection.to)
  const $from = tr.doc.resolve(tr.mapping.map(state.selection.from))
  const containerDepth = nearestSectionDepth($from)
  const pos = $from.after(containerDepth + 1)
  // Insert a throwaway placeholder paragraph first (a plain, content-less
  // insert — safe, same as every divider/section-creating command
  // elsewhere in this file), then immediately `replaceWith` that exact
  // range with the real content — `splitIntoSection`'s own
  // proven-reliable technique for landing a brand-new `section` node,
  // rather than a bare `tr.insert(pos, content)` of one directly:
  // confirmed live, inserting a `section` node that way at this kind of
  // position (right after an existing non-empty paragraph) crashed with a
  // stack overflow inside ProseMirror's own `ContentMatch.fillBefore`/
  // `createAndFill` — a real fragility in how this schema's
  // self-referential `block` group (`section` can contain more
  // `section`s) interacts with a plain zero-length insert's own
  // content-fitting search; replacing a *real*, non-empty range doesn't
  // hit it.
  const placeholder = essaySchema.nodes.paragraph.create()
  tr = tr.insert(pos, placeholder)
  tr = tr.replaceWith(pos, pos + placeholder.nodeSize, Fragment.from(topNodes))
  view.dispatch(tr)
  view.focus()
  return true
}

/**
 * Reassigns a fresh id to every `section` beyond the first (document
 * order, pre-order — same traversal `findSectionById`/`doc.descendants`
 * already use) that shares an id with an earlier one — the section's own
 * content/title/nesting is left completely untouched, only `attrs.id`
 * ever changes. Returns `doc` itself, unchanged (`===`), when nothing was
 * duplicated — the overwhelmingly common case — so callers can cheaply
 * tell whether anything needed fixing without a separate equality check.
 *
 * Treats a missing id (`null`/empty — `!currentId`) exactly like a
 * collision: also confirmed live, pasting plain HTML from *outside* this
 * app whose own headings were never wrapped in a real `<section>` at all
 * (`pasteFlatSectionsFromHtml`'s own doc comment covers the main fix for
 * that path) can still reach here with `id: null` by some other route —
 * nothing downstream can treat a `null` id as "this section's own
 * identity" any more than it could treat a duplicate one that way, so
 * both get a fresh one here, uniformly.
 *
 * Exists because of a real, confirmed-live corruption path: pasting any
 * content that includes a `section` carries its own `data-section-id`
 * straight through ProseMirror's default paste parsing (`pmSchema.ts`'s
 * own `section.parseDOM`) — nothing mints a fresh one — so pasting a copy
 * of existing content (even from later in the very same document)
 * duplicates its section ids exactly. Since `id` is how
 * `findSectionById`/`toggleSectionCollapsed` above, `NodeTree.tsx`'s own
 * drag-and-drop target lookup, and `SectionView`'s own
 * `dom.dataset.sectionId` all identify "which section is this," a
 * collision makes every one of them treat two (or more) different
 * sections as if they were the same one — confirmed live as "this
 * section won't drag" (`moveSectionTo`'s own id lookup silently resolves
 * to the *other*, earlier section sharing that id) and "every section
 * sharing this id highlights as the drop target at once."
 *
 * Used two ways (`PMEssayEditor.tsx`): once, directly, against a record's
 * own `doc` right after parsing it — repairs an *already* corrupted essay
 * the moment it's opened, not just from here on — and continuously, via
 * `pmSectionIdPlugin.ts`'s `appendTransaction` plugin, which calls this
 * after every doc-changing transaction so a *future* paste (or any other
 * way a duplicate might sneak in) gets caught and fixed immediately,
 * folded into the same state update the user sees — never a visible,
 * separate follow-up edit.
 */
export function dedupeSectionIds(doc: PMNode): PMNode {
  const seen = new Set<string>()
  let changed = false
  function fix(node: PMNode): PMNode {
    let attrs = node.attrs
    let selfChanged = false
    if (node.type.name === 'section') {
      const currentId = node.attrs.id as string | null
      if (!currentId || seen.has(currentId)) {
        attrs = { ...node.attrs, id: id() }
        selfChanged = true
        changed = true
        seen.add(attrs.id as string)
      } else {
        seen.add(currentId)
      }
    }
    let content = node.content
    let contentChanged = false
    const mapped: PMNode[] = []
    node.forEach((child) => {
      const next = fix(child)
      if (next !== child) contentChanged = true
      mapped.push(next)
    })
    if (contentChanged) content = Fragment.from(mapped)
    if (selfChanged) return node.type.create(attrs, content, node.marks)
    if (contentChanged) return node.copy(content)
    return node
  }
  const fixed = fix(doc)
  return changed ? fixed : doc
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

/** The zero-width space `insertInlineCommentBody`/`insertCommentAnchorMark` use as a placeholder for an otherwise-empty marked range — same character, same reason (see `insertCommentAnchorMark`'s own doc comment): a mark can't apply to a genuinely zero-length range, and a real cursor needs *something* to land on. */
const ZERO_WIDTH_SPACE = '​'

/** Every `(from, to, mark, text)` hit for `commentId`'s own `comment_text` mark — the body-text counterpart to `findCommentAnchorHits`, above, same reasoning (a mark can span more than one adjacent text run). */
function findCommentTextHits(doc: PMNode, commentId: string): { from: number; to: number; mark: Mark; text: string }[] {
  const hits: { from: number; to: number; mark: Mark; text: string }[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const mark = node.marks.find((m) => m.type.name === 'comment_text' && m.attrs.commentId === commentId)
    if (mark) hits.push({ from: pos, to: pos + node.nodeSize, mark, text: node.text ?? '' })
  })
  return hits
}

/** The full `{from, to}` span of `commentId`'s own `comment_text` mark in the live document — spanning every text run it touches — or `null` if it isn't anchored anywhere (no inline body has ever been created for this comment, or it's since been extracted to the margin). Exported for `pmCommentPlugin.ts`'s own action-widget placement and for `CommentsPanel.tsx`'s margin-positioning fallback. */
export function commentTextRange(doc: PMNode, commentId: string): { from: number; to: number } | null {
  const hits = findCommentTextHits(doc, commentId)
  if (!hits.length) return null
  return { from: Math.min(...hits.map((h) => h.from)), to: Math.max(...hits.map((h) => h.to)) }
}

/**
 * Inserts a `comment_text`-marked placeholder at `pos` (right after a
 * freshly-created inline comment's own anchor — see `EssayWorkspace.tsx`'s
 * `beginComment`) and places the cursor right inside it, ready to type
 * immediately: the whole point of this feature — a comment's own body is
 * real, directly-editable document content, not a separate popup. Seeded
 * with one zero-width space for the same reason `insertCommentAnchorMark`'s
 * own empty-selection case is: a mark can't apply to nothing, and an
 * inline, non-textblock position needs *some* character there for the
 * browser to actually land a cursor on. `comment_text`'s own `toDOM`
 * carries no `inclusive: false` (`pmSchema.ts`), so typing right after this
 * placeholder naturally keeps extending the mark, the same way it would for
 * bold/italic.
 */
export function insertInlineCommentBody(view: EditorView, commentId: string, pos: number): void {
  // A plain `insertText` here would be wrong: `Transaction.insertText`
  // (`prosemirror-state`) inherits whatever marks are active right at
  // `pos` for the new text — which, landing right after the anchor's own
  // inclusive `comment_anchor` mark, confirmed live meant the placeholder
  // came out carrying *both* marks, nesting `comment-text` inside
  // `comment-anchor` in the rendered DOM. Building the text node directly
  // with exactly the one mark we want sidesteps that inheritance
  // entirely.
  const mark = essaySchema.marks.comment_text.create({ commentId })
  const textNode = essaySchema.text(ZERO_WIDTH_SPACE, [mark])
  const tr = view.state.tr.insert(pos, textNode)
  tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  view.dispatch(tr)
  view.focus()
}

/**
 * Removes `commentId`'s own `comment_text` mark from wherever it sits in
 * the live document, deleting the range outright — used when a comment is
 * deleted (its own body has nothing left to keep) or extracted to the
 * margin (`extractInlineCommentBody`, below, which needs the HTML *before*
 * deleting — this function alone is for the simpler "just discard it"
 * case). A no-op if the comment has no live `comment_text` span at all
 * (e.g. it's a margin comment, or was already extracted).
 */
export function deleteInlineCommentBody(view: EditorView, commentId: string): void {
  const range = commentTextRange(view.state.doc, commentId)
  if (!range) return
  view.dispatch(view.state.tr.delete(range.from, range.to))
}

/**
 * Strips `commentId`'s own `comment_text` mark, keeping the text itself in
 * place as ordinary prose — the "promote" counterpart to
 * `deleteInlineCommentBody`'s "discard": used when an inline comment is
 * dissolved into permanent prose (`essayCommentActions.ts`'s
 * `promoteEssayComment`), where the whole point is that the typed text
 * *stays*, just without the mark (and the comment record itself) any more.
 * A run that's nothing but the zero-width-space placeholder (never actually
 * typed into) is deleted outright instead, same as
 * `removeCommentAnchorMark` already does for an anchor in the same state.
 */
export function removeCommentTextMark(view: EditorView, commentId: string): void {
  const hits = findCommentTextHits(view.state.doc, commentId)
  if (!hits.length) return
  let tr = view.state.tr
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]
    if (new RegExp(`^${ZERO_WIDTH_SPACE}+$`).test(h.text)) {
      tr = tr.delete(h.from, h.to)
      continue
    }
    // A hit with *some* real typed content can still carry
    // `insertInlineCommentBody`'s own leading placeholder character —
    // stripping the mark alone would leave that invisible character
    // baked into the now-permanent prose. `removeMark` first (it never
    // shifts positions, so `h`'s own coordinates stay valid for the
    // `delete` right after — safe within one hit precisely because hits
    // are processed in reverse, so no *other* hit's positions have
    // shifted yet either).
    tr = tr.removeMark(h.from, h.to, h.mark)
    const leading = h.text.match(new RegExp(`^${ZERO_WIDTH_SPACE}+`))?.[0].length ?? 0
    if (leading > 0) tr = tr.delete(h.from, h.from + leading)
  }
  view.dispatch(tr)
}

/**
 * Removes `commentId`'s own `comment_text` range from the live document
 * (like `deleteInlineCommentBody`) but first serializes it to HTML
 * (`sliceToHtml`, above) and returns that — "extract to margin"
 * (`essayCommentActions.ts`'s `convertEssayCommentDisplayMode`), which
 * needs the comment's own typed content to become its `Comment.body`
 * *before* removing it from the document. Strips the leading placeholder
 * zero-width space (never real content) out of the returned HTML — a
 * comment extracted before its author ever typed anything returns `''`.
 * Returns `''` with no document change at all if the comment has no live
 * `comment_text` span (already extracted, or never an inline comment to
 * begin with).
 */
export function extractInlineCommentBody(view: EditorView, commentId: string): string {
  const range = commentTextRange(view.state.doc, commentId)
  if (!range) return ''
  const slice = view.state.doc.slice(range.from, range.to)
  const html = sliceToHtml(slice).replace(new RegExp(ZERO_WIDTH_SPACE, 'g'), '')
  view.dispatch(view.state.tr.delete(range.from, range.to))
  return html
}

/**
 * The inverse of `extractInlineCommentBody` — "send to inline"
 * (`convertEssayCommentDisplayMode`'s other direction): parses `html` (a
 * margin comment's own stored `body`) wrapped in a synthetic
 * `<comment-text data-comment-id>` tag, so `comment_text`'s own `parseDOM`
 * rule (`pmSchema.ts`) applies the mark to every bit of it during parsing —
 * the same "wrap first, let `parseDOM` do the work" technique
 * `pasteFlatSectionsFromHtml` already relies on — and inserts the result at
 * `pos` (right after the comment's own anchor). An empty/whitespace-only
 * `html` (a margin comment nobody ever wrote anything into) falls back to
 * `insertInlineCommentBody`'s own placeholder instead of inserting nothing
 * — there still needs to be *something* marked for the comment to remain
 * anchored to, and for its author to be able to click into and start typing.
 */
export function insertInlineCommentBodyFromHtml(view: EditorView, commentId: string, pos: number, html: string): void {
  if (!html.trim()) {
    insertInlineCommentBody(view, commentId, pos)
    return
  }
  const dom = document.createElement('div')
  dom.innerHTML = `<comment-text data-comment-id="${commentId}">${html}</comment-text>`
  const slice = PMDOMParser.fromSchema(essaySchema).parseSlice(dom, { preserveWhitespace: true })
  view.dispatch(view.state.tr.insert(pos, slice.content))
}

/**
 * Repairs a real, confirmed-live gap left by the move to live, in-document
 * inline comments: every inline top-level comment created *before* that
 * feature shipped has its own body sitting inertly in `Comment.body` HTML,
 * with no `comment_text` span ever inserted for it (nothing ever did that
 * migration) — and the current rendering has nothing left that falls back
 * to showing a comment's `body` directly any more (the old static preview
 * chip this replaced is gone; `pmCommentPlugin.ts` only ever decorates a
 * *live* `comment_text` range, and `CommentsPanel.tsx`'s own margin-row
 * filter deliberately skips a reply-less inline comment, trusting its body
 * to already be live in the document). The net effect, confirmed live: the
 * comment's own `comment_anchor` span still renders fine (that part was
 * never affected), but the comment's own written content is reachable
 * nowhere at all — not in the document, not in the margin.
 *
 * Run once, moments after a record is opened (`PMEssayEditor.tsx`'s mount
 * effect, alongside `dedupeSectionIds`' own repair-on-open), the same
 * "fix whatever's already wrong, going forward nothing can introduce this
 * again" shape that fix already established: for every top-level,
 * `'inline'`-displayed `'text'` comment with a real `body` but no live
 * `comment_text` range yet, this inserts one (same technique
 * `insertInlineCommentBodyFromHtml` uses, just operating on a plain `Node`
 * rather than a live `view` — nothing here needs an `EditorView` to exist
 * yet) right after the comment's own anchor, and clears the now-redundant
 * `Comment.body` to `''` to match every comment created after the live-
 * inline-comment feature shipped. No-op, returning the same `doc`/`comments`
 * references unchanged, for an essay with nothing to repair — the
 * overwhelming majority, once this has run once per affected essay.
 */
export function repairMissingInlineCommentBodies(doc: PMNode, comments: Comment[]): { doc: PMNode; comments: Comment[]; changed: boolean } {
  let currentDoc = doc
  let changed = false
  const repairedComments = comments.map((c) => {
    if (c.parentId !== null || c.anchorKind !== 'text' || c.displayMode !== 'inline') return c
    if (!c.body || !c.body.trim()) return c
    if (commentTextRange(currentDoc, c.id)) return c // already migrated
    const pos = commentAnchorEndPos(currentDoc, c.id)
    if (pos == null) return c // no anchor either — nothing to anchor a repaired span to
    try {
      const dom = document.createElement('div')
      dom.innerHTML = `<comment-text data-comment-id="${c.id}">${c.body}</comment-text>`
      const slice = PMDOMParser.fromSchema(essaySchema).parseSlice(dom, { preserveWhitespace: true })
      currentDoc = currentDoc.replace(pos, pos, new Slice(slice.content, 0, 0))
      changed = true
      return { ...c, body: '' }
    } catch (err) {
      // A legacy inline comment's own body was always plain text (typed
      // into the old composer's plain `<textarea>`, never rich HTML) —
      // this shouldn't normally fail. But `comment_text` is a mark, not a
      // node: it can only ever apply to genuinely inline content, and an
      // insertion position right after an anchor is itself inline (inside
      // an existing paragraph's own content) — if `body` somehow contains
      // block-level markup (a `<p>`/`<ul>`/…, the way a *margin* comment's
      // own rich-HTML body legitimately can), parsing it this way produces
      // block nodes that don't fit there at all, and `Node.replace` throws
      // rather than silently losing or corrupting anything. Left unrepaired
      // (same as "no anchor to attach to," above) rather than letting one
      // comment's own unusual body crash this essay's entire load.
      console.error(`repairMissingInlineCommentBodies: failed migrating comment ${c.id}'s own body into the document`, err)
      return c
    }
  })
  return { doc: currentDoc, comments: changed ? repairedComments : comments, changed }
}

/** The depth of the nearest enclosing `section` around `$pos` — always ≥1 (the essay/slideshow document's own single root section, at depth 1) since, unlike a plain `doc`, `pmSchema.ts`'s `doc` content expression (`"section"`) guarantees every position is inside at least that one. Shared by `insertDivider` below: a `slide_break`/`fragment_break` always lands as a direct child of this container, never nested any deeper inside a list/blockquote the cursor happened to be in, and never lifted out past it — `slideSerializer.ts` reads a slide's own title off of exactly whichever section(s) enclose its own divider. */
function nearestSectionDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === 'section') return d
  }
  return 1
}

/**
 * Inserts a divider node (`slide_break`/`fragment_break`) right after the
 * current top-level block of its own nearest enclosing section. A
 * content-less atom's own post-insert selection isn't safe to depend on —
 * `replaceSelectionWith`'s own choice of where the selection lands next can
 * end up a `NodeSelection` *on* the atom just inserted rather than a
 * `TextSelection` after it (confirmed live in the previous slide-specific
 * prototype this replaces: typing right after inserting a divider was
 * silently replacing the divider itself with the first character typed).
 * Always following the break with a real, explicit empty paragraph of our
 * own — only when one doesn't already immediately follow — and placing the
 * selection inside *that* sidesteps the question entirely.
 */
function insertDivider(view: EditorView, breakNode: PMNode): void {
  const { state } = view
  const containerDepth = nearestSectionDepth(state.selection.$from)
  const pos = state.selection.$from.after(containerDepth + 1)
  const tr = state.tr.insert(pos, breakNode)
  const afterBreak = pos + breakNode.nodeSize
  const followingNode = tr.doc.nodeAt(afterBreak)
  if (!followingNode || !followingNode.isTextblock) {
    tr.insert(afterBreak, essaySchema.nodes.paragraph.create())
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(afterBreak + 1), 1))
  view.dispatch(tr)
  view.focus()
}

/** "Slide change" — a slideshow-only operation (see `pmSchema.ts`'s own doc comment on `slide_break`); the toolbar/keyboard-shortcut counterpart to typing plain prose. See `insertDivider`'s own doc comment for exactly where it lands. */
export function insertSlideBreak(view: EditorView): void {
  insertDivider(view, essaySchema.nodes.slide_break.create({ id: id() }))
}

/** The depth of the nearest enclosing `list_item` around `$pos`, or `null` if it isn't inside one — the innermost one, if nested lists put it inside more than one, matching "fragment at whatever bullet level the cursor is actually at." Only `insertFragmentBreak` below uses this; `insertSlideBreak` keeps landing after the *whole* list regardless (ending a slide mid-list isn't a gesture this schema needs to support the way mid-list fragmentation is). */
function nearestListItemDepth($pos: ResolvedPos): number | null {
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === 'list_item') return d
  }
  return null
}

/**
 * "Fragmented reveal": everything from here to the next divider (of either
 * kind) becomes the next reveal step when presenting (see
 * `slideSerializer.ts`). With the cursor inside a list item, lands the
 * break as a sibling right after that item — *inside* the list, between
 * two bullets (`pmSchema.ts`'s own `bullet_list`/`ordered_list` content
 * expression allows this) — rather than `insertDivider`'s own generic
 * "after the current top-level block of the enclosing section" landing
 * spot, which for a list would mean only ever after the *entire* list.
 * Deliberately a separate, simpler insertion path rather than a special
 * case inside `insertDivider` itself: a plain filler paragraph (what
 * `insertDivider` adds when nothing textblock-shaped immediately follows)
 * isn't valid content directly inside a list — only `list_item`/
 * `fragment_break` are — so there's nothing to backfill here; the next
 * list item (or the list's own end) is already a perfectly fine place for
 * the selection to land on its own.
 */
export function insertFragmentBreak(view: EditorView): void {
  const { state } = view
  const listItemDepth = nearestListItemDepth(state.selection.$from)
  if (listItemDepth == null) {
    insertDivider(view, essaySchema.nodes.fragment_break.create({ id: id() }))
    return
  }
  const pos = state.selection.$from.after(listItemDepth)
  const breakNode = essaySchema.nodes.fragment_break.create({ id: id() })
  const tr = state.tr.insert(pos, breakNode)
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + breakNode.nodeSize), 1))
  view.dispatch(tr)
  view.focus()
}

/** Deletes the divider at `pos` outright — since neither divider has any content of its own, this is already the entire "merge this slide into the previous one" / "drop this fragment boundary" operation. */
export function deleteDivider(view: EditorView, pos: number): void {
  const { state } = view
  const node = state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(state.tr.delete(pos, pos + node.nodeSize))
}
