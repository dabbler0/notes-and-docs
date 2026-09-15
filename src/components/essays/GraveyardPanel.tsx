import { useEffect, useState } from 'preact/hooks'
import { deleteGraveyardFragment, listGraveyard } from '../../models/graveyardRepo'
import type { GraveyardFragment } from '../../models/types'

/**
 * A flat, most-recent-first list of everything "Send to graveyard" has cut
 * out of this essay — including fragments whose original node has since
 * been deleted entirely: `nodeTitle` is captured at the moment of removal
 * specifically so a fragment still reads sensibly once that happens, and
 * `nodeId` is kept only as a best-effort reference, never dereferenced to
 * decide whether to show something (see the type's own doc comment).
 * Unlike CommentsPanel's margin mode, nothing here tracks a live position in
 * the document — a fragment is inert text meant to be read and copied back
 * in by hand, so a plain scrollable list is all this needs.
 */
export function GraveyardPanel({
  essayId,
  onChanged,
  mode = 'panel',
}: {
  essayId: string
  onChanged?: () => void
  /** 'list' is the mobile rendering, matching CommentsPanel's own list mode — a plain full-width list inside a modal rather than the narrow fixed-width side column. */
  mode?: 'panel' | 'list'
}) {
  const [fragments, setFragments] = useState<GraveyardFragment[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)

  async function reload() {
    setFragments(await listGraveyard(essayId))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [essayId])

  async function handleDelete(fragmentId: string) {
    await deleteGraveyardFragment(fragmentId)
    reload()
    onChanged?.()
  }

  async function handleCopy(fragmentId: string, html: string) {
    const div = document.createElement('div')
    div.innerHTML = html
    const text = div.textContent || ''
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(fragmentId)
      setTimeout(() => setCopiedId((cur) => (cur === fragmentId ? null : cur)), 1500)
    } catch {
      // Clipboard API can be unavailable (no permission granted, an
      // insecure/embedded context) — the fragment's own text is still
      // fully visible and selectable in its card either way, so a failed
      // programmatic copy isn't a dead end, just a missed shortcut.
    }
  }

  const empty = <p className="muted margin-comments-empty" style={mode === 'list' ? { position: 'static' } : undefined}>Nothing here yet — "Send to graveyard" on some selected text in the document to keep it around without it cluttering the draft.</p>

  return (
    <div className={mode === 'list' ? 'comments-list-view' : 'graveyard-panel'}>
      {mode === 'list' && <h2 style={{ marginTop: 0 }}>Graveyard</h2>}
      {fragments.length === 0 && empty}
      <div className="graveyard-list">
        {fragments.map((f) => (
          <div className="comment-item graveyard-item" key={f.id}>
            <div className="comment-section-label">{f.nodeTitle || 'Untitled section'}</div>
            <div className="graveyard-fragment-text" dangerouslySetInnerHTML={{ __html: f.html }} />
            <div className="graveyard-item-actions">
              <button className="btn btn-ghost btn-sm" onClick={() => handleCopy(f.id, f.html)}>
                {copiedId === f.id ? 'Copied!' : 'Copy'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(f.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
