/**
 * Comment actions shared between `CommentsPanel.tsx` (margin cards) and
 * `EssayWorkspace.tsx`'s own inline-comment controls — the essay-level,
 * Stage B3 counterpart to `commentActions.ts` (which stays as-is, still
 * needed for an essay that hasn't been migrated). Unlike that module,
 * nothing here starts with a "sync whatever's on screen into storage
 * first" step — ProseMirror's own `EditorState` is already the live
 * source of truth at every moment, so there's no separate draft sitting
 * in a `contentEditable` shard that could be a step ahead of it.
 */
import { removeCommentAnchorMark, removeCommentTextMark, insertHtmlAtSelection, extractInlineCommentBody, insertInlineCommentBodyFromHtml, commentAnchorEndPos } from './pmCommands'
import { deleteEssayCommentCascade, findEssayCommentById, promoteEssayInlineComment, setEssayCommentBodyAndMode } from '../../models/essayCommentsRepo'
import type { Essay } from '../../models/types'
import type { EditorView } from 'prosemirror-view'

/**
 * Deletes `commentId` and everything nested under it. A deleted top-level
 * `'text'` comment's own `comment_anchor` mark gets stripped out of the
 * live document too, and — if it was inline-displayed — its own
 * `comment_text` body span is discarded along with it (view may be `null`
 * — e.g. deleting from the mobile "list" view of a split pane that isn't
 * the focused one; the comment record itself is still removed either way,
 * just with marks left orphaned in the document until the next time that
 * view is live).
 */
export async function deleteEssayComment(essay: Essay, view: EditorView | null, commentId: string): Promise<void> {
  const { deletedTextIds } = await deleteEssayCommentCascade(essay, commentId)
  if (view) {
    for (const cid of deletedTextIds) {
      removeCommentAnchorMark(view, cid)
      extractInlineCommentBody(view, cid) // discards the returned HTML — nothing left to keep for a deleted comment
    }
  }
}

/**
 * Switches a top-level `'text'` comment between margin and inline
 * display, actually moving its own body into or out of the live document
 * to match — see `setEssayCommentBodyAndMode`'s own doc comment
 * (`essayCommentsRepo.ts`) for why the data layer alone can't do this.
 * Converting to margin extracts the comment's own `comment_text` span
 * (right after its anchor) back into plain HTML; converting to inline
 * splices its stored `body` HTML in as real, directly-editable content at
 * that same spot. No-op with no live `view`, or for a comment already in
 * the target mode.
 */
export async function convertEssayCommentDisplayMode(essay: Essay, view: EditorView | null, commentId: string, target: 'margin' | 'inline'): Promise<void> {
  const comment = findEssayCommentById(essay, commentId)
  if (!view || !comment || comment.anchorKind !== 'text' || comment.parentId !== null || comment.displayMode === target) return
  if (target === 'margin') {
    const body = extractInlineCommentBody(view, commentId)
    await setEssayCommentBodyAndMode(essay, commentId, 'margin', body)
    return
  }
  const pos = commentAnchorEndPos(view.state.doc, commentId)
  if (pos == null) return
  insertInlineCommentBodyFromHtml(view, commentId, pos, comment.body)
  await setEssayCommentBodyAndMode(essay, commentId, 'inline', '')
}

/**
 * Dissolves a top-level comment into ordinary prose: drops its own record
 * (see `promoteEssayInlineComment`'s own doc comment for the data-only
 * half of this) and turns whatever text it had into permanent document
 * content. For a margin comment, that text only ever existed as stored
 * `body` HTML, so it's spliced into the document fresh, right after the
 * anchor (`insertHtmlAtSelection`). For an inline-displayed comment, its
 * own body is *already* live document content (a `comment_text`-marked
 * span right after the anchor) — nothing to splice in; dissolving it is
 * just stripping both marks and leaving the already-typed text exactly
 * where it sits. No-op (silently) if there's no live `view` to edit, or
 * the comment isn't a promotable top-level one.
 */
export async function promoteEssayComment(essay: Essay, view: EditorView | null, commentId: string): Promise<void> {
  if (!view) return
  const comment = findEssayCommentById(essay, commentId)
  if (!comment || comment.parentId !== null) return
  if (comment.displayMode === 'inline') {
    removeCommentTextMark(view, commentId)
    removeCommentAnchorMark(view, commentId)
    await promoteEssayInlineComment(essay, commentId)
    return
  }
  const result = await promoteEssayInlineComment(essay, commentId)
  if (!result) return
  removeCommentAnchorMark(view, commentId, { placeCursorAfter: true })
  insertHtmlAtSelection(view, result.bodyHtml)
}
