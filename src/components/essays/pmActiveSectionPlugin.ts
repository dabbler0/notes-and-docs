import { Plugin } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

const ACTIVE_CLASS = 'section-rule-active'

/**
 * Shows a section's own left rule only while the cursor is somewhere
 * inside it or one of its subsections — an unrelated section, or a
 * subsection nested *inside* the focused one, stays rule-less. A plain
 * CSS `:focus-within`-style selector can't do this on its own: PM's
 * selection lives in its own document model, not as a real DOM focus
 * state any single element carries, and even if it did, `:focus-within`
 * only looks *down* the tree (a focused leaf makes every ancestor match,
 * which is what's wanted here) — but there's no element to put a plain
 * `:focus` on in the first place, since the whole document shares one
 * `contentEditable` surface, not one per section.
 *
 * A `PluginView` rather than a decoration set: this only ever toggles one
 * class on a handful of already-mounted `SectionView` DOM nodes (`view.
 * nodeDOM`, `pmNodeViews.ts`), never touches document content, so there's
 * nothing here for ProseMirror's own decoration/redraw machinery to do —
 * reaching into the DOM directly, the same way `pmNodeViews.ts`'s own
 * NodeViews already own imperative pieces of it (the chevron, the demote
 * button), is simpler than modeling "which sections are active" as
 * decorations just to get this one CSS class applied.
 */
export function createActiveSectionPlugin(): Plugin {
  let activeEls: HTMLElement[] = []

  function sync(view: EditorView) {
    const $pos = view.state.selection.$from
    const next: HTMLElement[] = []
    for (let d = $pos.depth; d >= 1; d--) {
      if ($pos.node(d).type.name !== 'section') continue
      const dom = view.nodeDOM($pos.before(d))
      if (dom instanceof HTMLElement) next.push(dom)
    }
    for (const el of activeEls) if (!next.includes(el)) el.classList.remove(ACTIVE_CLASS)
    for (const el of next) el.classList.add(ACTIVE_CLASS)
    activeEls = next
  }

  return new Plugin({
    view(view) {
      sync(view)
      return {
        update: sync,
        destroy() {
          for (const el of activeEls) el.classList.remove(ACTIVE_CLASS)
          activeEls = []
        },
      }
    },
  })
}
