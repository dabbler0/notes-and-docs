import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import { getCommitSnapshot, getCommitPmSnapshot, listEssayHistory, revertEssayTo, revertPmEssayTo } from '../../models/essayHistoryRepo'
import { confirmDialog } from '../../lib/confirm'
import { FrozenPreview } from './FrozenPreview'
import { PMEssayEditor } from './PMEssayEditor'
import type { Essay, EssayCommitEntry, EssayNode, EssaySnapshot, LegacyEssaySnapshot, Source } from '../../models/types'

/**
 * The essay-level replacement for SectionBlock's old per-section "Version
 * history" dropdown — opened from `EssayWorkspace`'s own "History" button
 * (next to "Commit"), listing every commit in `essayHistory` for this one
 * essay, newest first. "Revert" appends a new commit moving the live
 * document back to that point — see `revertEssayTo`/`revertPmEssayTo`'s own
 * doc comments in `essayHistoryRepo.ts` for why this never rewrites
 * existing history.
 *
 * "View" branches on `essay.doc` the same way `ExportDialog.tsx` does:
 * - Pre-migration (`nodeMap` passed), reconstructs that commit's own
 *   `LegacyEssaySnapshot` (`getCommitSnapshot`) and renders it read-only via
 *   `FrozenPreview`, the same component the old per-section comparison used.
 * - Migrated (`doc`/`sources` passed), reconstructs an `EssaySnapshot`
 *   (`getCommitPmSnapshot`) and mounts a genuine read-only `PMEssayEditor`
 *   instance against it (`editable={false}`) instead of maintaining a
 *   second, PM-doc-aware rendering path by hand — citations/footnotes/math
 *   all render exactly as they do live, through the same NodeViews, for
 *   free. The synthetic `Essay` object this builds just to satisfy
 *   `PMEssayEditor`'s own props is never itself persisted — `editable:
 *   false` means its `scheduleSave` never fires.
 */
export function EssayHistoryPanel({
  essay,
  nodeMap,
  doc,
  sources,
  onReverted,
  onClose,
}: {
  essay: Essay
  nodeMap?: Map<string, EssayNode>
  /** Only used to decide "has this essay been migrated" — the live `PMEssayEditor.tsx` doc comment the preview below reads from is always the *reconstructed historical* one, never this current one. */
  doc?: PMNode | null
  sources?: Map<string, Source>
  /** Called after a successful revert — the caller is responsible for reloading the live essay/nodeMap it holds (EssayWorkspace's own `reload()`). */
  onReverted: () => void
  onClose: () => void
}) {
  const [commits, setCommits] = useState<EssayCommitEntry[] | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [viewingSnapshot, setViewingSnapshot] = useState<LegacyEssaySnapshot | null>(null)
  const [viewingPmSnapshot, setViewingPmSnapshot] = useState<EssaySnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const isPm = !!essay.doc
  // The frozen preview is always read-only (`editable={false}`) — nothing
  // ever clicks a comment anchor in it, so this never needs to hold a real
  // essay, just something stable to satisfy `PMEssayEditor`'s own prop.
  const previewCommentsHolder = useRef<Essay | null>(null)

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
      setViewingPmSnapshot(null)
      return
    }
    setViewingId(commitId)
    if (isPm) {
      setViewingPmSnapshot((await getCommitPmSnapshot(essay.id, commitId)) ?? null)
    } else {
      setViewingSnapshot((await getCommitSnapshot(essay.id, commitId)) ?? null)
    }
  }

  async function handleRevert(commit: EssayCommitEntry) {
    const label = commit.label || new Date(commit.createdAt).toLocaleString()
    if (!(await confirmDialog(`Revert to "${label}"? This appends a new commit that moves the document back to that point — nothing is deleted, and this revert can itself be reverted later.`, { confirmLabel: 'Revert', danger: true })))
      return
    setBusy(true)
    try {
      if (isPm) await revertPmEssayTo(essay, commit.id)
      else await revertEssayTo(essay, nodeMap!, commit.id)
      setViewingId(null)
      setViewingSnapshot(null)
      setViewingPmSnapshot(null)
      onReverted()
    } finally {
      setBusy(false)
    }
  }

  const previewMap = viewingSnapshot ? new Map(viewingSnapshot.nodes.map((n) => [n.id, n])) : null
  const previewRoot = viewingSnapshot?.nodes.find((n) => n.id === viewingSnapshot.rootNodeId)
  const previewEssay: Essay | null = viewingPmSnapshot
    ? { id: `${essay.id}:${viewingId}`, title: viewingPmSnapshot.title, rootNodeId: essay.rootNodeId, doc: viewingPmSnapshot.doc, comments: viewingPmSnapshot.comments, createdAt: 0, updatedAt: 0 }
    : null

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
      {previewEssay && (
        <div className="version-split-pane frozen-pane" style={{ marginTop: 10 }}>
          <div className="version-split-label">Preview</div>
          <div className="pm-history-preview">
            <PMEssayEditor record={previewEssay} sources={sources ?? new Map()} commentsHolder={previewCommentsHolder} editable={false} />
          </div>
        </div>
      )}
    </div>
  )
}
