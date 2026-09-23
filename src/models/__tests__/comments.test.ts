/**
 * Comments live flat on `EssayNode.comments` now (see `Comment`'s own doc
 * comment in models/types.ts) — not per-version — with `parentId` unifying
 * "reply" and "comment on a comment" as children of any comment, and
 * `anchorKind` distinguishing where each one's mark (if it has one at all)
 * actually lives.
 */
import { describe, expect, it } from 'vitest'
import { addComment, commentChildren, commentIdsInContent, commentSubtreeIds, deleteCommentCascade, findCommentById, nodeComments, setCommentResolved, topLevelComments, updateCommentBody } from '../essaysRepo'
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
  it('appends a top-level, text-anchored comment', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'a note', commentId: 'c1' })
    expect(nodeComments(n)).toHaveLength(1)
    expect(findCommentById(n, 'c1')?.body).toBe('a note')
    expect(findCommentById(n, 'c1')?.parentId).toBeNull()
    expect(topLevelComments(n).map((c) => c.id)).toEqual(['c1'])
  })

  it('appends a whole-section comment with no anchor text', async () => {
    await useFakeBackend()
    const n = node('<p>plain text</p>')
    const c = await addComment(n, { anchorKind: 'node', anchorText: '', body: 'comment on the whole section' })
    expect(c.anchorKind).toBe('node')
    expect(c.anchorText).toBe('')
    expect(topLevelComments(n)).toHaveLength(1)
  })

  it('a reply and a comment-on-a-comment both nest as children via parentId', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'root comment', commentId: 'c1' })
    const reply = await addComment(n, { anchorKind: 'reply', anchorText: '', body: 'a reply', parentId: 'c1' })
    const inline = await addComment(n, { anchorKind: 'inline', anchorText: 'root', body: 'comment on the comment', parentId: 'c1' })
    expect(commentChildren(n, 'c1').map((c) => c.id).sort()).toEqual([reply.id, inline.id].sort())
    expect(topLevelComments(n).map((c) => c.id)).toEqual(['c1'])
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

describe('deleteCommentCascade', () => {
  it('deleting a top-level comment recursively removes its replies and comments-on-it', async () => {
    await useFakeBackend()
    const n = node('<mark class="comment-anchor" data-comment-id="c1">anchor</mark>')
    await addComment(n, { anchorKind: 'text', anchorText: 'anchor', body: 'root', commentId: 'c1' })
    const reply = await addComment(n, { anchorKind: 'reply', anchorText: '', body: 'a reply', parentId: 'c1' })
    const grandReply = await addComment(n, { anchorKind: 'reply', anchorText: '', body: 'reply to the reply', parentId: reply.id })
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
    const reply1 = await addComment(n, { anchorKind: 'reply', anchorText: '', body: 'r1', parentId: root.id })
    const reply2 = await addComment(n, { anchorKind: 'reply', anchorText: '', body: 'r2', parentId: root.id })

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
})
