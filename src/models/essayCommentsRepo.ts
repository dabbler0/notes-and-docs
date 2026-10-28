/**
 * Essay-level comment CRUD — the Stage B3 counterpart to `essaysRepo.ts`'s
 * own `nodeComments`/`addComment`/`updateCommentBody`/`setCommentResolved`/
 * `setCommentDisplayMode`/`promoteInlineComment`/`deleteCommentCascade`
 * family, reading and writing `essay.comments` (flat, keyed by
 * `sectionId` for a top-level comment — see `Comment`'s own doc comment in
 * `models/types.ts`) instead of whichever `EssayNode`'s own array a
 * pre-migration comment happened to sit in. The old per-node functions are
 * untouched — still needed for as long as `EssayNode.comments` data exists
 * in storage/backups.
 *
 * Deliberately pure data here, same division of labor the old model
 * already had: nothing in this module ever touches the live document.
 * Everything that needs to — wrapping a selection in a `comment_anchor`
 * mark, stripping one back out, splicing a promoted comment's body in as
 * real content — lives in `pmCommands.ts` (the PM-transaction layer) and
 * `essayCommentActions.ts` (the thin glue between the two), since
 * ProseMirror's own `EditorState` is always already the live source of
 * truth — unlike the old `contentEditable` shards, there's no separate
 * "reconstruct from the live DOM first" step any action here needs to
 * start with.
 */
import { id } from '../lib/id'
import { saveEssay } from './essaysRepo'
import type { Comment, Essay } from './types'

/** `essay.comments` is optional (absent on an essay not yet touched by a comment) — this is the one place that reads it directly, so "absent" and "empty" are treated identically everywhere else. */
export function essayComments(essay: Essay): Comment[] {
  return essay.comments ?? []
}

/** Every comment anchored directly to a section or to its own text — i.e. every comment that isn't a reply or a comment-on-a-comment. */
export function topLevelEssayComments(essay: Essay): Comment[] {
  return essayComments(essay).filter((c) => c.parentId === null)
}

/** The replies and comments-on-a-comment nested directly under `commentId` (one level — a caller walking a full thread recurses using this). */
export function essayCommentChildren(essay: Essay, commentId: string): Comment[] {
  return essayComments(essay).filter((c) => c.parentId === commentId)
}

export function findEssayCommentById(essay: Essay, commentId: string): Comment | undefined {
  return essayComments(essay).find((c) => c.id === commentId)
}

/** `commentId` itself, plus every comment nested under it at any depth — the set `deleteEssayCommentCascade` removes. */
export function essayCommentSubtreeIds(essay: Essay, commentId: string): string[] {
  const all = essayComments(essay)
  const result: string[] = []
  const stack = [commentId]
  while (stack.length) {
    const cid = stack.pop()!
    result.push(cid)
    for (const c of all) if (c.parentId === cid) stack.push(c.id)
  }
  return result
}

export async function addEssayComment(
  essay: Essay,
  opts: { anchorKind: Comment['anchorKind']; anchorText: string; body: string; sectionId?: string | null; parentId?: string | null; commentId?: string; displayMode?: 'margin' | 'inline' },
): Promise<Comment> {
  const now = Date.now()
  const comment: Comment = {
    id: opts.commentId ?? id(),
    parentId: opts.parentId ?? null,
    sectionId: opts.parentId == null ? (opts.sectionId ?? null) : null,
    anchorKind: opts.anchorKind,
    anchorText: opts.anchorText,
    body: opts.body,
    displayMode: opts.parentId == null && opts.anchorKind === 'text' ? (opts.displayMode ?? 'margin') : undefined,
    resolved: false,
    createdAt: now,
    updatedAt: now,
  }
  essay.comments = [...essayComments(essay), comment]
  await saveEssay(essay)
  return comment
}

export async function updateEssayCommentBody(essay: Essay, commentId: string, body: string): Promise<void> {
  const comment = findEssayCommentById(essay, commentId)
  if (!comment) return
  comment.body = body
  comment.updatedAt = Date.now()
  await saveEssay(essay)
}

export async function setEssayCommentResolved(essay: Essay, commentId: string, resolved: boolean): Promise<void> {
  const comment = findEssayCommentById(essay, commentId)
  if (!comment) return
  comment.resolved = resolved
  await saveEssay(essay)
}

/**
 * Switches a top-level, `'text'`-anchored comment between margin and
 * inline display, together with the `body` that goes with each: an inline
 * comment's own body lives as real, directly-editable document content
 * (a `comment_text`-marked span right after its anchor — see
 * `pmSchema.ts`'s own doc comment on that mark), so converting *to* inline
 * clears the stored `body` (nothing left to keep here once it's live doc
 * content) and converting *to* margin is handed the body extracted back
 * out of the document. Pure data either way — actually moving the content
 * into or out of the live document is the caller's job
 * (`essayCommentActions.ts`'s `convertEssayCommentDisplayMode`, which has
 * `view` access), same division of labor every other document-touching
 * action in this module already follows. No-op for a comment that isn't a
 * top-level `'text'` comment, same restriction the old model had.
 */
export async function setEssayCommentBodyAndMode(essay: Essay, commentId: string, mode: 'margin' | 'inline', body: string): Promise<void> {
  const comment = findEssayCommentById(essay, commentId)
  if (!comment || comment.anchorKind !== 'text' || comment.parentId !== null) return
  comment.displayMode = mode
  comment.body = body
  comment.updatedAt = Date.now()
  await saveEssay(essay)
}

/** Removes just the `<mark class="comment-anchor" data-comment-id="commentId">` wrapper from a comment body's own HTML, keeping whatever text/markup it wrapped in place. Ported verbatim from `essaysRepo.ts`'s own (still-used, for pre-migration data) `unwrapCommentMark`. */
function unwrapCommentMarkHtml(html: string, commentId: string): string {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const mark = doc.querySelector(`mark.comment-anchor[data-comment-id="${cssEscapeId(commentId)}"]`)
  if (!mark) return html
  mark.replaceWith(...Array.from(mark.childNodes))
  return doc.body.innerHTML
}

function cssEscapeId(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/**
 * Dissolves a top-level, inline-displayed comment back into ordinary
 * prose: drops its own record (promoting anything nested directly under
 * it — replies, comments-on-it — up to top-level, same as the old
 * model's own `promoteInlineComment`) and hands back its `body` HTML for
 * the caller (`essayCommentActions.ts`) to splice into the live document
 * as real content and unwrap the anchor mark from — both genuinely PM
 * operations, so they don't belong in this pure-data module. Returns
 * `null` for anything that isn't a promotable top-level comment.
 */
export async function promoteEssayInlineComment(essay: Essay, commentId: string): Promise<{ bodyHtml: string; sectionId: string | null } | null> {
  const comment = findEssayCommentById(essay, commentId)
  if (!comment || comment.parentId !== null) return null
  const bodyHtml = comment.body
  const sectionId = comment.sectionId ?? null
  for (const child of essayCommentChildren(essay, commentId)) {
    child.parentId = null
    child.anchorKind = 'text'
    child.sectionId = sectionId
    if (!child.displayMode) child.displayMode = 'margin'
  }
  essay.comments = essayComments(essay).filter((c) => c.id !== commentId)
  await saveEssay(essay)
  return { bodyHtml, sectionId }
}

/**
 * Deletes `commentId` and every comment nested under it, at any depth.
 * Also cleans up a deleted `'inline'`-anchorKind comment's own mark out of
 * whichever *surviving* comment's `body` it sat inside (pure string
 * surgery, same as the old model). A deleted top-level `'text'` comment's
 * mark lives in the *main document* instead — stripping that is the
 * caller's job (`essayCommentActions.ts`, which has `view` access), same
 * division of labor the old model's own `deleteCommentCascade` documented
 * (there, "the live, mounted DOM shard"; here, the live `EditorView`).
 * Returns the ids of every deleted top-level `'text'` comment so the
 * caller knows which marks to strip.
 */
export async function deleteEssayCommentCascade(essay: Essay, commentId: string): Promise<{ deletedTextIds: string[] }> {
  const all = essayComments(essay)
  const toDelete = new Set(essayCommentSubtreeIds(essay, commentId))
  const deletedTextIds = all.filter((c) => toDelete.has(c.id) && c.anchorKind === 'text').map((c) => c.id)
  const deletedInlineIds = all.filter((c) => toDelete.has(c.id) && c.anchorKind === 'inline').map((c) => c.id)

  const kept = all.filter((c) => !toDelete.has(c.id))
  for (const c of kept) {
    let body = c.body
    for (const cid of deletedInlineIds) body = unwrapCommentMarkHtml(body, cid)
    c.body = body
  }
  essay.comments = kept
  await saveEssay(essay)
  return { deletedTextIds }
}
