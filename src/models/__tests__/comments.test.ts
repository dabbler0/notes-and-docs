/**
 * A comment's own data lives on whichever version was head when it was
 * added (`addComment`'s `versionId` argument) — but `commitNewVersion`
 * always starts a fresh version's `comments` array empty (see `makeVersion`
 * in `essaysRepo.ts`), even though the version's own `content` snapshot
 * carries the comment's `<mark data-comment-id>` right along with it. So a
 * comment can go on being anchored in the *current* content while its own
 * record sits on an older, no-longer-head version. `commentIdsInContent`
 * and `findComment` are what let a caller (`CommentsPanel`,
 * `SectionBlock`'s open-comment-count badge) reunite the two: "what marks
 * are actually in the document right now" and "who recorded this one, and
 * is that still the current version."
 */
import { describe, expect, it } from 'vitest'
import { addComment, commentIdsInContent, commitNewVersion, findComment } from '../essaysRepo'
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
    versions: [{ id: 'v1', content, comments: [], createdAt: 0 }],
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

describe('findComment', () => {
  it('finds a comment recorded on a non-head version', async () => {
    await useFakeBackend()
    const n = node('<mark data-comment-id="c1">hi</mark>')
    await addComment(n, 'v1', 'hi', 'a note', 'c1')
    const v2 = await commitNewVersion(n, 'v2')
    expect(n.headVersionId).toBe(v2.id)
    const found = findComment(n, 'c1')
    expect(found?.version.id).toBe('v1')
    expect(found?.comment.body).toBe('a note')
  })

  it('returns undefined for an id that was never recorded', async () => {
    await useFakeBackend()
    expect(findComment(node(''), 'missing')).toBeUndefined()
  })
})

describe('the cross-version persistence scenario end to end', () => {
  it('a comment whose mark survives a new version is still findable via the current content, marked stale', async () => {
    await useFakeBackend()
    const n = node('before <mark class="comment-anchor" data-comment-id="c1">anchor</mark> after')
    await addComment(n, 'v1', 'anchor', 'still relevant', 'c1')

    // A later, unrelated edit commits a new version — the mark rides along
    // in draftContent/the new version's content, but the new version's own
    // comments array starts empty.
    n.draftContent = 'before <mark class="comment-anchor" data-comment-id="c1">anchor</mark> after, plus more text'
    const v2 = await commitNewVersion(n, 'v2')
    expect(v2.comments).toEqual([])

    const ids = commentIdsInContent(n.draftContent)
    expect(ids).toContain('c1')
    const found = findComment(n, 'c1')
    expect(found).toBeDefined()
    expect(found!.comment.body).toBe('still relevant')
    // Stale: the comment's own version (v1) is no longer the node's head.
    expect(found!.version.id).not.toBe(n.headVersionId)
  })

  it('a comment whose mark was edited out of the content is no longer found among current ids', async () => {
    await useFakeBackend()
    const n = node('before <mark data-comment-id="c1">anchor</mark> after')
    await addComment(n, 'v1', 'anchor', 'note', 'c1')

    // The user deletes the commented-on text (mark and all) and commits.
    n.draftContent = 'before  after'
    await commitNewVersion(n, 'v2')

    expect(commentIdsInContent(n.draftContent)).toEqual([])
  })
})
