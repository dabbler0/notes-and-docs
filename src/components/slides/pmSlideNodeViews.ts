import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { deleteSlide, insertSlideAfter, setSlideLayout } from './slideCommands'

const LAYOUTS: { value: string; label: string }[] = [
  { value: 'title', label: 'Title slide' },
  { value: 'section', label: 'Section header' },
  { value: 'content', label: 'Content' },
  { value: 'bibliography', label: 'Bibliography (auto)' },
]

/**
 * One slide's own editing chrome — a layout picker, an index label, "new
 * slide after this one," and "delete" — sitting outside `contentDOM` as
 * plain sibling controls, the same "NodeView owns UI outside the content
 * it manages" pattern `pmNodeViews.ts`'s `SectionView` already uses for
 * the essay editor's chevron/number/demote button. The slide's own title
 * and body stay real document content inside `contentDOM`, edited with
 * ordinary transactions exactly like everywhere else.
 */
export class SlideView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  node: PMNode
  view: EditorView
  getPos: () => number | undefined
  private layoutSelect: HTMLSelectElement
  private indexLabel: HTMLElement

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos

    this.dom = document.createElement('div')
    this.dom.className = 'slide-edit-box'

    const header = document.createElement('div')
    header.className = 'slide-edit-header'
    header.contentEditable = 'false'

    this.indexLabel = document.createElement('span')
    this.indexLabel.className = 'slide-edit-index'
    header.appendChild(this.indexLabel)

    this.layoutSelect = document.createElement('select')
    this.layoutSelect.className = 'slide-edit-layout'
    for (const opt of LAYOUTS) {
      const el = document.createElement('option')
      el.value = opt.value
      el.textContent = opt.label
      this.layoutSelect.appendChild(el)
    }
    this.layoutSelect.addEventListener('mousedown', (e) => e.stopPropagation())
    this.layoutSelect.addEventListener('change', () => {
      const pos = this.getPos()
      if (pos != null) setSlideLayout(this.view, pos, this.layoutSelect.value)
    })
    header.appendChild(this.layoutSelect)

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'btn btn-sm btn-ghost'
    addBtn.textContent = '+ Slide after'
    addBtn.addEventListener('mousedown', (e) => e.preventDefault())
    addBtn.addEventListener('click', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos != null) insertSlideAfter(this.view, pos)
    })
    header.appendChild(addBtn)

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'btn btn-sm btn-ghost btn-danger'
    deleteBtn.textContent = 'Delete slide'
    deleteBtn.addEventListener('mousedown', (e) => e.preventDefault())
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      const pos = this.getPos()
      if (pos != null) deleteSlide(this.view, pos)
    })
    header.appendChild(deleteBtn)

    this.dom.appendChild(header)

    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'slide-edit-body'
    this.dom.appendChild(this.contentDOM)

    this.sync()
  }

  private sync() {
    this.layoutSelect.value = this.node.attrs.layout || 'content'
    const pos = this.getPos()
    const index = pos != null ? this.view.state.doc.resolve(pos).index(0) + 1 : 0
    this.indexLabel.textContent = `Slide ${index}`
  }

  update(node: PMNode) {
    if (node.type.name !== 'slide') return false
    this.node = node
    this.sync()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target
    if (!(target instanceof Node)) return false
    return this.dom.firstElementChild?.contains(target) ?? false
  }

  ignoreMutation(record: MutationRecord | { type: string; target: EventTarget | null }) {
    return !this.contentDOM.contains(record.target as Node)
  }
}
