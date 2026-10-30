/**
 * Console-only instrumentation for inspecting an essay's comment data live,
 * without needing a build with extra logging — exposed on `window` the same
 * way `firebaseClient.ts` exposes `__marginalSignInForTesting`. Updated by
 * `EssayWorkspace.tsx` on every render of the open essay, so
 * `__marginalDumpComments()` in the browser console always reflects
 * whatever's currently on screen.
 *
 * Rewritten for the comments-as-doc-content model (`pmSchema.ts`'s own doc
 * comment on `comment_thread`) — every comment now lives in `doc` itself,
 * not a separate `essay.comments` array, so there's no second source for
 * the count and the rendered list to ever diverge from in the first place.
 * This still earns its keep as a quick structural sanity check (duplicate
 * ids, say, from a sync bug neither of us has thought of yet).
 */
import type { Node as PMNode } from 'prosemirror-model'
import type { Essay } from '../models/types'
import { topLevelCommentThreads, commentAnchorText } from '../components/essays/pmCommands'

interface DebugCommentRow {
  id: string
  displayMode: string
  resolved: boolean
  anchorText: string | null
  replyCount: number
}

function countNestedThreads(node: PMNode): number {
  let count = 0
  node.descendants((child) => {
    if (child.type.name === 'comment_thread') count++
  })
  return count
}

function buildReport(essayId: string, essayTitle: string, doc: PMNode) {
  const top = topLevelCommentThreads(doc)
  const rows: DebugCommentRow[] = top.map(({ node }) => ({
    id: node.attrs.id,
    displayMode: node.attrs.displayMode,
    resolved: !!node.attrs.resolved,
    anchorText: commentAnchorText(doc, node.attrs.id),
    replyCount: countNestedThreads(node),
  }))
  const openCount = rows.filter((r) => !r.resolved).length
  const idCounts = new Map<string, number>()
  for (const { node } of top) idCounts.set(node.attrs.id, (idCounts.get(node.attrs.id) ?? 0) + 1)
  const duplicateIds = [...idCounts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  return { essayId, essayTitle, topLevelCount: rows.length, openCount, duplicateIds, rows }
}

export function exposeEssayForDebug(essay: Essay | null, doc: PMNode | null): void {
  const w = window as unknown as Record<string, unknown>
  w.__marginalCurrentEssay = essay
  w.__marginalCurrentDoc = doc
  w.__marginalDumpComments = () => {
    if (!essay || !doc) {
      console.log('[marginal] no essay open')
      return undefined
    }
    const report = buildReport(essay.id, essay.title, doc)
    console.log(`[marginal] "${report.essayTitle}" — ${report.openCount} open / ${report.topLevelCount} top-level`)
    if (report.duplicateIds.length) console.warn('[marginal] duplicate comment ids:', report.duplicateIds)
    console.table(report.rows)
    return report
  }
}
