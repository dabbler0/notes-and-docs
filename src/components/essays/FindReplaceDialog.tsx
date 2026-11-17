import { useState } from 'preact/hooks'
import type { EditorView } from 'prosemirror-view'
import { Modal } from '../Modal'
import { findAllMatches, replaceAllMatches, replaceNextMatch, selectNextMatch } from './findReplace'

/**
 * Find & replace against the live document — see `findReplace.ts`'s own
 * doc comment for why matching is always literal/Unicode-exact (never
 * folding a curly quote and a straight one together, say) and never
 * crosses a paragraph boundary. Originally built for one specific need
 * (fixing up quote characters an old version of `insertQuoteInline` had
 * already inserted — see `findReplace.ts`'s own doc comment), but is
 * ordinary general-purpose find/replace from here on.
 *
 * Reads/writes `view` directly (no `onReplace` callback threaded back up
 * to the caller) — same reasoning `CitationPickerDialog`'s sibling
 * dialogs don't need one either: every edit here is already a real,
 * dispatched transaction against the live `EditorView` by the time this
 * component's own state changes, so there's nothing left for a parent to
 * do with the result.
 */
export function FindReplaceDialog({ view, onClose }: { view: EditorView; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(true)
  const [lastReplacedCount, setLastReplacedCount] = useState<number | null>(null)

  const matchCount = query ? findAllMatches(view.state.doc, query, matchCase).length : 0

  function handleChange(setter: (v: string) => void) {
    return (e: Event) => {
      setter((e.target as HTMLInputElement).value)
      setLastReplacedCount(null)
    }
  }

  function handleFindNext() {
    selectNextMatch(view, query, matchCase)
  }

  function handleReplace() {
    replaceNextMatch(view, query, replacement, matchCase)
    setLastReplacedCount(null)
  }

  function handleReplaceAll() {
    setLastReplacedCount(replaceAllMatches(view, query, replacement, matchCase))
  }

  return (
    <Modal onClose={onClose}>
      <h2>Find &amp; replace</h2>
      <p className="muted" style={{ marginTop: -4 }}>
        Matches the exact characters typed below — a smart/curly quote (“ ”) and a straight one (") are never treated as the same character, so this can fix up text that already has the wrong kind.
      </p>
      <div className="field">
        <label>Find</label>
        <input autoFocus value={query} onInput={handleChange(setQuery)} placeholder="e.g. “ or ”" />
      </div>
      <div className="field">
        <label>Replace with</label>
        <input value={replacement} onInput={handleChange(setReplacement)} placeholder={'e.g. "'} />
      </div>
      <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 14 }}>
        <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase((e.target as HTMLInputElement).checked)} />
        Match case
      </label>
      <p className="muted" style={{ marginTop: -6 }}>
        {query ? `${matchCount} match${matchCount === 1 ? '' : 'es'} in the document` : 'Type something to find.'}
        {lastReplacedCount !== null && ` — replaced ${lastReplacedCount}.`}
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn" disabled={!query || matchCount === 0} onClick={handleFindNext}>
          Find next
        </button>
        <button className="btn" disabled={!query || matchCount === 0} onClick={handleReplace}>
          Replace
        </button>
        <button className="btn btn-primary" disabled={!query || matchCount === 0} onClick={handleReplaceAll}>
          Replace all
        </button>
      </div>
    </Modal>
  )
}
