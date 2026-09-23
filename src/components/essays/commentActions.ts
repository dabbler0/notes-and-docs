/**
 * Comment actions shared between `CommentsPanel.tsx` (margin cards) and
 * `EssayWorkspace.tsx`'s inline comment editing popover (opened by clicking
 * a `.inline-comment-marker` in the document — see `handleDocClick`) — both
 * need the same "sync the live DOM into draftContent, then run the actual
 * data mutation" shape, since either one can trigger an action on a comment
 * whose anchoring section has in-progress, not-yet-debounce-saved edits
 * sitting in its live shard.
 */
import { reconstructContent } from '../../lib/childMarkers'
import { commentSubtreeIds, deleteCommentCascade, promoteInlineComment, saveNode, setCommentDisplayMode } from '../../models/essaysRepo'
import type { EssayNode } from '../../models/types'

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/** Reconstructs `node`'s draftContent from its live, mounted DOM (if mounted at all) and persists it — the "capture whatever's actually on screen first" step every action below starts with, same reasoning as `EssayWorkspace.tsx`'s own `persistActiveNode`. */
async function syncFromDom(node: EssayNode): Promise<void> {
  const html = reconstructContent(node.id)
  if (html != null) {
    node.draftContent = html
    await saveNode(node)
  }
}

/**
 * Unwraps `commentId`'s own `<mark class="comment-anchor" data-comment-id>`
 * — if it has one — out of the live, mounted DOM first (same division of
 * labor as footnote deletion in SectionBlock.tsx, since the section's own
 * contentEditable shard can be a moment ahead of what's actually been
 * debounce-saved), then deletes the comment (and everything nested under
 * it) via `deleteCommentCascade`.
 */
export async function deleteComment(node: EssayNode, commentId: string): Promise<void> {
  const ids = commentSubtreeIds(node, commentId)
  for (const cid of ids) {
    const mark = document.querySelector(`mark.comment-anchor[data-comment-id="${cssEscape(cid)}"]`)
    if (mark) mark.replaceWith(...Array.from(mark.childNodes))
  }
  await syncFromDom(node)
  await deleteCommentCascade(node, commentId)
}

/** Switches a top-level `'text'` comment between margin and inline display, syncing whatever's currently on screen first — see `setCommentDisplayMode`'s own doc comment for what that actually changes. */
export async function toggleCommentDisplayMode(node: EssayNode, commentId: string, mode: 'margin' | 'inline'): Promise<void> {
  await syncFromDom(node)
  await setCommentDisplayMode(node, commentId, mode)
}

/** Dissolves an inline comment into ordinary prose, syncing whatever's currently on screen first — see `promoteInlineComment`'s own doc comment. */
export async function promoteComment(node: EssayNode, commentId: string): Promise<void> {
  await syncFromDom(node)
  await promoteInlineComment(node, commentId)
}
