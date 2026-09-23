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
    // addFootnote's own doc comment: the caller is responsible for also
    // inserting the marker into the live content before saving — a
    // footnote whose marker was never actually placed anywhere is
    // (correctly, as of the orphan-pruning fix below) indistinguishable
    // from one whose marker has since been deleted, and saveNode would
    // otherwise prune it away immediately.
    node.draftContent += `<sup class="footnote-ref" data-footnote-id="${footnote.id}">​</sup>`
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

describe('saveNode auto-pruning orphaned footnotes', () => {
  it('keeps a footnote whose marker is still in the live draft', async () => {
    const node = oldFormatNode()
    const footnote = addFootnote(node)
    node.draftContent = `text<sup class="footnote-ref" data-footnote-id="${footnote.id}">​</sup>`
    await saveNode(node)
    expect(nodeFootnotes(node)).toHaveLength(1)
    const reloaded = await getNode('n1')
    expect(nodeFootnotes(reloaded!)).toHaveLength(1)
  })

  it('drops a footnote once its marker is deleted from the text and nothing else references it', async () => {
    const node = oldFormatNode()
    const footnote = addFootnote(node)
    node.draftContent = `text<sup class="footnote-ref" data-footnote-id="${footnote.id}">​</sup>`
    await saveNode(node)
    expect(nodeFootnotes(node)).toHaveLength(1)

    // The user deletes the superscript from the text — this is the actual
    // reported bug: without pruning, the footnote lingered forever with no
    // way back to it except a separate "delete footnote" button.
    node.draftContent = 'text'
    await saveNode(node)
    expect(nodeFootnotes(node)).toEqual([])
    const reloaded = await getNode('n1')
    expect(nodeFootnotes(reloaded!)).toEqual([])
  })

  it('keeps a footnote whose marker only survives in an older saved version, not the live draft', async () => {
    // Mirrors "Make a new version": the frozen version's own content still
    // has the marker, but the live draft was cleared for fresh writing.
    // Footnotes aren't per-version data (see pruneOrphanedFootnotes' own
    // doc comment) — reverting to that old version needs this footnote's
    // body to still exist.
    const node = oldFormatNode()
    const footnote = addFootnote(node)
    const markerHtml = `<sup class="footnote-ref" data-footnote-id="${footnote.id}">​</sup>`
    node.draftContent = `frozen text${markerHtml}`
    node.versions = [{ id: 'v1', content: `frozen text${markerHtml}`, comments: [], createdAt: 0 }]
    node.headVersionId = 'v1'
    await saveNode(node) // establishes the version as the current save

    node.draftContent = '' // "Make a new version" clears the draft
    await saveNode(node)

    expect(nodeFootnotes(node)).toHaveLength(1)
    const reloaded = await getNode('n1')
    expect(nodeFootnotes(reloaded!)).toHaveLength(1)
  })
})
