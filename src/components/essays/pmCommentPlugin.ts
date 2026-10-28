import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorState } from 'prosemirror-state'
import { commentAnchorEndPos, commentTextRange } from './pmCommands'
import type { Essay } from '../../models/types'

export const commentPluginKey = new PluginKey<DecorationSet>('comments')

/** The inline-comment action-widget buttons — see `createCommentPlugin`'s own doc comment. `'promote'` dissolves into permanent prose (the pre-existing "promote" feature, otherwise only ever reachable from a margin comment's own card); `'extract'`/`'delete'` are new. */
export type InlineCommentAction = 'resolve' | 'unresolve' | 'extract' | 'promote' | 'delete'

function buildActionWidget(commentId: string, resolved: boolean): HTMLElement {
  const span = document.createElement('span')
  span.className = 'inline-comment-controls'
  span.contentEditable = 'false'
  span.dataset.commentId = commentId
  const buttons: { action: InlineCommentAction; title: string; glyph: string }[] = [
    { action: resolved ? 'unresolve' : 'resolve', title: resolved ? 'Mark unresolved' : 'Mark resolved', glyph: resolved ? '↺' : '✓' },
    { action: 'extract', title: 'Move to the margin', glyph: '→▤' },
    { action: 'promote', title: 'Promote to permanent prose (deletes the comment, keeps the text)', glyph: '⇧¶' },
    { action: 'delete', title: 'Delete this comment', glyph: '×' },
  ]
  for (const { action, title, glyph } of buttons) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'inline-comment-control-btn'
    btn.dataset.commentAction = action
    btn.title = title
    btn.textContent = glyph
    span.appendChild(btn)
  }
  return span
}

function buildDecorations(state: EditorState, essay: Essay | null): DecorationSet {
  if (!essay?.comments?.length) return DecorationSet.empty
  const inlineTopLevel = essay.comments.filter((c) => c.parentId === null && c.anchorKind === 'text' && c.displayMode === 'inline')
  if (!inlineTopLevel.length) return DecorationSet.empty
  const decorations: Decoration[] = []
  for (const comment of inlineTopLevel) {
    const textRange = commentTextRange(state.doc, comment.id)
    const end = textRange?.to ?? commentAnchorEndPos(state.doc, comment.id)
    if (end == null) continue
    if (textRange) {
      decorations.push(
        Decoration.inline(textRange.from, textRange.to, { class: `comment-text${comment.resolved ? ' comment-text-resolved' : ''}` }, { inclusiveEnd: true }),
      )
    }
    decorations.push(Decoration.widget(end, () => buildActionWidget(comment.id, comment.resolved), { key: `${comment.id}:${comment.resolved}`, side: 1 }))
  }
  return DecorationSet.create(state.doc, decorations)
}

/**
 * The original vision for inline comments: a comment's own body is a real,
 * directly-editable run of document content — typed right into the
 * document flow, no popup needed — distinguished from ordinary prose only
 * in being extractable into a margin card (see `pmCommands.ts`'s
 * `extractInlineCommentBody`/`insertInlineCommentBodyFromHtml`) and in
 * never being rendered in export (`lib/export.ts`). This plugin no longer
 * renders any preview of that body itself (there's nothing to preview — the
 * body *is* the document, visible via the `comment-text` CSS class this
 * applies, `styles.css`) — it contributes exactly two things:
 *
 * - A `Decoration.inline` over each inline top-level comment's own
 *   `comment_text` range, purely for visual styling (including a resolved
 *   look) — the mark itself already carries the comment's identity; this
 *   decoration adds nothing structural, so toggling `resolved` never needs
 *   a document-mutating transaction, just this decoration set rebuilding
 *   (see `EssayWorkspace.tsx`'s own `notifyCommentsChanged`).
 * - A small, always-visible cluster of action buttons (resolve/extract/
 *   promote/delete) right after that range, via `Decoration.widget` — kept
 *   as plain, static DOM (not a portal-mounted Preact tree) for the same
 *   reason the old preview chip was: a widget's own DOM gets recreated
 *   wholesale on `essay.comments` changing (see `buildDecorations`, re-run
 *   from scratch on every apply), so nothing with its own interactive state
 *   should live inside one. `key: "<id>:<resolved>"` keeps PM from
 *   recreating a cluster's own DOM node when neither its identity nor its
 *   resolved state actually changed.
 *
 * Clicking a margin comment's own `comment-anchor` highlight (anywhere in
 * the main text) still routes through `onAnchorClick`, same as always — it
 * just scrolls/focuses the margin card now (`EssayWorkspace.tsx`'s own
 * `handleAnchorClick`), since there's no more inline popover to toggle
 * open. Clicking one of this plugin's own action buttons instead reports
 * `(commentId, action)` through `onInlineAction` — `EssayWorkspace.tsx`'s
 * own `handleInlineCommentAction` decides what each one actually does.
 */
export function createCommentPlugin(
  essayHolder: { current: Essay | null },
  onAnchorClick: (commentId: string) => void,
  onInlineAction: (commentId: string, action: InlineCommentAction) => void,
): Plugin {
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
        const actionBtn = target?.closest('.inline-comment-control-btn') as HTMLElement | null
        if (actionBtn) {
          const commentId = (actionBtn.closest('.inline-comment-controls') as HTMLElement | null)?.dataset.commentId
          const action = actionBtn.dataset.commentAction as InlineCommentAction | undefined
          if (commentId && action) onInlineAction(commentId, action)
          return true
        }
        const commentId = (target?.closest('comment-anchor') as HTMLElement | null)?.getAttribute('data-comment-id')
        if (!commentId) return false
        onAnchorClick(commentId)
        return true
      },
    },
  })
}
