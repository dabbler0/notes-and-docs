import { useEffect, useState } from 'preact/hooks'
import { getCommitSnapshot, listEssayHistory, revertEssayTo } from '../../models/essayHistoryRepo'
import { confirmDialog } from '../../lib/confirm'
import { FrozenPreview } from './FrozenPreview'
import type { Essay, EssayCommitEntry, EssayNode, EssaySnapshot } from '../../models/types'

/**
 * The essay-level replacement for SectionBlock's old per-section "Version
 * history" dropdown — opened from `EssayWorkspace`'s own "History" button
 * (next to "Commit"), listing every commit in `essayHistory` for this one
 * essay, newest first. "View" reconstructs that commit's own full snapshot
 * (`getCommitSnapshot`) and renders it read-only via `FrozenPreview`, the
 * same component the old per-section comparison used, just driven by a
 * snapshot's `nodes` array instead of the live node tree. "Revert" appends
 * a new commit moving the live document back to that point — see
 * `revertEssayTo`'s own doc comment in `essayHistoryRepo.ts` for why this
 * never rewrites existing history.
 */
export function EssayHistoryPanel({
  essay,
  nodeMap,
  onReverted,
  onClose,
}: {
  essay: Essay
  nodeMap: Map<string, EssayNode>
  /** Called after a successful revert — the caller is responsible for reloading the live essay/nodeMap it holds (EssayWorkspace's own `reload()`). */
  onReverted: () => void
  onClose: () => void
}) {
  const [commits, setCommits] = useState<EssayCommitEntry[] | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [viewingSnapshot, setViewingSnapshot] = useState<EssaySnapshot | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    listEssayHistory(essay.id).then((h) => {
      if (!cancelled) setCommits([...h].sort((a, b) => b.seq - a.seq))
    })
    return () => {
      cancelled = true
    }
  }, [essay.id])

  async function handleView(commitId: string) {
    if (viewingId === commitId) {
      setViewingId(null)
      setViewingSnapshot(null)
      return
    }
    setViewingId(commitId)
    setViewingSnapshot((await getCommitSnapshot(essay.id, commitId)) ?? null)
  }

  async function handleRevert(commit: EssayCommitEntry) {
    const label = commit.label || new Date(commit.createdAt).toLocaleString()
    if (!(await confirmDialog(`Revert to "${label}"? This appends a new commit that moves the document back to that point — nothing is deleted, and this revert can itself be reverted later.`, { confirmLabel: 'Revert', danger: true })))
      return
    setBusy(true)
    try {
      await revertEssayTo(essay, nodeMap, commit.id)
      setViewingId(null)
      setViewingSnapshot(null)
      onReverted()
    } finally {
      setBusy(false)
    }
  }

  const previewMap = viewingSnapshot ? new Map(viewingSnapshot.nodes.map((n) => [n.id, n])) : null
  const previewRoot = viewingSnapshot?.nodes.find((n) => n.id === viewingSnapshot.rootNodeId)

  return (
    <div className="history-dropdown">
      <div className="history-dropdown-title">
        Commit history
        <button className="icon-btn" onClick={onClose} title="Close" style={{ float: 'right' }}>
          ×
        </button>
      </div>
      {commits === null ? (
        <div className="muted" style={{ padding: 12 }}>
          Loading…
        </div>
      ) : commits.length === 0 ? (
        <div className="muted" style={{ padding: 12 }}>
          No commits yet — use "Commit" to save the current state as a point you can come back to later.
        </div>
      ) : (
        <div className="history-list">
          {commits.map((c) => (
            <div className={`history-row${c.id === viewingId ? ' active' : ''}`} key={c.id}>
              <div className="history-row-info">
                <div className="history-row-label">
                  {c.kind !== 'commit' && <span className="chip">{c.kind}</span>} {c.label || 'Commit'}
                </div>
                <div className="history-row-date muted">{new Date(c.createdAt).toLocaleString()}</div>
              </div>
              <button className="btn btn-sm" disabled={busy} onClick={() => handleView(c.id)}>
                {c.id === viewingId ? 'Hide' : 'View'}
              </button>
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => handleRevert(c)}>
                Revert
              </button>
            </div>
          ))}
        </div>
      )}
      {previewMap && previewRoot && (
        <div className="version-split-pane frozen-pane" style={{ marginTop: 10 }}>
          <div className="version-split-label">Preview</div>
          <FrozenPreview content={previewRoot.draftContent} nodeMap={previewMap} depth={0} isRoot />
        </div>
      )}
    </div>
  )
}
