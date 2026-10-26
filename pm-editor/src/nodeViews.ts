import type { Node as PMNode } from 'prosemirror-model'
import type { EditorView, NodeView } from 'prosemirror-view'
import { citationLabel } from './bibtex'
import { fakeSources } from './sources'

/**
 * Renders a `citation` atom fresh from `fakeSources` on every call, via
 * the real `citationLabel` formatter (`bibtex.ts`, copied in unmodified)
 * — the actual thing this prototype exists to demonstrate (see
 * `schema.ts`'s own doc comment: no cached label, live editing included).
 * Clicking prompts for a new page/note and writes it straight back as a
 * transaction, the same "update attrs in place" shape a real
 * citation-note editor would use.
 */
export class CitationView implements NodeView {
  dom: HTMLElement

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
    this.dom = document.createElement('citation')
    this.dom.className = 'pm-citation'
    this.render(node)
    this.dom.addEventListener('click', (e) => {
      e.preventDefault()
      const pos = getPos()
      if (pos == null) return
      const next = window.prompt('Page or note for this citation (blank to clear):', node.attrs.note ?? '')
      if (next === null) return
      const tr = view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, note: next.trim() || null })
      view.dispatch(tr)
    })
  }

  private render(node: PMNode) {
    const source = fakeSources[node.attrs.sourceId]
    this.dom.textContent = source ? citationLabel(source.bibtex, node.attrs.note ?? undefined) : `(unknown source: ${node.attrs.sourceId})`
    this.dom.title = 'Click to edit page/note — re-renders live from the source record, never a stale cached label'
  }

  update(node: PMNode) {
    if (node.type.name !== 'citation') return false
    this.render(node)
    return true
  }

  stopEvent() {
    return true
  }
}

/**
 * A footnote's own body is real document content (see `schema.ts`), so
 * this NodeView's `contentDOM` is what ProseMirror actually edits — the
 * expand/collapse toggle only ever hides/shows a `wrapper` *around*
 * `contentDOM` with CSS, never touching `contentDOM`'s own attributes
 * directly, so editing inside an open footnote survives the toggle
 * instead of losing focus/cursor continuity.
 *
 * Three things below earned their own comment, all found live while
 * first building this prototype chasing the same bug (the toggle
 * visually "not sticking" — `wrapper.style.display` would flip, then
 * silently flip back a moment later with no further click):
 * - `ignoreMutation()` returning `true` unconditionally is what actually
 *   fixed it. ProseMirror's own `MutationObserver` watches this node's
 *   whole subtree (not just `contentDOM`) for anything that changed
 *   outside a transaction, the same mechanism that lets it detect native
 *   browser edits (spellcheck corrections, autofill) it didn't initiate
 *   itself — our own `wrapper.style.display` toggle looked exactly like
 *   one of those to it, so without this hook telling it "ignore changes
 *   inside my own subtree, I'm handling them myself," it kept trying to
 *   reconcile the "unexpected" mutation by force-rebuilding the node.
 * - `update()` returning `true` unconditionally matters for the same
 *   underlying reason: without it, a rebuild destroys and recreates this
 *   whole NodeView, losing `open`'s own state and any editing focus
 *   inside `contentDOM`. `CitationView`/the math views below don't need
 *   this; they're atoms with no `contentDOM` to lose continuity in.
 * - `schema.ts`'s own `footnote` node uses `content: "inline*"`, not
 *   `"paragraph+"` — a block node nested inside an `inline: true` one
 *   doesn't round-trip cleanly through ProseMirror's DOM parsing either,
 *   which independently made the symptom worse before `ignoreMutation`
 *   was added. Both fixes are worth keeping regardless of which one
 *   would have been sufficient alone.
 */
export class FootnoteView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private wrapper: HTMLElement
  private marker: HTMLElement
  private open = false

  constructor() {
    this.dom = document.createElement('footnote')
    this.dom.className = 'pm-footnote'
    this.marker = document.createElement('sup')
    this.marker.className = 'pm-footnote-marker'
    this.marker.textContent = '*'
    this.marker.title = 'Click to expand/collapse this footnote’s own body'
    this.wrapper = document.createElement('span')
    this.wrapper.className = 'pm-footnote-wrapper'
    this.wrapper.style.display = 'none'
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

/** Shared by `math_inline`/`math_block` — a real KaTeX render is a drop-in swap for `.textContent = node.attrs.latex` here later; this prototype keeps the dependency list small since the editing/structural model, not equation rendering, is what's being validated at this stage. */
function mathView(tag: string, className: string): new (node: PMNode, view: EditorView, getPos: () => number | undefined) => NodeView {
  return class implements NodeView {
    dom: HTMLElement
    constructor(node: PMNode, view: EditorView, getPos: () => number | undefined) {
      this.dom = document.createElement(tag)
      this.dom.className = className
      this.render(node)
      this.dom.addEventListener('click', () => {
        const pos = getPos()
        if (pos == null) return
        const next = window.prompt('LaTeX:', node.attrs.latex)
        if (next === null) return
        view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { latex: next }))
      })
    }
    private render(node: PMNode) {
      this.dom.textContent = node.attrs.latex || '(empty equation)'
    }
    update(node: PMNode) {
      if (!node.type.isAtom) return false
      this.render(node)
      return true
    }
    stopEvent() {
      return true
    }
  }
}

export const MathInlineView = mathView('math-inline', 'pm-math pm-math-inline')
export const MathBlockView = mathView('math-block', 'pm-math pm-math-block')
