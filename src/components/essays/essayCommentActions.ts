/**
 * Comment actions shared between `CommentsPanel.tsx` (margin cards) and
 * `EssayWorkspace.tsx`'s own inline-comment popover — the essay-level,
 * Stage B3 counterpart to `commentActions.ts` (which stays as-is, still
 * needed for an essay that hasn't been migrated). Unlike that module,
 * nothing here starts with a "sync whatever's on screen into storage
 * first" step — ProseMirror's own `EditorState` is already the live
 * source of truth at every moment, so there's no separate draft sitting
 * in a `contentEditable` shard that could be a step ahead of it.
 */
import { removeCommentAnchorMark, insertHtmlAtSelection } from './pmCommands'
import { deleteEssayCommentCascade, promoteEssayInlineComment, setEssayCommentDisplayMode } from '../../models/essayCommentsRepo'
import type { Essay } from '../../models/types'
import type { EditorView } from 'prosemirror-view'

/**
 * Deletes `commentId` and everything nested under it. A deleted top-level
 * `'text'` comment's own `comment_anchor` mark gets stripped out of the
 * live document too (view may be `null` — e.g. deleting from the mobile
 * "list" view of a split pane that isn't the focused one; the comment
 * record itself is still removed either way, just with a mark left
 * orphaned in the document until the next time that view is live and
 * notices there's no comment left for it to belong to — see
 * `pmCommentPlugin.ts`'s own filter, which only ever surfaces a mark that
 * still has a matching inline comment).
 */
export async function deleteEssayComment(essay: Essay, view: EditorView | null, commentId: string): Promise<void> {
  const { deletedTextIds } = await deleteEssayCommentCascade(essay, commentId)
  if (view) for (const cid of deletedTextIds) removeCommentAnchorMark(view, cid)
}

/** Switches a top-level `'text'` comment between margin and inline display — see `setEssayCommentDisplayMode`'s own doc comment for why this needs no document edit at all. */
export async function toggleEssayCommentDisplayMode(essay: Essay, commentId: string, mode: 'margin' | 'inline'): Promise<void> {
  await setEssayCommentDisplayMode(essay, commentId, mode)
}

/** Dissolves an inline comment into ordinary prose: splices its own body back into the live document right after its anchor, then strips the anchor mark — see `promoteEssayInlineComment`'s own doc comment for the data-only half of this. No-op (silently) if there's no live `view` to splice into, or the comment isn't a promotable top-level one. */
export async function promoteEssayComment(essay: Essay, view: EditorView | null, commentId: string): Promise<void> {
  if (!view) return
  const result = await promoteEssayInlineComment(essay, commentId)
  if (!result) return
  removeCommentAnchorMark(view, commentId, { placeCursorAfter: true })
  insertHtmlAtSelection(view, result.bodyHtml)
}
