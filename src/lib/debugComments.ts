/**
 * Console-only instrumentation for inspecting an essay's comment data live,
 * without needing a build with extra logging — exposed on `window` the same
 * way `firebaseClient.ts` exposes `__marginalSignInForTesting`. Updated by
 * `EssayWorkspace.tsx` on every render of the open essay, so
 * `__marginalDumpComments()` in the browser console always reflects
 * whatever's currently on screen.
 */
import type { Node as PMNode } from 'prosemirror-model'
import type { Comment, Essay } from '../models/types'
import { commentTextRange } from '../components/essays/pmCommands'

interface DebugCommentRow {
  id: string
  parentId: string | null
  anchorKind: Comment['anchorKind']
  displayMode: string | undefined
  resolved: boolean
  bodyLength: number
  hasLiveInlineSpan: boolean | null
  childCount: number
}

function buildReport(essay: Essay, doc: PMNode | null) {
  const all = essay.comments ?? []
  const rows: DebugCommentRow[] = all.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    anchorKind: c.anchorKind,
    displayMode: c.displayMode,
    resolved: c.resolved,
    bodyLength: c.body?.length ?? 0,
    hasLiveInlineSpan: c.displayMode === 'inline' && doc ? commentTextRange(doc, c.id) != null : null,
    childCount: all.filter((child) => child.parentId === c.id).length,
  }))
  const topLevel = rows.filter((r) => r.parentId === null)
  const openCount = topLevel.filter((r) => !r.resolved).length
  const idCounts = new Map<string, number>()
  for (const c of all) idCounts.set(c.id, (idCounts.get(c.id) ?? 0) + 1)
  const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  const orphanedInline = topLevel.filter((r) => r.displayMode === 'inline' && r.childCount === 0 && r.hasLiveInlineSpan === false && !r.resolved)
  return { essayId: essay.id, essayTitle: essay.title, totalComments: all.length, topLevelCount: topLevel.length, openCount, duplicateIds, orphanedInline, rows }
}

export function exposeEssayForDebug(essay: Essay | null, doc: PMNode | null): void {
  const w = window as unknown as Record<string, unknown>
  w.__marginalCurrentEssay = essay
  w.__marginalCurrentDoc = doc
  w.__marginalDumpComments = () => {
    if (!essay) {
      console.log('[marginal] no essay open')
      return undefined
    }
    const report = buildReport(essay, doc)
    console.log(`[marginal] "${report.essayTitle}" — ${report.openCount} open / ${report.topLevelCount} top-level / ${report.totalComments} total`)
    if (report.duplicateIds.length) console.warn('[marginal] duplicate comment ids:', report.duplicateIds)
    if (report.orphanedInline.length) console.warn('[marginal] orphaned inline comments (counted as open, no live content, no replies):', report.orphanedInline)
    console.table(report.rows)
    return report
  }
}
