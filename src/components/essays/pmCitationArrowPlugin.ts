import { Plugin } from 'prosemirror-state'
import { getCitationView } from './pmNodeViews'

/**
 * Makes ArrowRight/ArrowLeft *approaching* a `citation` atom from the
 * surrounding document land the caret in its own note `<input>`
 * (`CitationView.focusNote`, `pmNodeViews.ts`) instead of ProseMirror's own
 * default for a selectable atom — turning it into a highlighted
 * `NodeSelection` that swallows the next arrow press just to step past it.
 * `CitationView`'s own `exitTo` is the matching other half: arrowing out
 * of the note input at its own text boundary hands the caret back to this
 * plugin's own territory, the ordinary document.
 *
 * Only intercepts a plain, unmodified arrow key with an empty (collapsed)
 * selection — Shift/Mod/Alt-arrow (extending a selection, word/line
 * jumps) and an existing range selection are left to ProseMirror's own
 * normal handling, same as any other `handleKeyDown` plugin in this app.
 */
export function createCitationArrowPlugin(): Plugin {
  return new Plugin({
    props: {
      handleKeyDown(view, event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
        const { selection } = view.state
        if (!selection.empty) return false
        const $pos = selection.$from
        if (event.key === 'ArrowRight') {
          const after = $pos.nodeAfter
          if (!after || after.type.name !== 'citation') return false
          const citationView = getCitationView(view.nodeDOM($pos.pos))
          if (!citationView) return false
          event.preventDefault()
          citationView.focusNote(-1)
          return true
        }
        const before = $pos.nodeBefore
        if (!before || before.type.name !== 'citation') return false
        const citationView = getCitationView(view.nodeDOM($pos.pos - before.nodeSize))
        if (!citationView) return false
        event.preventDefault()
        citationView.focusNote(1)
        return true
      },
    },
  })
}
