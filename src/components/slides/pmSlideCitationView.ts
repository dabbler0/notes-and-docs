import type { Node as PMNode } from 'prosemirror-model'
import type { NodeView } from 'prosemirror-view'
import { citationLabel } from '../../lib/bibtex'
import type { Source } from '../../models/types'

/**
 * A read-only citation chip for the slide editor — deliberately simpler
 * than the essay editor's own `CitationView` (`pmNodeViews.ts`): no inline
 * note editing, no arrow-key in/out navigation. A slide's own citations are
 * short and few, and this is a prototype; the full essay-grade chip can be
 * ported over later if editing a note in place turns out to matter here
 * too. The note itself is still real, settable data (`slideCommands.ts`'s
 * own `insertCitation`) — just not re-editable from inside this chip once
 * placed, same as changing a footnote's own anchor position isn't either.
 */
export function createSlideCitationView(sources: Map<string, Source>) {
  return class SlideCitationView implements NodeView {
    dom: HTMLElement
    node: PMNode

    constructor(node: PMNode) {
      this.node = node
      this.dom = document.createElement('citation')
      this.dom.className = 'pm-slide-citation'
      this.dom.contentEditable = 'false'
      this.render()
    }

    private render() {
      const source = sources.get(this.node.attrs.sourceId)
      this.dom.textContent = source ? citationLabel(source.bibtex, this.node.attrs.note ?? undefined) : `(unknown source)`
      this.dom.classList.toggle('pm-citation-unavailable', !source)
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
