import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import { commentAnchorEndPos } from './pmCommands'
import type { Essay } from '../../models/types'

export const commentPluginKey = new PluginKey<DecorationSet>('comments')

/** A short, plain-text preview (no HTML) — same truncation rule the old model's own collapsed `.inline-comment-preview` used, minus the HTML itself (a widget decoration's own DOM is static chrome, not a place to re-render someone's rich-text body — see this file's own doc comment). */
function previewText(bodyHtml: string): string {
  const div = document.createElement('div')
  div.innerHTML = bodyHtml
  const text = (div.textContent ?? '').trim()
  if (!text) return ''
  return text.length > 60 ? text.slice(0, 60) + '…' : text
}

function buildDecorations(state: EditorState, essay: Essay | null): DecorationSet {
  if (!essay?.comments?.length) return DecorationSet.empty
  const inlineTopLevel = essay.comments.filter((c) => c.parentId === null && c.anchorKind === 'text' && c.displayMode === 'inline')
  if (!inlineTopLevel.length) return DecorationSet.empty
  const decorations: Decoration[] = []
  for (const comment of inlineTopLevel) {
    const pos = commentAnchorEndPos(state.doc, comment.id)
    if (pos == null) continue
    decorations.push(
      Decoration.widget(
        pos,
        () => {
          const span = document.createElement('span')
          span.className = 'inline-comment-preview'
          span.dataset.commentId = comment.id
          span.textContent = previewText(comment.body)
          return span
        },
        { key: comment.id, side: 1 },
      ),
    )
  }
  return DecorationSet.create(state.doc, decorations)
}

/**
 * Renders every top-level, inline-displayed comment's own small preview
 * chip right after its anchor — the document-level counterpart to the old
 * model's own portal-mounted `InlineCommentBody`, via PM decorations
 * instead of a literal marker element in the content (there's nothing to
 * store for this: `Comment.displayMode` alone decides what renders, fresh
 * every time — see `essayCommentsRepo.ts`'s own `setEssayCommentDisplayMode`).
 *
 * Deliberately a plain, static, non-interactive `<span>` — not a portal-
 * mounted Preact tree the way the old marker's content was. A widget
 * decoration's own DOM gets recreated wholesale on `essay.comments`
 * changing (see `buildDecorations`, re-run from scratch on every apply —
 * cheap, since this only ever walks the doc looking for `comment_anchor`
 * marks), so anything with its own interactive state living *inside* one
 * would risk losing that state — a half-typed reply, an open "comment on
 * this selection" composer — the moment an unrelated keystroke elsewhere
 * in the document triggers a rebuild. Clicking the chip instead opens the
 * exact same `CommentCard` the margin column uses, in a small floating
 * popover that `EssayWorkspace.tsx` renders itself, entirely outside the
 * PM tree — real Preact state, never at risk of a decoration rebuild
 * tearing it down mid-edit. `key: comment.id` on the decoration keeps PM
 * from recreating a chip's own DOM node on every rebuild if its position
 * and id haven't actually changed (see ProseMirror's own docs on
 * `DecorationSpec.key`) — ordinary, resilient-either-way DOM, so even a
 * redundant recreation costs nothing but a reflow.
 *
 * Clicking either this chip or a margin comment's own `comment-anchor`
 * highlight (anywhere in the main text) both route through the one
 * `handleClick` below, which just reports `commentId` back up —
 * `EssayWorkspace.tsx`'s own `handleAnchorClick` decides what "open" means
 * for each (toggle the floating popover vs. scroll/focus the margin card).
 */
export function createCommentPlugin(essayHolder: { current: Essay | null }, onAnchorClick: (commentId: string) => void): Plugin {
  return new Plugin({
    key: commentPluginKey,
    state: {
      init: (_, state) => buildDecorations(state, essayHolder.current),
      apply: (_tr, _old, _oldState, newState) => buildDecorations(newState, essayHolder.current),
    },
    props: {
      decorations(state) {
        return commentPluginKey.getState(state)
      },
      handleClick(_view, _pos, event) {
        const target = event.target as HTMLElement | null
        const previewEl = target?.closest('.inline-comment-preview') as HTMLElement | null
        const commentId = previewEl?.dataset.commentId ?? (target?.closest('comment-anchor') as HTMLElement | null)?.getAttribute('data-comment-id')
        if (!commentId) return false
        onAnchorClick(commentId)
        return true
      },
    },
  })
}
