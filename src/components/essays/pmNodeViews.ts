import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import { citationLabelOpen } from '../../lib/bibtex'
import { renderMathHtml } from '../../lib/math'
import { demoteSectionAt, deleteDivider, setCommentThreadResolved, deleteCommentThread, setCommentThreadDisplayMode, promoteCommentThread } from './pmCommands'
import type { Source } from '../../models/types'

/** The one thing `pmCitationArrowPlugin.ts` needs back out of a citation's own DOM — there's no public ProseMirror API to recover a NodeView instance from a position, only its DOM (`view.nodeDOM`), so `CitationView` stashes itself on its own root element for that plugin to read via `getCitationView` below. */
const CITATION_VIEW_KEY = '__pmCitationView'
interface CitationViewHost {
  focusNote(side: -1 | 1): void
}
export function getCitationView(dom: Node | null): CitationViewHost | null {
  return dom && typeof dom === 'object' && CITATION_VIEW_KEY in dom ? ((dom as unknown as Record<string, CitationViewHost>)[CITATION_VIEW_KEY] ?? null) : null
}

/**
 * `citation` NodeView factory, closed over the live `sources` map
 * `EssayWorkspace.tsx` loads once per essay (`listSources()`) — renders
 * fresh from the source's *current* bibtex on every call, never a cached
 * label (see `pmSchema.ts`'s own doc comment on `citation`: this is the
 * entire point of making it a real atom rather than baked-in chip text,
 * matching `renderPrintCitation`'s own "always re-render, never trust a
 * stored label" rule for export).
 *
 * The note is a real, always-present `<input>` living right where it
 * would print — not a modal — restoring the old per-node model's own
 * design (`citationLabelOpen`/`citationHtml` in `lib/bibtex.ts`: a fixed,
 * non-editable "(Author, Year" base and ")" close, with only the note
 * between them genuinely editable in place; that model used literal
 * `contenteditable="false"` spans around an ordinary editable text node
 * since the whole chip sat inside a `contentEditable` document, but a PM
 * atom has no content of its own to make part-editable that way, so an
 * actual native `<input>` embedded in the NodeView's own DOM is this
 * model's equivalent). `pmCitationArrowPlugin.ts` is the other half of
 * this: it's what makes ArrowRight/ArrowLeft *approaching* the chip from
 * surrounding document text land the caret in this input instead of
 * selecting the whole atom, the normal PM default for a selectable atom.
 */
export function createCitationView(sources: Map<string, Source>): new (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  return class CitationView implements NodeView {
    dom: HTMLElement
    node: PMNode
    view: EditorView
    getPos: () => number | undefined
    private baseSpan: HTMLElement
    private separator: HTMLElement
    private noteInput: HTMLInputElement
    private closeSpan: HTMLElement

    constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
      this.node = node
      this.view = view
      this.getPos = getPos
      this.dom = document.createElement('citation')
      this.dom.className = 'pm-citation'
      // Everything in this chip except `noteInput` itself needs to be
      // unambiguously non-editable — `stopEvent` below stops *PM's own*
      // reaction to the click/mousedown event, but the browser's own
      // independent "move the selection/caret to wherever was clicked"
      // default action isn't gated by that at all, and PM separately
      // syncs its own `view.state.selection` from whatever the *browser's*
      // selection ends up being (via `selectionchange`, a plain
      // `document`-level event with no "originating NodeView" of its own
      // for `stopEvent` to ever see). `contentEditable = 'false'` alone
      // doesn't prevent this either — confirmed live, it just changes the
      // browser's default action from "place a caret" to "select this
      // whole non-editable node," which PM still picks up as a real
      // `NodeSelection` over the citation atom, and typing while a node is
      // selected replaces it — so a click landing on `.pm-citation-base`
      // (not precisely on the thin input) ended up letting a single
      // keystroke delete the *entire* citation. The `mousedown` listener
      // below is the actual fix: calling `preventDefault()` stops the
      // browser from touching the selection at all for a click anywhere
      // in this chip except the input, and focusing the input directly
      // instead is exactly the behavior "click this citation" should have
      // in the first place.
      this.dom.contentEditable = 'false'
      this.dom.addEventListener('mousedown', (e) => {
        if (e.target === this.noteInput) return
        e.preventDefault()
        this.noteInput.focus()
      })
      ;(this.dom as unknown as Record<string, unknown>)[CITATION_VIEW_KEY] = this

      this.baseSpan = document.createElement('span')
      this.baseSpan.className = 'pm-citation-base'

      this.separator = document.createElement('span')
      this.separator.className = 'pm-citation-separator'
      this.separator.textContent = ', '

      this.noteInput = document.createElement('input')
      this.noteInput.type = 'text'
      this.noteInput.className = 'pm-citation-note-input'
      this.noteInput.setAttribute('aria-label', 'Citation page or note')
      this.noteInput.addEventListener('mousedown', (e) => e.stopPropagation())
      this.noteInput.addEventListener('input', () => {
        this.autoSize()
        this.syncHasNote()
        this.commitNote()
      })
      this.noteInput.addEventListener('keydown', (e) => this.handleNoteKeydown(e))

      this.closeSpan = document.createElement('span')
      this.closeSpan.className = 'pm-citation-close'
      this.closeSpan.textContent = ')'

      this.dom.append(this.baseSpan, this.separator, this.noteInput, this.closeSpan)
      this.render()
    }

    /** Re-renders the two fixed (non-editable) parts fresh from the source's current bibtex, and resyncs the note input's own value from `node.attrs.note` — but only while it isn't the thing the user is actively typing into, so a transaction this same input's own `input` handler just dispatched never steals its own focus/caret back out from under it (same "don't clobber what's live-focused" reasoning as `createMathView`'s own `editing` gate, just keyed off `document.activeElement` instead of a separate mode flag, since this input is always present, never toggled in/out of existence). */
    private render() {
      const source = sources.get(this.node.attrs.sourceId)
      this.baseSpan.textContent = source ? citationLabelOpen(source.bibtex) : `(unknown source: ${this.node.attrs.sourceId}`
      this.dom.classList.toggle('pm-citation-unavailable', !source)
      if (document.activeElement !== this.noteInput) {
        this.noteInput.value = this.node.attrs.note ?? ''
        this.autoSize()
      }
      this.syncHasNote()
    }

    /** No CSS width can track an `<input>`'s own content automatically — sized by hand to the note text's own length, same idea as an autosizing textarea, so the input reads as plain inline text rather than a fixed-width form field sitting in running prose. */
    private autoSize() {
      this.noteInput.style.width = `${Math.max(1, this.noteInput.value.length)}ch`
    }

    /** The ", " separator only makes sense in front of a real note — otherwise the chip would read "(Smith, 2020, )" for a plain, note-less citation. Toggled via a class (not conditional DOM removal) so the separator span's own position never has to be re-inserted around whatever's currently focused. */
    private syncHasNote() {
      this.dom.classList.toggle('pm-citation-has-note', this.noteInput.value.trim().length > 0)
    }

    private commitNote() {
      const pos = this.getPos()
      if (pos == null) return
      const note = this.noteInput.value.trim()
      if (note === (this.node.attrs.note ?? '')) return
      const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, note: note || null })
      this.view.dispatch(tr)
    }

    /** ArrowLeft at the input's own start, or ArrowRight at its own end, hands the caret back to the surrounding document instead of just doing nothing (the browser's own default for a single-line input at its own text boundary) — "navigated in/out of via arrow keys" is the whole point of this being a real input sitting in the document's own reading order, not a one-off popup. Escape/Enter both just leave the note as already-committed and move on, same exit as ArrowRight — there's nothing further to "confirm," since every keystroke already committed. */
    private handleNoteKeydown(e: KeyboardEvent) {
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const atStart = this.noteInput.selectionStart === 0 && this.noteInput.selectionEnd === 0
      const atEnd = this.noteInput.selectionStart === this.noteInput.value.length && this.noteInput.selectionEnd === this.noteInput.value.length
      if (e.key === 'ArrowLeft' && atStart) {
        e.preventDefault()
        this.exitTo(-1)
      } else if (e.key === 'ArrowRight' && atEnd) {
        e.preventDefault()
        this.exitTo(1)
      } else if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault()
        this.exitTo(1)
      }
    }

    private exitTo(side: -1 | 1) {
      const pos = this.getPos()
      if (pos == null) return
      const target = side === -1 ? pos : pos + this.node.nodeSize
      const tr = this.view.state.tr.setSelection(TextSelection.near(this.view.state.doc.resolve(target), side))
      this.view.dispatch(tr)
      this.view.focus()
    }

    /** Focuses the note input and places the caret at the given edge — `pmCitationArrowPlugin.ts`'s own counterpart to `exitTo` above, called when the surrounding document's own ArrowLeft/ArrowRight handling decides the caret should land in *this* chip instead of becoming a NodeSelection around it. */
    focusNote(side: -1 | 1) {
      this.noteInput.focus()
      // Entering from the chip's own left edge (-1, an ArrowRight moving into it) lands at the note's own start, so continuing right steps forward through it; entering from the right edge (1, ArrowLeft) lands at its end, so continuing left steps backward — normal text-navigation direction either way, never a surprise jump to the opposite end of what was just typed.
      const pos = side === -1 ? 0 : this.noteInput.value.length
      this.noteInput.setSelectionRange(pos, pos)
    }

    update(node: PMNode) {
      if (node.type.name !== 'citation') return false
      this.node = node
      this.render()
      return true
    }

    stopEvent() {
      return true
    }
  }
}

/**
 * `section` NodeView — adds a collapse/expand chevron (outline-folding, the
 * document-level counterpart to `NodeTree.tsx`'s own sidebar chevron; both
 * read/write the same `section.attrs.collapsed` — see `pmSchema.ts`'s own
 * doc comment on that attr) without disturbing `contentDOM`'s own
 * child-for-child correspondence to the node's real content (`section_title`
 * then its blocks): the chevron lives as a sibling *outside* `contentDOM`,
 * never a child of it, since ProseMirror diffs `contentDOM`'s children
 * 1:1 against the document and a stray non-content element there would
 * desync that. Collapsing is just hiding the body in CSS (`.collapsed` on
 * `dom`, see styles.css) — the section's own content, and the document
 * position it occupies, are completely unaffected; nothing about this is
 * destructive the way the old per-node model's `hidden` attribute wasn't
 * either.
 *
 * The root section (the essay's own single top-level section — always at
 * document position 0, the one place `getPos()` can return `0` for a
 * `section`) gets no chevron at all, matching the old app's own
 * `SectionBlock.tsx`: nothing above it to fold it away into.
 */
/** True when `section`'s own title is exactly "Abstract" — the PM-doc counterpart of `treeNumbering.ts`'s own `isAbstractTitle`, just reading a real section node's first child instead of an `EssayNode.title` string. */
function isAbstractTitled(section: PMNode): boolean {
  return (section.firstChild?.textContent ?? '').trim() === 'Abstract'
}

export class SectionView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  node: PMNode
  view: EditorView
  getPos: () => number | undefined
  private registry: Set<SectionView>
  private chevron: HTMLButtonElement | null = null
  private numberLabel: HTMLElement | null = null
  private demoteBtn: HTMLButtonElement | null = null

  /**
   * `registry` — every currently-mounted `SectionView` in this one
   * `EditorView` (a fresh `Set`, created once per mount — `PMEssayEditor.tsx`'s
   * own effect — and passed to each instance alike) — is what makes
   * `renumber()`, below, possible: see its own doc comment for why calling
   * it is needed at all.
   */
  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, registry: Set<SectionView>) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.registry = registry
    this.registry.add(this)
    this.dom = document.createElement('section')
    this.dom.dataset.sectionId = node.attrs.id ?? ''

    if (getPos() !== 0) {
      const chevron = document.createElement('button')
      chevron.type = 'button'
      chevron.className = 'section-chevron'
      chevron.contentEditable = 'false'
      chevron.textContent = '▾'
      chevron.addEventListener('mousedown', (e) => e.preventDefault())
      chevron.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.toggle()
      })
      this.dom.appendChild(chevron)
      this.chevron = chevron

      const numberLabel = document.createElement('span')
      numberLabel.className = 'section-number'
      numberLabel.contentEditable = 'false'
      this.dom.appendChild(numberLabel)
      this.numberLabel = numberLabel

      const demoteBtn = document.createElement('button')
      demoteBtn.type = 'button'
      demoteBtn.className = 'section-demote icon-btn'
      demoteBtn.contentEditable = 'false'
      demoteBtn.title = "Demote: fold this section's text back into its parent, removing the subsection but keeping the text"
      demoteBtn.textContent = '⤴'
      demoteBtn.addEventListener('mousedown', (e) => e.preventDefault())
      demoteBtn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const pos = this.getPos()
        if (pos != null) demoteSectionAt(this.view, pos)
      })
      this.dom.appendChild(demoteBtn)
      this.demoteBtn = demoteBtn
    }

    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'section-body'
    this.dom.appendChild(this.contentDOM)
    this.syncCollapsed()
    this.syncNumber()
  }

  private toggle() {
    const pos = this.getPos()
    if (pos == null) return
    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, collapsed: !this.node.attrs.collapsed })
    this.view.dispatch(tr)
  }

  private syncCollapsed() {
    const collapsed = !!this.node.attrs.collapsed
    this.dom.classList.toggle('collapsed', collapsed)
    if (this.chevron) {
      this.chevron.classList.toggle('collapsed', collapsed)
      this.chevron.title = collapsed ? 'Expand this section' : 'Collapse this section'
    }
  }

  /**
   * This section's own `x.y.z` numbering path, recomputed fresh from
   * `view.state.doc` on every mount/`update()`/external `renumber()` call
   * (see that method's own doc comment — *not* just `update()`, confirmed
   * live: ProseMirror's own diffing only calls `update()` on the sections
   * actually inside a transaction's changed range, so inserting a new
   * section left every *other* section's own number stale until something
   * else forced a full remount, e.g. reloading the page) — the PM-doc
   * counterpart of `treeNumbering.ts`'s own `pathOf`, which print/PDF
   * export's `addPrintChrome` (`lib/export.ts`) already shows the very same
   * way; restoring it live here means the document always reads with the
   * same numbers it'll actually print with. Walks this section's own
   * resolved position upward rather than storing/threading a path through
   * props. Only counts `section`-typed siblings (a
   * section's own content can freely mix paragraphs in with subsections),
   * and, like `pathOf`, a root-level section titled exactly "Abstract"
   * neither gets a number nor consumes a numbering slot — the real section
   * right after it still reads "1", not "2".
   *
   * A sibling element, like the chevron — *not* an attribute/child written
   * directly onto the real title `<h2>` inside `contentDOM`. That was
   * tried first (a `data-number` attribute, read back via a CSS `attr()`
   * `::before`) and caused a real, confirmed-live infinite parse/rebuild
   * loop: `h2` is rendered by ProseMirror's own default node renderer, not
   * by this NodeView, so it carries its *own* separate, built-in
   * `ignoreMutation` — one this class has no way to override — which
   * doesn't know to ignore a `data-number` change, treats it as an
   * unexpected external edit, and re-parses/rebuilds from the DOM:
   * destroying and recreating every `SectionView` in the affected range,
   * each of which (in that version) scheduled a fresh number-sync of its
   * own on mount, writing the attribute again, triggering the same
   * "unexpected mutation" response again, forever. Only `chevron`/
   * `demoteBtn`/this `numberLabel` — elements this NodeView creates and
   * owns *outside* `contentDOM` entirely — are actually safe to mutate by
   * hand; `ignoreMutation` below already exempts everything outside
   * `contentDOM` unconditionally, no special-casing needed.
   *
   * Still reads as genuinely inline with the title despite being a
   * separate element: `styles.css` floats it left of the title, which
   * (unlike absolute positioning) lets the title's own text wrap around
   * it exactly as if the number were literal leading text, without this
   * NodeView ever touching PM-managed DOM to get that effect.
   */
  private syncNumber() {
    if (!this.numberLabel) return
    const path = this.computeNumberPath()
    this.numberLabel.textContent = path ? `${path.join('.')}.` : ''
  }

  /**
   * The external trigger `dispatchTransaction` (`PMEssayEditor.tsx`) calls,
   * via `registry`, on every *other* mounted `SectionView` whenever any
   * transaction changes the document — not just the one(s) ProseMirror's
   * own diffing decided were inside the changed range. Numbering depends
   * on a section's position among its siblings, not on anything in its
   * own node (content/attrs can be bit-for-bit identical before and after
   * a sibling is inserted elsewhere), so it's exactly the kind of change
   * `update()` alone can silently miss — confirmed live as a real bug:
   * inserting a new section between two others left every section after
   * it showing its own *old* number (sometimes a bare duplicate of the
   * new section's own) until a full page reload remounted every view from
   * scratch. `getPos()` is already live/current by the time this runs —
   * `view.updateState()` finishes reconciling position tracking for every
   * mounted view synchronously, whether or not that view's own `update()`
   * was invoked — so this always reads this section's true, current place
   * in the document, not a stale one.
   */
  renumber() {
    this.syncNumber()
  }

  private computeNumberPath(): number[] | null {
    const pos = this.getPos()
    if (pos == null) return null
    const $pos = this.view.state.doc.resolve(pos)
    if ($pos.depth === 0) return null // the root section itself — never numbered
    // The root's own first *section*-typed child, specifically — never just
    // its first child overall, which root's own body can freely have
    // ordinary paragraphs in front of (same as any other section) without
    // that pushing its real first subsection out of the "could be the
    // abstract" slot. -1 when root has no child sections at all yet.
    const root = this.view.state.doc.firstChild
    let abstractChildIndex = -1
    if (root) {
      for (let i = 0; i < root.childCount; i++) {
        const child = root.child(i)
        if (child.type.name !== 'section') continue
        abstractChildIndex = isAbstractTitled(child) ? i : -1
        break
      }
    }
    if ($pos.depth === 1 && $pos.index(1) === abstractChildIndex) return null
    const path: number[] = []
    for (let d = 1; d <= $pos.depth; d++) {
      const parent = $pos.node(d)
      const myIndex = $pos.index(d)
      let count = 0
      for (let i = 0; i < myIndex; i++) {
        const child = parent.child(i)
        if (child.type.name !== 'section') continue
        if (d === 1 && i === abstractChildIndex) continue
        count++
      }
      path.push(count + 1)
    }
    return path
  }

  update(node: PMNode) {
    if (node.type.name !== 'section') return false
    this.node = node
    this.dom.dataset.sectionId = node.attrs.id ?? ''
    this.syncCollapsed()
    this.syncNumber()
    return true
  }

  // The chevron/number/demote button sit outside `contentDOM` purely for
  // layout/UI — clicks on them shouldn't be interpreted as a document
  // selection the way a click inside the real content would be.
  stopEvent(event: Event) {
    const target = event.target
    if (!(target instanceof Node)) return false
    return !!(this.chevron?.contains(target) || this.demoteBtn?.contains(target))
  }

  // Same reasoning in the other direction: the chevron/number/demote
  // button's own attribute changes (title/class/text, set by
  // `syncCollapsed`/`syncNumber` above) are DOM mutations outside
  // `contentDOM` — nothing PM needs to reconcile against the document.
  // This is also exactly why `syncNumber` writes to this `numberLabel`
  // sibling rather than onto the real title `<h2>` inside `contentDOM` —
  // see that method's own doc comment for the infinite-loop this already
  // caused once when it didn't.
  ignoreMutation(record: ViewMutationRecord) {
    return !this.contentDOM.contains(record.target as Node)
  }

  /** Unregisters from `registry` — called whenever ProseMirror tears this view down (the section was deleted, demoted away, or replaced by a fresh instance), so a later `renumber()` pass never iterates a detached view. */
  destroy() {
    this.registry.delete(this)
  }
}

/**
 * A `slide_break`/`fragment_break`'s own in-flow divider — just a plain
 * horizontal rule with a delete button hanging off its right margin, same
 * reserved-gutter idea `SectionView`'s own demote button already uses
 * (see styles.css). No label text, no layout picker — see `pmSchema.ts`'s
 * own doc comment on why these two atoms carry nothing beyond a stable
 * `id`. Shared by both node types; `tagName`/`className`/`deleteTitle`
 * are each one's only real difference.
 */
function createDividerView(tagName: 'slide-break' | 'fragment-break', className: string, deleteTitle: string): new (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  return class DividerView implements NodeView {
    dom: HTMLElement
    node: PMNode
    view: EditorView
    getPos: () => number | undefined

    constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
      this.node = node
      this.view = view
      this.getPos = getPos
      this.dom = document.createElement('div')
      this.dom.className = className
      this.dom.contentEditable = 'false'

      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'divider-delete'
      deleteBtn.title = deleteTitle
      deleteBtn.textContent = '✕'
      deleteBtn.addEventListener('mousedown', (e) => e.preventDefault())
      deleteBtn.addEventListener('click', (e) => {
        e.preventDefault()
        const pos = this.getPos()
        if (pos != null) deleteDivider(this.view, pos)
      })
      this.dom.appendChild(deleteBtn)
    }

    update(node: PMNode) {
      return node.type.name === tagName.replace('-', '_')
    }

    stopEvent() {
      return true
    }
  }
}

export const SlideBreakView = createDividerView('slide-break', 'slide-break-divider', 'Remove this slide break (merges into the previous slide)')
export const FragmentBreakView = createDividerView('fragment-break', 'fragment-break-divider', 'Remove this fragment break')

/**
 * `footnote` NodeView — ported from the standalone prototype's own
 * `FootnoteView` (`pm-editor/src/nodeViews.ts`) essentially unchanged; see
 * that file's own doc comment for the three specific, hard-won reasons
 * `update()`/`ignoreMutation()` both unconditionally return `true` and why
 * `pmSchema.ts`'s own `footnote` node uses `content: "inline*"`, not
 * `"paragraph+"` — all still apply verbatim here.
 *
 * A footnote's own body is real, directly-editable PM content now — a
 * genuine simplification over the old per-node model's separate
 * `Footnote[]` array, numbered-list-at-the-bottom-of-the-section
 * rendering, and orphan-pruning machinery (`pruneOrphanedFootnotes`,
 * `essaysRepo.ts`): there's no second record to keep in sync with the
 * marker at all. The marker itself (`<sup class="pm-footnote-marker">`)
 * is numbered the same way the old model's own `sup.footnote-ref` was —
 * a pure CSS counter scoped to the enclosing `.section-body` (see
 * styles.css), so nothing here tracks or stores a footnote's own number.
 *
 * Starts open when the footnote is still empty — unlike the prototype
 * (which never needed to, since nothing there actually created a
 * footnote through the live editor), `pmCommands.ts`'s own
 * `insertFootnote` places the cursor right inside a brand new one so it's
 * ready to type into immediately; `contentDOM` sits inside `wrapper`,
 * which starts `display: none` otherwise, and a browser can't put a real
 * selection inside an element nobody can see (confirmed live: the
 * selection silently fell back to the surrounding paragraph instead,
 * with everything typed landing there rather than in the footnote at
 * all — the exact same "needs a real place to land" reasoning
 * `createMathView`'s own `editing = !node.attrs.latex` already applies
 * for a freshly-created, still-empty equation).
 */
export class FootnoteView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private wrapper: HTMLElement
  private marker: HTMLElement
  private open: boolean

  constructor(node: PMNode) {
    this.open = !node.textContent.replace(/​/g, '')
    this.dom = document.createElement('footnote')
    this.dom.className = 'pm-footnote'
    this.marker = document.createElement('sup')
    this.marker.className = 'pm-footnote-marker'
    this.marker.title = 'Click to expand/collapse this footnote’s own body'
    this.wrapper = document.createElement('span')
    this.wrapper.className = 'pm-footnote-wrapper'
    this.wrapper.style.display = this.open ? 'inline' : 'none'
    this.contentDOM = document.createElement('span')
    this.contentDOM.className = 'pm-footnote-body'
    this.wrapper.appendChild(this.contentDOM)
    this.dom.append(this.marker, this.wrapper)
    this.marker.addEventListener('mousedown', (e) => {
      e.preventDefault()
      this.open = !this.open
      this.wrapper.style.display = this.open ? 'inline' : 'none'
    })
  }

  update(node: PMNode) {
    return node.type.name === 'footnote'
  }

  stopEvent(event: Event) {
    return event.target === this.marker
  }

  ignoreMutation() {
    return true
  }
}

/**
 * One comment's own `NodeView` — the `comment_thread` counterpart to
 * `FootnoteView` just above (see `pmSchema.ts`'s own doc comment on why a
 * comment is real document content now rather than a side array: nothing
 * here can go out of sync with the document, because there's only one
 * document — and why a reply/comment-on-a-span is just another
 * `comment_thread` nested inside this one's own content, not a separate
 * concept). Always renders a small marker element with this comment's own
 * `id` (`data-comment-id`) right in the main text flow, for
 * `CommentsPanel.tsx`'s own position-tracking — but only when this
 * `comment_thread` is actually top-level (`getPos`'s own resolved position
 * has no enclosing `comment_thread` ancestor); a nested one (reply,
 * comment-on-a-span) never needs independent positioning of its own, since
 * it only ever renders inside its parent's own card. `displayMode: 'inline'`
 * shows this comment's own content right there, directly editable, exactly
 * like a footnote's body — but *only* for a top-level thread; a nested one
 * always renders in place regardless of its own stored `displayMode` (see
 * `pmSchema.ts`'s own doc comment on why that attr is meaningless below the
 * top level). `displayMode: 'margin'` (top-level only) hides this
 * comment's own content here (the same `display: none` toggle
 * `FootnoteView` already uses for its own collapsed state) —
 * `CommentsPanel.tsx` renders its own mirror into the margin instead,
 * writing back through PM transactions rather than a side array.
 */
function buildCommentThreadToolbarButton(glyph: string, title: string, onActivate: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'pm-comment-thread-btn'
  btn.title = title
  btn.textContent = glyph
  btn.contentEditable = 'false'
  // Same `mousedown`-preventDefault / `click`-acts split every other
  // toolbar button in this app already uses (`EssayWorkspace.tsx`'s own
  // Bold/Italic/… buttons): the `mousedown` guard keeps this button from
  // stealing focus or collapsing whatever selection the click is about to
  // act on; the actual action only ever runs on `click`.
  btn.addEventListener('mousedown', (e) => e.preventDefault())
  btn.addEventListener('click', onActivate)
  return btn
}

/**
 * Finds a top-level comment's own marker (the small dot `CommentThreadView`
 * always renders, even for a `displayMode: 'margin'` comment whose own
 * wrapper is otherwise hidden) by its `commentId`, anywhere under `root`.
 * The one correct way to do this lookup — `CommentsPanel.tsx`'s own
 * `recompute()` needs it to line a margin card up with its real anchor —
 * since the `data-comment-id` attribute lives on the marker span itself
 * (`sync()`, below), never on the outer `<comment-thread>` tag, which
 * carries no id attribute of its own at all. Confirmed the hard way: a
 * selector written as if that attribute sat on the outer tag instead
 * (`comment-thread[data-comment-id="…"] > .pm-comment-thread-marker`)
 * silently matches nothing, for every comment, always — not a
 * loud failure, just every margin card falling back to the same generic
 * "nearest visible section header" anchor and clustering together near
 * the top of the document regardless of where their own anchors actually
 * are.
 */
export function findCommentThreadMarker(root: ParentNode, commentId: string): HTMLElement | null {
  return root.querySelector(`.pm-comment-thread-marker[data-comment-id="${cssEscapeId(commentId)}"]`)
}

/** `CSS.escape`, with the same plain-string fallback `CommentsPanel.tsx`'s own (duplicate, pre-existing) `cssEscape` already uses — kept local to this module rather than importing that one, which would mean this file reaching into `components/essays/CommentsPanel.tsx` for a one-line utility. */
function cssEscapeId(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

export class CommentThreadView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private wrapper: HTMLElement
  private marker: HTMLElement
  private resolveBtn: HTMLButtonElement
  private modeBtn: HTMLButtonElement
  private getPos: () => number | undefined
  private view: EditorView
  /** The view a *structural* edit (delete, promote — anything that removes or replaces this node outright, rather than just changing one of its attrs) should actually dispatch against. Defaults to `view` itself; `CommentsPanel.tsx`'s own detached margin editor (`CommentMarginEditor`) passes the *real* main `EditorView` here instead — see this node view's own doc comment on `forceVisible` for why a structural edit dispatched against the detached editor's own synthetic wrapper doc can't work the way an attr change can. */
  private realView: EditorView
  private node: PMNode
  /** True only inside `CommentsPanel.tsx`'s own detached margin editor (`CommentMarginEditor`) — the one place a margin-mode top-level comment's own content needs to actually show despite `displayMode: 'margin'` normally hiding it here (the whole reason that detached editor exists at all). */
  private forceVisible: boolean

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, forceVisible = false, realView?: EditorView) {
    this.node = node
    this.getPos = getPos
    this.view = view
    this.realView = realView ?? view
    this.forceVisible = forceVisible
    this.dom = document.createElement('comment-thread')
    this.dom.className = 'pm-comment-thread'
    this.marker = document.createElement('span')
    this.marker.className = 'pm-comment-thread-marker'
    this.marker.title = 'A comment is attached here'
    this.wrapper = document.createElement('span')
    this.wrapper.className = 'pm-comment-thread-wrapper'
    this.contentDOM = document.createElement('span')
    this.contentDOM.className = 'pm-comment-thread-entries'

    this.resolveBtn = buildCommentThreadToolbarButton('✓', 'Mark resolved', () => {
      setCommentThreadResolved(this.view, this.node.attrs.id, !this.node.attrs.resolved)
    })
    this.modeBtn = buildCommentThreadToolbarButton('→▤', 'Show this comment in the margin instead of inline', () => {
      setCommentThreadDisplayMode(this.view, this.node.attrs.id, this.node.attrs.displayMode === 'inline' ? 'margin' : 'inline')
    })
    const promoteBtn = buildCommentThreadToolbarButton('⇧¶', 'Promote to permanent prose (deletes the comment, keeps the text)', () => {
      promoteCommentThread(this.realView, this.node.attrs.id)
    })
    const deleteBtn = buildCommentThreadToolbarButton('×', 'Delete this comment', () => {
      deleteCommentThread(this.realView, this.node.attrs.id)
    })
    const toolbar = document.createElement('span')
    toolbar.className = 'pm-comment-thread-toolbar'
    toolbar.contentEditable = 'false'
    toolbar.append(this.resolveBtn, this.modeBtn, promoteBtn, deleteBtn)

    this.wrapper.append(this.contentDOM, toolbar)
    this.dom.append(this.marker, this.wrapper)
    this.sync(node)
  }

  /** Whether this comment is top-level — its *direct* parent isn't itself a `comment_thread` (nesting is always one level of indirection, so checking the immediate parent alone is enough; see `pmCommands.ts`'s own `topLevelCommentThreads`, which this mirrors). */
  private isTopLevel(): boolean {
    const pos = this.getPos()
    if (pos == null) return true
    const $pos = this.view.state.doc.resolve(pos)
    return $pos.parent.type.name !== 'comment_thread'
  }

  private sync(node: PMNode) {
    this.node = node
    this.marker.dataset.commentId = node.attrs.id ?? ''
    const topLevel = this.isTopLevel()
    this.marker.style.display = topLevel && !this.forceVisible ? '' : 'none'
    const inline = !topLevel || node.attrs.displayMode === 'inline' || this.forceVisible
    this.wrapper.style.display = inline ? 'inline' : 'none'
    this.dom.classList.toggle('pm-comment-thread-margin', topLevel && !inline)
    this.dom.classList.toggle('pm-comment-thread-resolved', !!node.attrs.resolved)
    this.resolveBtn.textContent = node.attrs.resolved ? '↺' : '✓'
    this.resolveBtn.title = node.attrs.resolved ? 'Mark unresolved' : 'Mark resolved'
    // A reply/comment-on-a-span never gets its own margin/inline toggle —
    // see `pmSchema.ts`'s own doc comment on why `displayMode` is
    // meaningless below the top level.
    this.modeBtn.style.display = topLevel ? '' : 'none'
    this.modeBtn.textContent = node.attrs.displayMode === 'inline' ? '→▤' : '→¶'
    this.modeBtn.title = node.attrs.displayMode === 'inline' ? 'Show this comment in the margin instead of inline' : 'Show this comment inline, in the text, instead of in the margin'
  }

  update(node: PMNode) {
    if (node.type.name !== 'comment_thread') return false
    this.sync(node)
    return true
  }

  stopEvent(event: Event) {
    return (event.target as Node | null) !== null && this.wrapper.contains(event.target as Node) && !this.contentDOM.contains(event.target as Node)
  }

  // Unlike FootnoteView's own unconditional `true` above, this only
  // exempts the marker/toolbar (outside `contentDOM`) — confirmed live
  // that ignoring *everything* unconditionally, the same way FootnoteView
  // does, breaks typing into a *nested* comment_thread specifically (a
  // reply, or "comment on a span within this comment"): the very first
  // characters typed there landed one level too shallow, in the parent's
  // own content, even though the model-level selection was already
  // correctly positioned inside the new nested node. Letting PM actually
  // read mutations inside `contentDOM` back into the model — the same
  // pattern `SectionView`'s own `ignoreMutation`, above, already uses —
  // closes that gap.
  ignoreMutation(record: ViewMutationRecord) {
    return !this.contentDOM.contains(record.target as Node)
  }
}

/**
 * `math_inline`/`math_block` NodeView — the real-KaTeX, click-to-edit
 * upgrade the prototype's own `mathView` (which just prompted for raw
 * LaTeX text) deferred to the actual migration. Reuses `renderMathHtml`
 * (`lib/math.ts`) and the old per-node model's own `.math-rendered`/
 * `.math-editor-input` styling unchanged — only the editing mechanism
 * underneath is new: a plain `<textarea>` this NodeView owns directly
 * (committing via `setNodeMarkup`, same transaction-based pattern as
 * every other NodeView here) rather than the old model's own
 * `MathBody.tsx`, which was built around a literal `data-latex` DOM
 * attribute and a `.node-content` shard to dispatch an `input` event
 * into — neither of which exists in this model (there's no shard, and an
 * atom's own `attrs.latex` already *is* the live, single source of
 * truth, no separate DOM-vs-stored-data sync step needed).
 *
 * A freshly-created, still-empty equation (see `pmInputRules.ts`'s own
 * `$$`/`\(` shortcuts) starts open for editing automatically — "ready to
 * type LaTeX into immediately" was the whole point of a typed shortcut
 * creating one in the first place, same as the old model's own
 * `autoMathify`. Committing with empty text removes the node outright
 * rather than leaving a permanently-empty bubble behind, the equation
 * counterpart of the old model's `handleSourceChipEmptying`.
 */
export function createMathView(displayMode: boolean): new (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  return class MathView implements NodeView {
    dom: HTMLElement
    node: PMNode
    view: EditorView
    getPos: () => number | undefined
    private editing: boolean

    constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
      this.node = node
      this.view = view
      this.getPos = getPos
      this.editing = !node.attrs.latex
      this.dom = document.createElement(displayMode ? 'math-block' : 'math-inline')
      this.dom.addEventListener('click', () => {
        if (this.editing) return
        this.editing = true
        this.render()
      })
      this.render()
    }

    private render() {
      this.dom.innerHTML = ''
      if (this.editing) {
        this.dom.className = `math-editor${displayMode ? ' math-editor-block' : ' math-editor-inline'}`
        const textarea = document.createElement('textarea')
        textarea.className = 'math-editor-input'
        textarea.rows = displayMode ? 2 : 1
        textarea.placeholder = 'LaTeX, e.g. x^2 + y^2 = z^2'
        textarea.value = this.node.attrs.latex
        textarea.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            this.commit(textarea.value.trim())
          } else if (e.key === 'Escape') {
            e.preventDefault()
            this.commit((this.node.attrs.latex as string).trim())
          }
        })
        textarea.addEventListener('blur', () => this.commit(textarea.value.trim()))
        this.dom.appendChild(textarea)
        requestAnimationFrame(() => {
          textarea.focus()
          textarea.select()
        })
      } else {
        const latex = this.node.attrs.latex as string
        if (latex) {
          this.dom.className = `math-rendered${displayMode ? ' math-rendered-block' : ' math-rendered-inline'}`
          this.dom.innerHTML = renderMathHtml(latex, displayMode)
        } else {
          this.dom.className = `math-rendered math-rendered-empty${displayMode ? ' math-rendered-block' : ' math-rendered-inline'}`
          this.dom.textContent = '(empty equation — click to write LaTeX)'
        }
      }
    }

    private commit(value: string) {
      const pos = this.getPos()
      if (pos == null) return
      this.editing = false
      if (value === '') {
        this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize))
        // The node itself is gone — PM destroys this NodeView along with
        // it, so there's nothing of our own left to re-render.
      } else {
        let tr = this.view.state.tr.setNodeMarkup(pos, undefined, { latex: value })
        tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1), 1))
        this.view.dispatch(tr)
        // Escape re-commits the *same* latex the node already had — a
        // value-equal node (`node.eq()` true) is indistinguishable from
        // "nothing changed" to ProseMirror's own reconciliation, which
        // skips calling `update()` below as a real, confirmed-live
        // optimization (the editor otherwise stayed visibly stuck open
        // after Escape, forever, since nothing ever flipped it back).
        // Rendering here directly, instead of trusting `update()` to run,
        // means `editing`'s own DOM state is never contingent on whether
        // PM happened to consider this particular commit a "real" change.
        this.render()
      }
      this.view.focus()
    }

    update(node: PMNode) {
      if (node.type.name !== (displayMode ? 'math_block' : 'math_inline')) return false
      this.node = node
      this.render()
      return true
    }

    stopEvent() {
      return true
    }
  }
}
