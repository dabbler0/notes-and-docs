import type { Node as PMNode } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'

/**
 * Find & replace across a whole essay/slideshow document — built
 * specifically to be usable for the one thing that motivated it: fixing
 * up a document's worth of already-inserted inline quotes
 * (`pmCommands.ts`'s own `insertQuoteInline` used to wrap a quote in a
 * mismatched curly open/close pair, `“`/`”`, before it was changed to a
 * single straight `"`; a document written against the old version has no
 * other way to get its existing quotes onto the new character) — a use
 * case that no longer exists now that an inline quote carries no mark of
 * its own at all (see `insertQuoteInline`'s own doc comment), but the tool
 * itself is ordinary general-purpose find/replace regardless. Every
 * match is a literal, Unicode-exact substring comparison — no Unicode
 * normalization, no folding visually-similar characters together — so a
 * curly quote and a straight one are never treated as "the same
 * character" the way a looser, display-oriented text search elsewhere in
 * this app might. `caseSensitive` is the one dimension this *does* let a
 * caller relax, same as every ordinary find/replace tool offers.
 *
 * A match never crosses a textblock boundary (one paragraph's own end and
 * the next paragraph's own start are never "adjacent" for matching
 * purposes, same as a real editor's own find would never match across two
 * separate paragraphs) — `findAllMatches` walks every textblock
 * independently. Within one textblock, a non-text inline atom (a
 * `citation`, `footnote`, `hard_break`, `math_inline`) counts as exactly
 * one character that can never match anything real (`\0`, via
 * `textBetween`'s own `leafText`) rather than being skipped outright —
 * skipping it would shift every position after it out of alignment with
 * the real document.
 */
export interface FindReplaceMatch {
  from: number
  to: number
}

export function findAllMatches(doc: PMNode, query: string, caseSensitive: boolean): FindReplaceMatch[] {
  if (!query) return []
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: FindReplaceMatch[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const text = node.textBetween(0, node.content.size, undefined, '\0')
    const haystack = caseSensitive ? text : text.toLowerCase()
    let idx = 0
    for (;;) {
      const found = haystack.indexOf(needle, idx)
      if (found === -1) break
      // `pos` (from `descendants`) is the position just *before* this
      // textblock's own opening token — `pos + 1` is where its real
      // content actually starts.
      matches.push({ from: pos + 1 + found, to: pos + 1 + found + needle.length })
      idx = found + Math.max(needle.length, 1)
    }
    return false // a textblock has no nested textblock to recurse into anyway
  })
  return matches
}

/**
 * Replaces every match at once, in one transaction/undo step. Processed
 * last-match-first specifically so each match's own `from`/`to` (computed
 * once, up front, against the *original* doc) is still valid by the time
 * it's used — replacing earlier matches first would shift the position of
 * every match still to come whenever `replacement.length !== query.length`,
 * which replacing in reverse sidesteps entirely rather than needing to
 * re-map each one through `tr.mapping`.
 *
 * `insertText`'s own mark-preserving behavior (prosemirror-state) keeps
 * whatever marks a replaced run already carries (bold, italic, a
 * citation's own surrounding text, …): for a match entirely inside one
 * already-uniformly-marked run, it reuses that run's own marks for the
 * replacement text; a replacement whose match spans two differently-marked
 * runs loses marks entirely instead (prosemirror-state's own
 * `marksAcross`, not something this layer tries to work around).
 */
export function replaceAllMatches(view: EditorView, query: string, replacement: string, caseSensitive: boolean): number {
  const matches = findAllMatches(view.state.doc, query, caseSensitive)
  if (matches.length === 0) return 0
  const tr = view.state.tr
  for (let i = matches.length - 1; i >= 0; i--) {
    const { from, to } = matches[i]
    tr.insertText(replacement, from, to)
  }
  view.dispatch(tr)
  view.focus()
  return matches.length
}

/** The match at or after the current selection, wrapping back around to the first match once the end of the document is passed — same "keep pressing Find Next and eventually come back where you started" behavior any editor's own find bar has. */
function matchAfterSelection(view: EditorView, query: string, caseSensitive: boolean): FindReplaceMatch | null {
  const matches = findAllMatches(view.state.doc, query, caseSensitive)
  if (matches.length === 0) return null
  const cur = view.state.selection.to
  return matches.find((m) => m.from >= cur) ?? matches[0]
}

/** Selects (and scrolls to) the next match without changing anything — the "Find Next" button. */
export function selectNextMatch(view: EditorView, query: string, caseSensitive: boolean): boolean {
  const match = matchAfterSelection(view, query, caseSensitive)
  if (!match) return false
  const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

/** Replaces just the next match (from the current selection onward, wrapping around) — the "Replace" button, as opposed to "Replace All". */
export function replaceNextMatch(view: EditorView, query: string, replacement: string, caseSensitive: boolean): boolean {
  const match = matchAfterSelection(view, query, caseSensitive)
  if (!match) return false
  const tr = view.state.tr.insertText(replacement, match.from, match.to)
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}
