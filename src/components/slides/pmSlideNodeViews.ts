import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { deleteBreak, setSlideBreakLayout } from './slideCommands'

const LAYOUTS: { value: string; label: string }[] = [
  { value: 'content', label: 'Content' },
  { value: 'section', label: 'Section header' },
]

/**
 * A `slide_break`'s own in-flow divider — just a thin rule the width of
 * the text column, with a layout picker and a delete control hanging off
 * its right margin rather than sitting inline in the flow (so the rule
 * itself stays exactly as tall as a rule, nothing more). The layout
 * picker only actually shows up on hover — see `styles.css`/
 * `slideTheme.css`'s own `:hover` rule — so it's not permanent visual
 * clutter sitting in the middle of running prose; the delete button stays
 * small but always visible. `.pm-slide-editor-root`'s own right padding
 * (`slideTheme.css`) reserves exactly enough room for it, in both this
 * NodeView's controls and `FragmentBreakView`'s own, so neither one ever
 * overlaps real body text sitting on an adjacent line.
 */
export class SlideBreakView implements NodeView {
  dom: HTMLElement
  node: PMNode
  view: EditorView
  getPos: () => number | undefined
  private layoutSelect: HTMLSelectElement

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('div')
    this.dom.className = 'slide-break-divider'
    this.dom.contentEditable = 'false'

    const controls = document.createElement('div')
    controls.className = 'divider-controls'

    this.layoutSelect = document.createElement('select')
    for (const opt of LAYOUTS) {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      this.layoutSelect.appendChild(el)
    }
    this.layoutSelect.value = node.attrs.layout || 'content'
    this.layoutSelect.title = 'Slide layout'
    this.layoutSelect.addEventListener('mousedown', (e) => e.stopPropagation())
    this.layoutSelect.addEventListener('change', () => {
      const pos = this.getPos()
      if (pos != null) setSlideBreakLayout(this.view, pos, this.layoutSelect.value)
    })
    controls.appendChild(this.layoutSelect)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'divider-delete'
    deleteBtn.title = 'Remove this slide break (merges into the previous slide)'
    deleteBtn.textContent = '✕'
    deleteBtn.addEventListener('mousedown', (e) => e.preventDefault())
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos != null) deleteBreak(this.view, pos)
    })
    controls.appendChild(deleteBtn)

    this.dom.appendChild(controls)
  }

  update(node: PMNode) {
    if (node.type.name !== 'slide_break') return false
    this.node = node
    this.layoutSelect.value = node.attrs.layout || 'content'
    return true
  }

  stopEvent() {
    return true
  }
}

/** A `fragment_break`'s own in-flow divider — even thinner than a slide break's, with no label at all (just the rule itself) and only a delete control. */
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

    const controls = document.createElement('div')
    controls.className = 'divider-controls'

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'divider-delete'
    deleteBtn.title = 'Remove this fragment break'
    deleteBtn.textContent = '✕'
    deleteBtn.addEventListener('mousedown', (e) => e.preventDefault())
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos != null) deleteBreak(this.view, pos)
    })
    controls.appendChild(deleteBtn)

    this.dom.appendChild(controls)
  }

  update(node: PMNode) {
    return node.type.name === 'fragment_break'
  }

  stopEvent() {
    return true
  }
}
