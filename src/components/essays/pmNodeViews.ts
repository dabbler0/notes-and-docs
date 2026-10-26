import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import { citationLabel } from '../../lib/bibtex'
import { promptDialog } from '../../lib/prompt'
import { renderMathHtml } from '../../lib/math'
import type { Source } from '../../models/types'

/**
 * `citation` NodeView factory, closed over the live `sources` map
 * `EssayWorkspace.tsx` loads once per essay (`listSources()`) — renders
 * fresh from the source's *current* bibtex on every call, never a cached
 * label (see `pmSchema.ts`'s own doc comment on `citation`: this is the
 * entire point of making it a real atom rather than baked-in chip text,
 * matching `renderPrintCitation`'s own "always re-render, never trust a
 * stored label" rule for export). Clicking opens the same page/note
 * editor the old app's `handleCitationDblClick` did, via the same
 * `promptDialog`, writing the result straight back as a transaction
 * instead of mutating chip DOM by hand.
 */
export function createCitationView(sources: Map<string, Source>): new (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  return class CitationView implements NodeView {
    dom: HTMLElement
    node: PMNode
    view: EditorView
    getPos: () => number | undefined

    constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
      this.node = node
      this.view = view
      this.getPos = getPos
      this.dom = document.createElement('citation')
      this.dom.className = 'pm-citation'
      this.render(node)
      this.dom.addEventListener('click', (e) => {
        e.preventDefault()
        this.handleClick()
      })
    }

    private render(node: PMNode) {
      const source = sources.get(node.attrs.sourceId)
      this.dom.textContent = source ? citationLabel(source.bibtex, node.attrs.note ?? undefined) : `(unknown source: ${node.attrs.sourceId})`
      this.dom.title = 'Double-click to edit page/note'
    }

    private async handleClick() {
      const pos = this.getPos()
      if (pos == null) return
      const next = await promptDialog('Page number or other note for this citation?', { defaultValue: this.node.attrs.note ?? '', placeholder: 'e.g. p. 5', confirmLabel: 'Save' })
      if (next === null) return
      const note = next.trim()
      const tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, note: note || null })
      this.view.dispatch(tr)
    }

    update(node: PMNode) {
      if (node.type.name !== 'citation') return false
      this.node = node
      this.render(node)
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
export class SectionView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  node: PMNode
  view: EditorView
  getPos: () => number | undefined
  private chevron: HTMLButtonElement | null = null

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
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
    }

    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'section-body'
    this.dom.appendChild(this.contentDOM)
    this.syncCollapsed()
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

  update(node: PMNode) {
    if (node.type.name !== 'section') return false
    this.node = node
    this.dom.dataset.sectionId = node.attrs.id ?? ''
    this.syncCollapsed()
    return true
  }

  // The chevron sits outside `contentDOM` purely for layout/UI — clicks on
  // it shouldn't be interpreted as a document selection the way a click
  // inside the real content would be.
  stopEvent(event: Event) {
    return !!this.chevron && event.target instanceof Node && this.chevron.contains(event.target)
  }

  // Same reasoning in the other direction: the chevron's own attribute
  // changes (title/class, set by `syncCollapsed` above) are DOM mutations
  // outside `contentDOM` — nothing PM needs to reconcile against the
  // document.
  ignoreMutation(record: ViewMutationRecord) {
    return !this.contentDOM.contains(record.target as Node)
  }
}

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
