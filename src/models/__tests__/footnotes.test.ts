/**
 * essaysRepo's footnote helpers, with particular attention to a node saved
 * before footnotes existed at all — no `footnotes` field on the object,
 * not even `undefined` assigned to it (exactly what a plain object literal
 * built by an older version of this code, or restored from an old backup,
 * would look like).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { addFootnote, deleteFootnote, getNode, nodeFootnotes, saveNode, updateFootnoteContent } from '../essaysRepo'
import type { EssayNode } from '../types'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

function oldFormatNode(): EssayNode {
  // Deliberately built without a `footnotes` key at all — TypeScript
  // allows this since the field is optional, but the real-world case this
  // stands in for is a plain JSON object (from IndexedDB, a sync pull, or
  // a restored backup) that simply predates the field's existence.
  return {
    id: 'n1',
    essayId: 'e1',
    title: 'Old section',
    versions: [{ id: 'v1', content: 'text', comments: [], createdAt: 0 }],
    headVersionId: 'v1',
    draftContent: 'text',
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('footnotes on a node with no footnotes field at all', () => {
  it('nodeFootnotes() reads it as an empty array rather than throwing', () => {
    expect(nodeFootnotes(oldFormatNode())).toEqual([])
  })

  it('addFootnote() initializes the array from scratch', () => {
    const node = oldFormatNode()
    const footnote = addFootnote(node)
    expect(node.footnotes).toEqual([{ id: footnote.id, content: '' }])
  })

  it('a node round-tripped through the backend with no footnotes field loads back the same way', async () => {
    const node = oldFormatNode()
    await saveNode(node)
    const loaded = await getNode('n1')
    expect(loaded).toBeDefined()
    expect('footnotes' in loaded!).toBe(false)
    expect(nodeFootnotes(loaded!)).toEqual([])
  })
})

describe('addFootnote / updateFootnoteContent / deleteFootnote', () => {
  it('adds, edits, and removes a footnote', async () => {
    const node = oldFormatNode()
    const footnote = addFootnote(node)
    await saveNode(node)

    await updateFootnoteContent(node, footnote.id, '<p>Now it has content.</p>')
    expect(nodeFootnotes(node)[0].content).toBe('<p>Now it has content.</p>')

    await deleteFootnote(node, footnote.id)
    expect(nodeFootnotes(node)).toEqual([])

    const reloaded = await getNode('n1')
    expect(nodeFootnotes(reloaded!)).toEqual([])
  })

  it('updateFootnoteContent on an unknown id is a harmless no-op', async () => {
    const node = oldFormatNode()
    await expect(updateFootnoteContent(node, 'nonexistent', 'x')).resolves.toBeUndefined()
  })
})
