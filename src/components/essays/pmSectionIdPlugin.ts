import { Plugin } from 'prosemirror-state'
import { dedupeSectionIds } from './pmCommands'

/**
 * Ongoing defense against duplicate `section.attrs.id`s — see
 * `dedupeSectionIds`'s own doc comment (`pmCommands.ts`) for the real,
 * confirmed-live corruption path (pasting content that includes a
 * `section` carries its own id straight through unchanged) and the
 * confusing symptoms a collision causes. `PMEssayEditor.tsx` separately
 * repairs whatever a record's `doc` already has wrong the moment it's
 * opened; this plugin is what catches it going forward, the instant any
 * future transaction — a paste chief among them, but this doesn't care
 * which — would otherwise introduce one.
 *
 * `appendTransaction` runs as part of computing the very same state
 * `dispatchTransaction` (`PMEssayEditor.tsx`) applies — any corrective
 * transaction this returns is folded into that one state update before
 * the user ever sees it, never a separate, visible follow-up edit.
 */
export function createSectionIdDedupePlugin(): Plugin {
  return new Plugin({
    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged)) return null
      const fixed = dedupeSectionIds(newState.doc)
      if (fixed === newState.doc) return null
      return newState.tr.replaceWith(0, newState.doc.content.size, fixed.content)
    },
  })
}
