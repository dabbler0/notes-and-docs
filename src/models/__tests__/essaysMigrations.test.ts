import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fakeBackend'
import { markerHtml } from '../../lib/childMarkers'
import { reconstructSnapshot, reconstructSnapshotText } from '../../lib/essayHistory'
import { Node as PMNode } from 'prosemirror-model'
import { migrateCommentThreadsIntoDoc, migratePMDocuments, migrateVersionsToEssayHistory } from '../essaysMigrations'
import { diffSnapshots } from '../../lib/essayHistory'
import { pmSnapshotText } from '../../lib/pmMigration'
import { essaySchema } from '../../lib/pmSchema'
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

describe('migratePMDocuments', () => {
  it('sets essay.doc/essay.comments from the live node tree, leaving old data untouched', async () => {
    const { docs } = createFakeBackend()
    const root = node({ id: 'root', essayId: 'e1', draftContent: '<p>Body text.</p>', versions: [] })
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root' }))
    await docs.put('nodes', root)

    await migratePMDocuments.run(docs)

    const migratedEssay = (await docs.list<Essay>('essays')).find((e) => e.id === 'e1')!
    expect(migratedEssay.doc).toBeDefined()
    const pm = PMNode.fromJSON(essaySchema, migratedEssay.doc)
    expect(pm.firstChild!.type.name).toBe('section')
    expect(pm.textContent).toContain('Body text.')
    expect(migratedEssay.comments).toEqual([])
    // Old data untouched.
    const stillThere = (await docs.list<EssayNode>('nodes')).find((n) => n.id === 'root')!
    expect(stillThere.draftContent).toBe('<p>Body text.</p>')
    expect(migratedEssay.rootNodeId).toBe('root')
  })

  it("flattens a node's still-legacy version.comments into essay.comments, not just its draftContent's own comment-anchor marks", async () => {
    const { docs } = createFakeBackend()
    // `node()`'s own default sets `comments: []` (already-flattened, the
    // normal case) — this node instead has `comments` left `undefined`
    // entirely, with the real comment data still sitting in
    // `version.comments`, an old field no longer declared on `NodeVersion`
    // but still exactly how already-stored data from before comments were
    // flattened onto the node itself looks. `getNode()` would lazily
    // flatten this the first time the node was actually opened in the
    // app — this migration never calls `getNode()`, so it has to do that
    // flattening itself (`migrateComments`, wired into both `run`
    // functions below) or the comment's own anchor mark (baked directly
    // into `draftContent`, migrated regardless) would survive with no
    // actual `Comment` record behind it.
    const root = node({
      id: 'root',
      essayId: 'e1',
      draftContent: '<p>Body text<mark class="comment-anchor" data-comment-id="c1">with an anchor</mark>.</p>',
      versions: [{ id: 'v1', content: '', createdAt: 0, comments: [{ id: 'c1', parentId: null, anchorKind: 'text', anchorText: 'with an anchor', body: '<p>A real comment.</p>', resolved: false, createdAt: 0, updatedAt: 0 }] } as unknown as EssayNode['versions'][number]],
    })
    root.comments = undefined
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root' }))
    await docs.put('nodes', root)

    await migratePMDocuments.run(docs)

    const migratedEssay = (await docs.list<Essay>('essays')).find((e) => e.id === 'e1')!
    expect(migratedEssay.comments).toHaveLength(1)
    expect(migratedEssay.comments![0].id).toBe('c1')
    expect(migratedEssay.comments![0].body).toBe('<p>A real comment.</p>')
    expect(migratedEssay.comments![0].sectionId).toBe('root')

    const pm = PMNode.fromJSON(essaySchema, migratedEssay.doc)
    let foundAnchor = false
    pm.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'comment_anchor' && m.attrs.commentId === 'c1')) foundAnchor = true
    })
    expect(foundAnchor).toBe(true)
  })

  it("converts an essay's entire existing commit history to the new format in the same pass", async () => {
    const { docs } = createFakeBackend()
    const root = node({ id: 'root', essayId: 'e1', draftContent: '<p>v1</p>', versions: [] })
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root' }))
    await docs.put('nodes', root)
    const c0: EssayCommitEntry = { id: 'c0', essayId: 'e1', seq: 0, createdAt: 1, kind: 'commit', patch: '' }
    // Build a real patch the same way commitEssay would — snapshot text diffed from ''.
    const snapshot = { title: 'My Essay', rootNodeId: 'root', nodes: [{ id: 'root', title: 'Untitled', draftContent: '<p>v1</p>', footnotes: [], comments: [] }] }
    const Diff = await import('diff')
    c0.patch = Diff.createPatch('snapshot.json', '', JSON.stringify(snapshot, null, 2))
    await docs.put('essayHistory', c0)

    await migratePMDocuments.run(docs)

    const commits = await historyFor(docs, 'e1')
    expect(commits).toHaveLength(1)
    expect(commits[0].id).toBe('c0')
    expect(commits[0].seq).toBe(0)
    expect(commits[0].kind).toBe('commit')
    const text = reconstructSnapshotText(commits, 0)
    const migratedSnapshot = JSON.parse(text)
    expect(migratedSnapshot.doc).toBeDefined()
    PMNode.fromJSON(essaySchema, migratedSnapshot.doc) // throws if invalid
  })

  it('skips an essay that already has doc set (idempotent)', async () => {
    const { docs } = createFakeBackend()
    const alreadyMigrated = { type: 'doc', content: [{ type: 'section', attrs: { id: 'root' }, content: [{ type: 'section_title' }, { type: 'paragraph' }] }] }
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root', doc: alreadyMigrated }))
    await migratePMDocuments.run(docs)
    const result = (await docs.list<Essay>('essays')).find((e) => e.id === 'e1')!
    expect(result.doc).toEqual(alreadyMigrated)
  })

  it('is a no-op on an empty database', async () => {
    const { docs } = createFakeBackend()
    await expect(migratePMDocuments.run(docs)).resolves.toBeUndefined()
  })
})

describe('migrateCommentThreadsIntoDoc', () => {
  function docWithAnchor(commentId: string): unknown {
    return {
      type: 'doc',
      content: [
        {
          type: 'section',
          attrs: { id: 'root' },
          content: [{ type: 'section_title', content: [{ type: 'text', text: 'My Essay' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Some text.', marks: [{ type: 'comment_anchor', attrs: { commentId } }] }] }],
        },
      ],
    }
  }

  it("folds essay.comments into real comment_thread nodes inside essay.doc, and clears the field", async () => {
    const { docs } = createFakeBackend()
    const migratedEssay = essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root', doc: docWithAnchor('c1') })
    migratedEssay.comments = [{ id: 'c1', parentId: null, sectionId: 'root', anchorKind: 'text', anchorText: 'Some text.', body: '<p>A note.</p>', resolved: false, createdAt: 1, updatedAt: 2 }]
    await docs.put('essays', migratedEssay)

    await migrateCommentThreadsIntoDoc.run(docs)

    const result = (await docs.list<Essay>('essays')).find((e) => e.id === 'e1')!
    expect(result.comments).toBeUndefined()
    const pm = PMNode.fromJSON(essaySchema, result.doc)
    let found = false
    pm.descendants((n) => {
      if (n.type.name === 'comment_thread' && n.attrs.id === 'c1') found = true
    })
    expect(found).toBe(true)
  })

  it('also refolds the same essay\'s existing essayHistory commits, so reverting into an old commit never lands on a dead pre-fold shape', async () => {
    const { docs } = createFakeBackend()
    const doc = docWithAnchor('c1')
    const comments = [{ id: 'c1', parentId: null, sectionId: 'root', anchorKind: 'text' as const, anchorText: 'Some text.', body: 'A note.', resolved: false, createdAt: 1, updatedAt: 2 }]
    const text = pmSnapshotText({ title: 'My Essay', doc, comments } as never)
    await docs.put('essayHistory', { id: 'c0', essayId: 'e1', seq: 0, createdAt: 0, kind: 'migrated' as const, patch: diffSnapshots('', text) })

    const migratedEssay = essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root', doc })
    migratedEssay.comments = comments
    await docs.put('essays', migratedEssay)

    await migrateCommentThreadsIntoDoc.run(docs)

    const commits = (await docs.list<EssayCommitEntry>('essayHistory')).filter((c) => c.essayId === 'e1')
    expect(commits).toHaveLength(1)
    const historyText = reconstructSnapshotText(commits, 0)
    expect(historyText).not.toContain('"comments"')
    const snapshot = JSON.parse(historyText)
    const pm = PMNode.fromJSON(essaySchema, snapshot.doc)
    let found = false
    pm.descendants((n) => {
      if (n.type.name === 'comment_thread' && n.attrs.id === 'c1') found = true
    })
    expect(found).toBe(true)
  })

  it('skips an essay with no comments to fold (idempotent)', async () => {
    const { docs } = createFakeBackend()
    const doc = docWithAnchor('ignored')
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root', doc }))
    await migrateCommentThreadsIntoDoc.run(docs)
    const result = (await docs.list<Essay>('essays')).find((e) => e.id === 'e1')!
    expect(result.doc).toEqual(doc)
  })

  it('skips an essay that was never migrated to doc at all', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', rootNodeId: 'root' }))
    await expect(migrateCommentThreadsIntoDoc.run(docs)).resolves.toBeUndefined()
  })

  it('is a no-op on an empty database', async () => {
    const { docs } = createFakeBackend()
    await expect(migrateCommentThreadsIntoDoc.run(docs)).resolves.toBeUndefined()
  })
})
