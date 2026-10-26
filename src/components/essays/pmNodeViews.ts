import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView, ViewMutationRecord } from 'prosemirror-view'
import { citationLabel } from '../../lib/bibtex'
import { promptDialog } from '../../lib/prompt'
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
