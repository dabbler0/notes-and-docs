import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fakeBackend'
import { markerHtml } from '../../lib/childMarkers'
import { reconstructSnapshot, reconstructSnapshotText } from '../../lib/essayHistory'
import { migrateVersionsToEssayHistory } from '../essaysMigrations'
import type { Essay, EssayCommitEntry, EssayNode } from '../types'

function essay(overrides: Partial<Essay> & { id: string; rootNodeId: string }): Essay {
  return { title: 'Essay', createdAt: 0, updatedAt: 0, ...overrides }
}

function node(overrides: Partial<EssayNode> & { id: string; essayId: string; draftContent: string; versions: EssayNode['versions'] }): EssayNode {
  return { title: 'Untitled', headVersionId: '', footnotes: [], comments: [], createdAt: 0, updatedAt: 0, ...overrides }
}

async function historyFor(docs: ReturnType<typeof createFakeBackend>['docs'], essayId: string): Promise<EssayCommitEntry[]> {
  const all = await docs.list<EssayCommitEntry>('essayHistory')
  return all.filter((c) => c.essayId === essayId).sort((a, b) => a.seq - b.seq)
}

describe('migrateVersionsToEssayHistory', () => {
  it("two sibling nodes whose versions alternate: a commit never shows a sibling's content from the future — only whatever was actually known about it at that point in time", async () => {
    const { docs } = createFakeBackend()
    const root = node({ id: 'root', essayId: 'e1', draftContent: markerHtml('a') + markerHtml('b'), versions: [] })
    const a = node({
      id: 'a',
      essayId: 'e1',
      versions: [
        { id: 'av1', content: 'A v1', createdAt: 10 },
        { id: 'av2', content: 'A v2', createdAt: 30 },
      ],
      headVersionId: 'av2',
      draftContent: 'A v2',
    })
    const b = node({
      id: 'b',
      essayId: 'e1',
      versions: [
        { id: 'bv1', content: 'B v1', createdAt: 20 },
        { id: 'bv2', content: 'B v2', createdAt: 40 },
      ],
      headVersionId: 'bv2',
      draftContent: 'B v2',
    })
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root', updatedAt: 40 }))
    await docs.put('nodes', root)
    await docs.put('nodes', a)
    await docs.put('nodes', b)

    await migrateVersionsToEssayHistory.run(docs)

    const commits = await historyFor(docs, 'e1')
    // Events in order: a-v1(10), b-v1(20), a-v2(30), b-v2(40) — one migrated
    // commit each, since each one changes something observable in the
    // snapshot — plus a final catch-up commit for root's own never-versioned
    // live content (its draftContent, the two marker divs, never equals ''
    // the running map leaves it at).
    expect(commits.length).toBeGreaterThanOrEqual(4)

    // At the commit for A's v2 (the 3rd one, seq 2), B must show its OWN v1
    // content — the most recent thing actually known about it at that point
    // in time — never B's not-yet-happened v2, and never (coincidentally
    // identical here or not) B's current/final content projected backward.
    const atAV2 = reconstructSnapshot(commits, 2)
    const bNode = atAV2.nodes.find((n) => n.id === 'b')
    const aNode = atAV2.nodes.find((n) => n.id === 'a')
    expect(aNode?.draftContent).toBe('A v2')
    expect(bNode?.draftContent).toBe('B v1')

    // And at the very first commit (seq 0, right after A's v1), B hasn't
    // been touched by any event at all yet — no historical record of it,
    // not its future v1 and not its final v2.
    const atAV1 = reconstructSnapshot(commits, 0)
    expect(atAV1.nodes.find((n) => n.id === 'a')?.draftContent).toBe('A v1')
    expect(atAV1.nodes.find((n) => n.id === 'b')?.draftContent).toBe('')
  })

  it('a parent and a child node whose versions alternate: nesting and per-node incremental text both hold across interleaved events', async () => {
    const { docs } = createFakeBackend()
    const parent = node({
      id: 'parent',
      essayId: 'e1',
      versions: [
        { id: 'pv1', content: `Parent v1 ${markerHtml('child')}`, createdAt: 10 },
        { id: 'pv2', content: `Parent v2 ${markerHtml('child')}`, createdAt: 30 },
      ],
      headVersionId: 'pv2',
      draftContent: `Parent v2 ${markerHtml('child')}`,
    })
    const child = node({
      id: 'child',
      essayId: 'e1',
      versions: [
        { id: 'cv1', content: 'Child v1', createdAt: 20 },
        { id: 'cv2', content: 'Child v2', createdAt: 40 },
      ],
      headVersionId: 'cv2',
      draftContent: 'Child v2',
    })
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'parent', updatedAt: 40 }))
    await docs.put('nodes', parent)
    await docs.put('nodes', child)

    await migrateVersionsToEssayHistory.run(docs)
    const commits = await historyFor(docs, 'e1')

    // At the commit for the parent's v2 (seq 2 — the 3rd event overall:
    // parent-v1(10), child-v1(20), parent-v2(30)), the child must still show
    // its own v1, not its not-yet-happened v2.
    const atParentV2 = reconstructSnapshot(commits, 2)
    expect(atParentV2.nodes.find((n) => n.id === 'parent')?.draftContent).toBe(`Parent v2 ${markerHtml('child')}`)
    expect(atParentV2.nodes.find((n) => n.id === 'child')?.draftContent).toBe('Child v1')
    // The child is still correctly nested/discoverable via the parent's own
    // (today's live) markers throughout — same tree membership regardless
    // of which point in history is being reconstructed.
    expect(atParentV2.nodes.map((n) => n.id).sort()).toEqual(['child', 'parent'])
  })

  it('a node never explicitly versioned beyond its seeded "Initial version" but with further live, uncommitted draftContent is picked up by the final catch-up commit', async () => {
    const { docs } = createFakeBackend()
    const root = node({
      id: 'root',
      essayId: 'e1',
      versions: [{ id: 'rv1', content: '', createdAt: 5 }],
      headVersionId: 'rv1',
      draftContent: 'Live edited text, never committed as a version.',
    })
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root', updatedAt: 50 }))
    await docs.put('nodes', root)

    await migrateVersionsToEssayHistory.run(docs)
    const commits = await historyFor(docs, 'e1')
    expect(commits.length).toBe(2) // the seeded "Initial version" event (empty text), then the catch-up commit

    const final = reconstructSnapshot(commits, commits[commits.length - 1].seq)
    expect(final.nodes.find((n) => n.id === 'root')?.draftContent).toBe('Live edited text, never committed as a version.')
  })

  it('is idempotent: running it twice produces no duplicate essayHistory rows', async () => {
    const { docs } = createFakeBackend()
    const root = node({
      id: 'root',
      essayId: 'e1',
      versions: [
        { id: 'rv1', content: 'v1', createdAt: 10 },
        { id: 'rv2', content: 'v2', createdAt: 20 },
      ],
      headVersionId: 'rv2',
      draftContent: 'v2',
    })
    await docs.put('essays', essay({ id: 'e1', rootNodeId: 'root', updatedAt: 20 }))
    await docs.put('nodes', root)

    await migrateVersionsToEssayHistory.run(docs)
    const firstRun = await historyFor(docs, 'e1')
    await migrateVersionsToEssayHistory.run(docs)
    const secondRun = await historyFor(docs, 'e1')

    expect(secondRun.length).toBe(firstRun.length)
    expect(secondRun.map((c) => c.id).sort()).toEqual(firstRun.map((c) => c.id).sort())

    // Old versions data itself is left completely untouched by the migration.
    const reloadedRoot = await docs.get<EssayNode>('nodes', 'root')
    expect(reloadedRoot?.versions).toHaveLength(2)
    expect(reloadedRoot?.headVersionId).toBe('rv2')
  })

  it("replaying the full migrated commit chain reproduces exactly today's live tree content", async () => {
    const { docs } = createFakeBackend()
    const root = node({ id: 'root', essayId: 'e1', draftContent: markerHtml('a') + markerHtml('b'), versions: [] })
    const a = node({
      id: 'a',
      essayId: 'e1',
      versions: [
        { id: 'av1', content: 'A v1', createdAt: 10 },
        { id: 'av2', content: 'A v2', createdAt: 30 },
      ],
      headVersionId: 'av2',
      draftContent: 'A v2',
    })
    const b = node({
      id: 'b',
      essayId: 'e1',
      versions: [{ id: 'bv1', content: 'B v1', createdAt: 20 }],
      headVersionId: 'bv1',
      draftContent: 'B live, edited after v1 and never re-versioned',
    })
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root', updatedAt: 40 }))
    await docs.put('nodes', root)
    await docs.put('nodes', a)
    await docs.put('nodes', b)

    await migrateVersionsToEssayHistory.run(docs)
    const commits = await historyFor(docs, 'e1')
    const lastSeq = commits[commits.length - 1].seq
    const finalText = reconstructSnapshotText(commits, lastSeq)
    const final = JSON.parse(finalText)

    expect(final.title).toBe('My Essay')
    expect(final.rootNodeId).toBe('root')
    const byId = Object.fromEntries(final.nodes.map((n: { id: string; draftContent: string }) => [n.id, n.draftContent]))
    expect(byId).toEqual({
      root: markerHtml('a') + markerHtml('b'),
      a: 'A v2',
      b: 'B live, edited after v1 and never re-versioned',
    })
  })

  it('is a no-op on an empty database', async () => {
    const { docs } = createFakeBackend()
    await expect(migrateVersionsToEssayHistory.run(docs)).resolves.toBeUndefined()
  })
})
