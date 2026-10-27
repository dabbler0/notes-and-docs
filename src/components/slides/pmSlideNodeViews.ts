import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { deleteBreak, promoteSectionAt, setSlideBreakLayout } from './slideCommands'

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

/**
 * A `section`'s own editing chrome — the essay editor's own collapse
 * chevron (`pmNodeViews.ts`'s `SectionView`) imported wholesale, plus a
 * "promote" button in the same spot its own demote button sits, but with
 * different mechanics underneath (`slideCommands.ts`'s own
 * `promoteSectionAt` — see its own doc comment for exactly why this
 * isn't just essay's `demoteSectionAt` reused as-is): the fix for "I
 * can't make a sibling section after the current one," since a brand-new
 * section can only ever be created as a *child* of wherever the cursor
 * is (`slideCommands.ts`'s own `insertSection`) — promoting it afterward
 * moves it bodily out to become a sibling of whatever used to contain
 * it, keeping its own title and section-ness intact. No section-number
 * label, unlike the essay version this is based on — numbered chapters
 * don't read as a meaningful convention for a slide deck's own
 * organizational sections the way they do for an essay's.
 */
export class SlideSectionView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  node: PMNode
  view: EditorView
  getPos: () => number | undefined
  private chevron: HTMLButtonElement
  private promoteBtn: HTMLButtonElement

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node
    this.view = view
    this.getPos = getPos
    this.dom = document.createElement('section')
    this.dom.dataset.sectionId = node.attrs.id ?? ''

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

    const promoteBtn = document.createElement('button')
    promoteBtn.type = 'button'
    promoteBtn.className = 'divider-delete section-demote'
    promoteBtn.contentEditable = 'false'
    promoteBtn.title = "Promote: move this section out of its own parent, as a sibling right after it — repeat to move it further up"
    promoteBtn.textContent = '⤴'
    promoteBtn.addEventListener('mousedown', (e) => e.preventDefault())
    promoteBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      const pos = this.getPos()
      if (pos != null) promoteSectionAt(this.view, pos)
    })
    this.dom.appendChild(promoteBtn)
    this.promoteBtn = promoteBtn

    this.contentDOM = document.createElement('div')
    this.contentDOM.className = 'slide-section-body'
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
    this.chevron.classList.toggle('collapsed', collapsed)
    this.chevron.title = collapsed ? 'Expand this section' : 'Collapse this section'
  }

  update(node: PMNode) {
    if (node.type.name !== 'section') return false
    this.node = node
    this.dom.dataset.sectionId = node.attrs.id ?? ''
    this.syncCollapsed()
    return true
  }

  stopEvent(event: Event) {
    const target = event.target
    if (!(target instanceof Node)) return false
    return this.chevron.contains(target) || this.promoteBtn.contains(target)
  }

  ignoreMutation(record: MutationRecord | { type: string; target: EventTarget | null }) {
    return !this.contentDOM.contains(record.target as Node)
  }
}
