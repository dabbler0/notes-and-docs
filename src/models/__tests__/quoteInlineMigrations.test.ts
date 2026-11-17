import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { createFakeBackend } from '../../test/fakeBackend'
import { diffSnapshots, reconstructSnapshotText } from '../../lib/essayHistory'
import { pmSnapshotText } from '../../lib/pmMigration'
import { essaySchema } from '../../lib/pmSchema'
import { removeQuoteInlineMarks } from '../quoteInlineMigrations'
import type { Essay, EssayCommitEntry, Slideshow } from '../types'

function essay(overrides: Partial<Essay> & { id: string; rootNodeId: string }): Essay {
  return { title: 'Essay', createdAt: 0, updatedAt: 0, ...overrides }
}

function slideshow(overrides: Partial<Slideshow> & { id: string }): Slideshow {
  return { title: 'Deck', doc: { type: 'doc', content: [] }, createdAt: 0, updatedAt: 0, ...overrides }
}

function docWithQuoteInline(): unknown {
  return {
    type: 'doc',
    content: [
      {
        type: 'section',
        attrs: { id: 'root' },
        content: [
          { type: 'section_title', content: [{ type: 'text', text: 'My Essay' }] },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'before ' },
              { type: 'text', text: '"quoted"', marks: [{ type: 'quote_inline', attrs: { sourceId: 's1', page: 1 } }] },
              { type: 'text', text: ' after' },
            ],
          },
        ],
      },
    ],
  }
}

describe('removeQuoteInlineMarks — essays', () => {
  it('strips the quote_inline mark from a live essay.doc, leaving the text itself untouched', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root', doc: docWithQuoteInline() }))

    await removeQuoteInlineMarks.run(docs)

    const result = (await docs.list<Essay>('essays')).find((e) => e.id === 'e1')!
    expect(JSON.stringify(result.doc)).not.toContain('quote_inline')
    const pm = PMNode.fromJSON(essaySchema, result.doc) // throws if the dead mark is still there
    expect(pm.textContent).toContain('"quoted"')
  })

  it('also strips it from the essay\'s entire essayHistory commit chain, so reverting into an old commit never throws on the dead mark', async () => {
    const { docs } = createFakeBackend()
    const doc = docWithQuoteInline()
    const text = pmSnapshotText({ title: 'My Essay', doc })
    await docs.put('essayHistory', { id: 'c0', essayId: 'e1', seq: 0, createdAt: 0, kind: 'migrated' as const, patch: diffSnapshots('', text) })
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root', doc }))

    await removeQuoteInlineMarks.run(docs)

    const commits = (await docs.list<EssayCommitEntry>('essayHistory')).filter((c) => c.essayId === 'e1')
    expect(commits).toHaveLength(1)
    const historyText = reconstructSnapshotText(commits, 0)
    expect(historyText).not.toContain('quote_inline')
    const snapshot = JSON.parse(historyText)
    const pm = PMNode.fromJSON(essaySchema, snapshot.doc) // throws if the dead mark is still there
    expect(pm.textContent).toContain('"quoted"')
  })

  it('rewrites a multi-commit history chain consistently, preserving each commit\'s own reconstructed content', async () => {
    const { docs } = createFakeBackend()
    const docV1 = docWithQuoteInline()
    const text1 = pmSnapshotText({ title: 'My Essay', doc: docV1 })
    const docV2 = JSON.parse(JSON.stringify(docV1))
    docV2.content[0].content[1].content[2] = { type: 'text', text: ' after, extended' }
    const text2 = pmSnapshotText({ title: 'My Essay', doc: docV2 })
    await docs.put('essayHistory', { id: 'c0', essayId: 'e1', seq: 0, createdAt: 0, kind: 'migrated' as const, patch: diffSnapshots('', text1) })
    await docs.put('essayHistory', { id: 'c1', essayId: 'e1', seq: 1, createdAt: 1, kind: 'commit' as const, patch: diffSnapshots(text1, text2) })
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root', doc: docV2 }))

    await removeQuoteInlineMarks.run(docs)

    const commits = (await docs.list<EssayCommitEntry>('essayHistory')).filter((c) => c.essayId === 'e1').sort((a, b) => a.seq - b.seq)
    expect(commits).toHaveLength(2)
    const snapshot0 = JSON.parse(reconstructSnapshotText(commits, 0))
    const snapshot1 = JSON.parse(reconstructSnapshotText(commits, 1))
    expect(JSON.stringify(snapshot0)).not.toContain('quote_inline')
    expect(JSON.stringify(snapshot1)).not.toContain('quote_inline')
    expect(PMNode.fromJSON(essaySchema, snapshot0.doc).textContent).toBe('My Essaybefore "quoted" after')
    expect(PMNode.fromJSON(essaySchema, snapshot1.doc).textContent).toBe('My Essaybefore "quoted" after, extended')
  })

  it('is a no-op for an essay that never used an inline quote (idempotent)', async () => {
    const { docs } = createFakeBackend()
    const doc = { type: 'doc', content: [{ type: 'section', attrs: { id: 'root' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'My Essay' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'plain text' }] }] }] }
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root', doc }))

    await removeQuoteInlineMarks.run(docs)

    const result = (await docs.list<Essay>('essays')).find((e) => e.id === 'e1')!
    expect(result.doc).toEqual(doc)
  })

  it('skips an essay with no doc at all', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root' }))
    await expect(removeQuoteInlineMarks.run(docs)).resolves.toBeUndefined()
  })
})

describe('removeQuoteInlineMarks — slideshows', () => {
  it("strips the quote_inline mark from a live slideshow.doc", async () => {
    const { docs } = createFakeBackend()
    await docs.put('slideshows', slideshow({ id: 'd1', doc: docWithQuoteInline() }))

    await removeQuoteInlineMarks.run(docs)

    const result = (await docs.list<Slideshow>('slideshows')).find((d) => d.id === 'd1')!
    expect(JSON.stringify(result.doc)).not.toContain('quote_inline')
    const pm = PMNode.fromJSON(essaySchema, result.doc) // throws if the dead mark is still there
    expect(pm.textContent).toContain('"quoted"')
  })

  it('is a no-op for a slideshow that never used an inline quote (idempotent)', async () => {
    const { docs } = createFakeBackend()
    const doc = { type: 'doc', content: [{ type: 'section', attrs: { id: 'root' }, content: [{ type: 'section_title', content: [] }, { type: 'paragraph', content: [{ type: 'text', text: 'plain text' }] }] }] }
    await docs.put('slideshows', slideshow({ id: 'd1', doc }))

    await removeQuoteInlineMarks.run(docs)

    const result = (await docs.list<Slideshow>('slideshows')).find((d) => d.id === 'd1')!
    expect(result.doc).toEqual(doc)
  })
})
