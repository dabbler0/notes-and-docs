/**
 * Comments live flat on `EssayNode.comments` now (see `Comment`'s own doc
 * comment in models/types.ts) — not per-version — with `parentId` unifying
 * a reply and a comment-on-a-comment as children of any comment (both are
 * `anchorKind: 'inline'`, a reply just anchored to an empty mark), and
 * `displayMode` distinguishing a top-level comment shown in the margin from
 * one shown inline, in the document's own text flow.
 */
import { describe, expect, it } from 'vitest'
import {
  addComment,
  commentChildren,
  commentIdsInContent,
  commentSubtreeIds,
  deleteCommentCascade,
  findCommentById,
  nodeComments,
  promoteInlineComment,
  setCommentDisplayMode,
  setCommentResolved,
  topLevelComments,
  updateCommentBody,
} from '../essaysRepo'
import type { EssayNode } from '../types'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

async function useFakeBackend() {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
}

function node(content: string): EssayNode {
  return {
    id: 'n1',
    essayId: 'e1',
    title: 'Section',
    versions: [{ id: 'v1', content, createdAt: 0 }],
    headVersionId: 'v1',
    draftContent: content,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('commentIdsInContent', () => {
  it('returns an empty array for empty/no markup', () => {
    expect(commentIdsInContent('')).toEqual([])
    expect(commentIdsInContent('<p>plain text, no comments</p>')).toEqual([])
  })

  it('extracts every data-comment-id in document order, duplicates included', () => {
    const html = '<p>a <mark data-comment-id="c1">b</mark> c</p><p><mark data-comment-id="c2">d</mark></p>'
    expect(commentIdsInContent(html)).toEqual(['c1', 'c2'])
  })
})

describe('addComment / nodeComments / findCommentById', () => {
  it('appends a top-level, text-anchored comment, defaulting to margin display', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'a note', commentId: 'c1' })
    expect(nodeComments(n)).toHaveLength(1)
    expect(findCommentById(n, 'c1')?.body).toBe('a note')
    expect(findCommentById(n, 'c1')?.parentId).toBeNull()
    expect(findCommentById(n, 'c1')?.displayMode).toBe('margin')
    expect(topLevelComments(n).map((c) => c.id)).toEqual(['c1'])
  })

  it('appends a top-level comment with displayMode: inline, anchored to an empty mark', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1"></mark><span class="inline-comment-marker" data-comment-id="c1"></span>')
    const c = await addComment(n, { anchorKind: 'text', anchorText: '', body: 'right here', commentId: 'c1', displayMode: 'inline' })
    expect(c.displayMode).toBe('inline')
    expect(c.anchorText).toBe('')
  })

  it('a reply and a comment-on-a-comment both nest as children via parentId, and neither carries its own displayMode', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'root comment', commentId: 'c1' })
    const reply = await addComment(n, { anchorKind: 'inline', anchorText: '', body: 'a reply', parentId: 'c1' })
    const onComment = await addComment(n, { anchorKind: 'inline', anchorText: 'root', body: 'comment on the comment', parentId: 'c1' })
    expect(commentChildren(n, 'c1').map((c) => c.id).sort()).toEqual([reply.id, onComment.id].sort())
    expect(topLevelComments(n).map((c) => c.id)).toEqual(['c1'])
    expect(reply.displayMode).toBeUndefined()
    expect(onComment.displayMode).toBeUndefined()
  })
})

describe('updateCommentBody / setCommentResolved', () => {
  it('edits an existing comment body and bumps updatedAt', async () => {
    await useFakeBackend()
    const n = node('')
    const c = await addComment(n, { anchorKind: 'node', anchorText: '', body: 'first draft' })
    await updateCommentBody(n, c.id, 'edited body')
    const found = findCommentById(n, c.id)
    expect(found?.body).toBe('edited body')
    expect(found?.updatedAt).toBeGreaterThanOrEqual(found!.createdAt)
  })

  it('toggles resolved', async () => {
    await useFakeBackend()
    const n = node('')
    const c = await addComment(n, { anchorKind: 'node', anchorText: '', body: 'x' })
    expect(findCommentById(n, c.id)?.resolved).toBe(false)
    await setCommentResolved(n, c.id, true)
    expect(findCommentById(n, c.id)?.resolved).toBe(true)
  })
})

describe('setCommentDisplayMode', () => {
  it('switching to inline inserts a .inline-comment-marker marker right after the anchor mark', async () => {
    await useFakeBackend()
    const n = node('before <mark class="comment-anchor" data-comment-id="c1">anchor</mark> after')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'x', commentId: 'c1' })
    await setCommentDisplayMode(n, 'c1', 'inline')
    expect(findCommentById(n, 'c1')?.displayMode).toBe('inline')
    expect(n.draftContent).toContain('<mark class="comment-anchor" data-comment-id="c1">anchor</mark><span class="inline-comment-marker" data-comment-id="c1"')
  })

  it('is idempotent — switching to inline twice does not duplicate the marker', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'x', commentId: 'c1' })
    await setCommentDisplayMode(n, 'c1', 'inline')
    await setCommentDisplayMode(n, 'c1', 'inline')
    expect(n.draftContent.match(/inline-comment-marker/g)).toHaveLength(1)
  })

  it('switching back to margin removes the marker but leaves the anchor mark untouched', async () => {
    await useFakeBackend()
    const n = node('before <mark class="comment-anchor" data-comment-id="c1">anchor</mark> after')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'x', commentId: 'c1' })
    await setCommentDisplayMode(n, 'c1', 'inline')
    await setCommentDisplayMode(n, 'c1', 'margin')
    expect(findCommentById(n, 'c1')?.displayMode).toBe('margin')
    expect(n.draftContent).not.toContain('inline-comment-marker')
    expect(n.draftContent).toContain('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
  })

  it('is a no-op for a nested comment or a node-level comment', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'root', commentId: 'c1' })
    const reply = await addComment(n, { anchorKind: 'inline', anchorText: '', body: 'r', parentId: 'c1' })
    const whole = await addComment(n, { anchorKind: 'node', anchorText: '', body: 'whole section' })
    await setCommentDisplayMode(n, reply.id, 'inline')
    await setCommentDisplayMode(n, whole.id, 'inline')
    expect(findCommentById(n, reply.id)?.displayMode).toBeUndefined()
    expect(findCommentById(n, whole.id)?.displayMode).toBeUndefined()
  })
})

describe('promoteInlineComment', () => {
  it('splices the body into ordinary text, unwraps the anchor mark, and drops the comment record', async () => {
    await useFakeBackend()
    const n = node('before <mark class="comment-anchor" data-comment-id="c1">anchor</mark> after')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'my commentary', commentId: 'c1', displayMode: 'inline' })
    await setCommentDisplayMode(n, 'c1', 'inline') // inserts the marker the way the UI would before promoting
    await promoteInlineComment(n, 'c1')
    // No space is inserted between the unwrapped anchor text and the
    // promoted body — same as every other insertion point in this app,
    // that's left to the user/existing markup, not synthesized here.
    expect(n.draftContent).toBe('before anchormy commentary after')
    expect(findCommentById(n, 'c1')).toBeUndefined()
  })

  it('moves direct comments-on-comments up to top-level text comments on the section, marks now sitting in the promoted text', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1"></mark>')
    await addComment(n, {
      anchorKind: 'text',
      anchorText: '',
      body: 'commentary with <mark class="comment-anchor" data-comment-id="c2">a highlighted bit</mark> inside it',
      commentId: 'c1',
      displayMode: 'inline',
    })
    await setCommentDisplayMode(n, 'c1', 'inline')
    const onComment = await addComment(n, { anchorKind: 'inline', anchorText: 'a highlighted bit', body: 'nested note', parentId: 'c1', commentId: 'c2' })
    const grandchild = await addComment(n, { anchorKind: 'inline', anchorText: '', body: 'reply to the nested note', parentId: 'c2' })

    await promoteInlineComment(n, 'c1')

    const promoted = findCommentById(n, 'c2')
    expect(promoted?.parentId).toBeNull()
    expect(promoted?.anchorKind).toBe('text')
    expect(promoted?.displayMode).toBe('margin')
    expect(n.draftContent).toContain('a highlighted bit')
    // The grandchild (nested two levels under the promoted comment) stays exactly where it was — still a child of c2, which still exists.
    expect(findCommentById(n, grandchild.id)?.parentId).toBe('c2')
    expect(onComment.id).toBe('c2')
  })
})

describe('deleteCommentCascade', () => {
  it('deleting a top-level comment recursively removes its replies and comments-on-it', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'root', commentId: 'c1' })
    const reply = await addComment(n, { anchorKind: 'inline', anchorText: '', body: 'a reply', parentId: 'c1' })
    const grandReply = await addComment(n, { anchorKind: 'inline', anchorText: '', body: 'reply to the reply', parentId: reply.id })
    await addComment(n, { anchorKind: 'inline', anchorText: 'root', body: 'nested comment', parentId: 'c1' })

    expect(commentSubtreeIds(n, 'c1')).toHaveLength(4)
    await deleteCommentCascade(n, 'c1')
    expect(nodeComments(n)).toEqual([])
    expect(findCommentById(n, reply.id)).toBeUndefined()
    expect(findCommentById(n, grandReply.id)).toBeUndefined()
  })

  it('deleting a reply leaves its parent and siblings intact', async () => {
    await useFakeBackend()
    const n = node('')
    const root = await addComment(n, { anchorKind: 'node', anchorText: '', body: 'root' })
    const reply1 = await addComment(n, { anchorKind: 'inline', anchorText: '', body: 'r1', parentId: root.id })
    const reply2 = await addComment(n, { anchorKind: 'inline', anchorText: '', body: 'r2', parentId: root.id })

    await deleteCommentCascade(n, reply1.id)
    expect(findCommentById(n, root.id)).toBeDefined()
    expect(findCommentById(n, reply1.id)).toBeUndefined()
    expect(findCommentById(n, reply2.id)).toBeDefined()
  })

  it('unwraps the deleted comment\'s own mark from the section content ("text") or its parent\'s body ("inline"), keeping the underlying text', async () => {
    await useFakeBackend()
    const n = node('before <mark class="comment-anchor" data-comment-id="c1">anchor</mark> after')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'root', commentId: 'c1' })
    await deleteCommentCascade(n, 'c1')
    expect(n.draftContent).toBe('before anchor after')

    const n2 = node('')
    const root = await addComment(n2, { anchorKind: 'node', anchorText: '', body: 'before <mark class="comment-anchor" data-comment-id="c2">span</mark> after' })
    await addComment(n2, { anchorKind: 'inline', anchorText: 'span', body: 'nested', parentId: root.id, commentId: 'c2' })
    await deleteCommentCascade(n2, 'c2')
    expect(findCommentById(n2, root.id)?.body).toBe('before span after')
  })

  it('also removes the .inline-comment-marker marker for a deleted comment that was displayed inline', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'x', commentId: 'c1' })
    await setCommentDisplayMode(n, 'c1', 'inline')
    await deleteCommentCascade(n, 'c1')
    expect(n.draftContent).not.toContain('inline-comment-marker')
  })
})

describe('migrating a node still carrying the old per-version comments shape', () => {
  it('flattens version-scoped comments into node.comments the first time they are read', async () => {
    await useFakeBackend()
    const n = node('<mark data-comment-id="c1">anchor</mark>') as unknown as EssayNode & { versions: { comments?: unknown[] }[] }
    delete (n as unknown as { comments?: unknown }).comments
    n.versions[0].comments = [{ id: 'c1', anchorText: 'anchor', body: 'old-style comment', resolved: false, createdAt: 5 }]
    const flat = nodeComments(n)
    expect(flat).toHaveLength(1)
    expect(flat[0].id).toBe('c1')
    expect(flat[0].parentId).toBeNull()
    expect(flat[0].anchorKind).toBe('text')
  })

  it('migrates an old anchorKind: "reply" comment into anchorKind: "inline", appending an empty mark to its parent\'s body', async () => {
    await useFakeBackend()
    const n = node('<mark data-comment-id="c1">anchor</mark>') as unknown as EssayNode & { versions: { comments?: unknown[] }[] }
    delete (n as unknown as { comments?: unknown }).comments
    n.versions[0].comments = [
      { id: 'c1', anchorText: 'anchor', body: 'root comment', resolved: false, createdAt: 5 },
      { id: 'c2', parentId: 'c1', anchorKind: 'reply', anchorText: '', body: 'an old reply', resolved: false, createdAt: 6 },
    ]
    const flat = nodeComments(n)
    const migratedReply = flat.find((c) => c.id === 'c2')
    expect(migratedReply?.anchorKind).toBe('inline')
    const parent = flat.find((c) => c.id === 'c1')
    expect(parent?.body).toContain('<mark class="comment-anchor" data-comment-id="c2"></mark>')
  })
})
