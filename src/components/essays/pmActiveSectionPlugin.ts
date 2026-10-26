import { Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

const ACTIVE_CLASS = 'section-rule-active'

/**
 * Shows a section's own left rule only while the cursor is directly
 * inside it (its own title or its own body text) — a subsection nested
 * inside it, or any other section entirely, stays rule-less, so at most
 * one rule is ever visible at a time. A plain CSS `:focus`-style
 * selector can't do this on its own: PM's selection lives in its own
 * document model, not as a real DOM focus state any single element
 * carries — there's no element to put a plain `:focus` on in the first
 * place, since the whole document shares one `contentEditable` surface,
 * not one per section.
 *
 * A `PluginView` rather than a decoration set: this only ever toggles one
 * class on a single already-mounted `SectionView` DOM node (`view.
 * nodeDOM`, `pmNodeViews.ts`), never touches document content, so there's
 * nothing here for ProseMirror's own decoration/redraw machinery to do —
 * reaching into the DOM directly, the same way `pmNodeViews.ts`'s own
 * NodeViews already own imperative pieces of it (the chevron, the demote
 * button), is simpler than modeling "which section is active" as a
 * decoration just to get this one CSS class applied.
 */
export function createActiveSectionPlugin(): Plugin {
  let activeEl: HTMLElement | null = null

  function sync(view: EditorView) {
    const $pos = view.state.selection.$from
    let next: HTMLElement | null = null
    for (let d = $pos.depth; d >= 1; d--) {
      if ($pos.node(d).type.name !== 'section') continue
      const dom = view.nodeDOM($pos.before(d))
      if (dom instanceof HTMLElement) next = dom
      break // innermost enclosing section only — never its own ancestors
    }
    if (activeEl && activeEl !== next) activeEl.classList.remove(ACTIVE_CLASS)
    if (next) next.classList.add(ACTIVE_CLASS)
    activeEl = next
  }

  return new Plugin({
    view(view) {
      sync(view)
      return {
        update: sync,
        destroy() {
          activeEl?.classList.remove(ACTIVE_CLASS)
          activeEl = null
        },
      }
    },
  })
}
