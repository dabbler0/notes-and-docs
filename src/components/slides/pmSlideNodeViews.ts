import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { deleteBreak, setSlideBreakLayout } from './slideCommands'

const LAYOUTS: { value: string; label: string }[] = [
  { value: 'title', label: 'Title slide' },
  { value: 'section', label: 'Section header' },
  { value: 'content', label: 'Content' },
  { value: 'bibliography', label: 'Bibliography (auto)' },
]

/**
 * A `slide_break`'s own in-flow divider — a thin labeled rule sitting
 * between two slides' worth of ordinary prose, with a layout `<select>`
 * widget right on it and a delete control, rather than a box wrapping
 * each slide's content. Same "NodeView owns a little UI outside the real
 * document content it's attached to" pattern `pmNodeViews.ts`'s own
 * `SectionView` uses for the essay editor's chevron/number/demote button
 * — the actual text before/after this divider is ordinary paragraph
 * content, with nothing special about it; only the divider itself is this
 * NodeView's concern.
 */
export class SlideBreakView implements NodeView {
  dom: HTMLElement
  node: PMNode
  view: EditorView
  getPos: () => number | undefined
  private layoutSelect: HTMLSelectElement
  private label: HTMLSpanElement

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('div')
    this.dom.className = 'slide-break-divider'
    this.dom.contentEditable = 'false'

    this.label = document.createElement('span')
    this.label.className = 'slide-break-label'
    this.dom.appendChild(this.label)

    this.layoutSelect = document.createElement('select')
    for (const opt of LAYOUTS) {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      this.layoutSelect.appendChild(el)
    }
    this.layoutSelect.value = node.attrs.layout || 'content'
    this.layoutSelect.addEventListener('mousedown', (e) => e.stopPropagation())
    this.layoutSelect.addEventListener('change', () => {
      const pos = this.getPos()
      if (pos != null) setSlideBreakLayout(this.view, pos, this.layoutSelect.value)
    })
    this.dom.appendChild(this.layoutSelect)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'slide-break-delete'
    deleteBtn.title = 'Remove this slide break (merges into the previous slide)'
    deleteBtn.textContent = '✕'
    deleteBtn.addEventListener('mousedown', (e) => e.preventDefault())
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos != null) deleteBreak(this.view, pos)
    })
    this.dom.appendChild(deleteBtn)
    this.syncLabel()
  }

  /** `bibliography` is the one layout where what you type after this divider isn't what ends up on the slide (its body is generated fresh at present time from every citation in the whole deck — see `slideSerializer.ts`) — called out directly on the divider itself so that's never a silent surprise while editing. */
  private syncLabel() {
    const layout = this.node.attrs.layout || 'content'
    this.label.textContent = layout === 'bibliography' ? 'Slide · auto-generated, text below is ignored' : 'Slide'
  }

  update(node: PMNode) {
    if (node.type.name !== 'slide_break') return false
    this.node = node
    this.layoutSelect.value = node.attrs.layout || 'content'
    this.syncLabel()
    return true
  }

  stopEvent() {
    return true
  }
}

/** A `fragment_break`'s own in-flow divider — much smaller than a slide break's, since the only thing to do with one is remove it. */
export class FragmentBreakView implements NodeView {
  dom: HTMLElement
  node: PMNode
  view: EditorView
  getPos: () => number | undefined

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('div')
    this.dom.className = 'fragment-break-divider'
    this.dom.contentEditable = 'false'

    const label = document.createElement('span')
    label.className = 'fragment-break-label'
    label.textContent = '⋯ fragment ⋯'
    this.dom.appendChild(label)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'fragment-break-delete'
    deleteBtn.title = 'Remove this fragment break'
    deleteBtn.textContent = '✕'
    deleteBtn.addEventListener('mousedown', (e) => e.preventDefault())
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos != null) deleteBreak(this.view, pos)
    })
    this.dom.appendChild(deleteBtn)
  }

  update(node: PMNode) {
    return node.type.name === 'fragment_break'
  }

  stopEvent() {
    return true
  }
}
