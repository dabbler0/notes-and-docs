import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
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
