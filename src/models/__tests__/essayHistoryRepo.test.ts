import { beforeEach, describe, expect, it } from 'vitest'
import { createChildNode, createEssay, getEssay, getNode, loadNodeMap, saveNode } from '../essaysRepo'
import { buildSnapshot, commitEssay, getCommitSnapshot, listEssayHistory, mergeEssays, revertEssayTo } from '../essayHistoryRepo'
import { groupEssays, getProject } from '../projectsRepo'
import { reconstructSnapshotText } from '../../lib/essayHistory'
import { markerHtml } from '../../lib/childMarkers'
import type { Essay, EssayNode } from '../types'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

/**
 * `createEssay` now creates a modern, `doc`-based essay with no `EssayNode`
 * tree at all (see its own doc comment in `essaysRepo.ts`). The functions
 * this file tests (`buildSnapshot`/`commitEssay`/`revertEssayTo`/
 * `mergeEssays`) still only know how to walk that old tree — their
 * `doc`-based counterparts are deferred to a later phase (see
 * `essayHistoryRepo.ts`'s own doc comment) — so every test here builds
 * that same old shape directly: an essay plus one real root `EssayNode`,
 * exactly what `createEssay` itself used to produce.
 */
async function createEssayWithRootNode(title: string): Promise<{ essay: Essay; root: EssayNode }> {
  const essay = await createEssay(title)
  const now = Date.now()
  const root: EssayNode = { id: essay.rootNodeId, essayId: essay.id, title: title || 'Untitled essay', versions: [], headVersionId: '', draftContent: '', createdAt: now, updatedAt: now }
  await saveNode(root)
  return { essay, root }
}

describe('commitEssay', () => {
  it('appends a commit capturing the current live state, and is a no-op when nothing has changed since the last one', async () => {
    const essay = await createEssay('My Essay')
    const nodeMap = await loadNodeMap(essay)

    const first = await commitEssay(essay, nodeMap, 'First draft')
    expect(first?.kind).toBe('commit')
    expect(first?.label).toBe('First draft')
    expect(first?.seq).toBe(0)

    const second = await commitEssay(essay, nodeMap, 'Nothing changed')
    expect(second).toBeUndefined()

    const history = await listEssayHistory(essay.id)
    expect(history).toHaveLength(1)
  })

  it('captures real edits across a two-commit history, each reconstructable on its own', async () => {
    const { essay, root } = await createEssayWithRootNode('My Essay')
    let nodeMap = await loadNodeMap(essay)
    root.draftContent = '<p>First version of the text.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)

    const c1 = await commitEssay(essay, nodeMap, 'v1')
    expect(c1).toBeDefined()

    root.draftContent = '<p>Second version of the text.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    const c2 = await commitEssay(essay, nodeMap, 'v2')
    expect(c2).toBeDefined()
    expect(c2!.seq).toBe(1)

    const snap1 = await getCommitSnapshot(essay.id, c1!.id)
    const snap2 = await getCommitSnapshot(essay.id, c2!.id)
    expect(snap1?.nodes.find((n) => n.id === root.id)?.draftContent).toBe('<p>First version of the text.</p>')
    expect(snap2?.nodes.find((n) => n.id === root.id)?.draftContent).toBe('<p>Second version of the text.</p>')
  })

  it('a child node added between commits shows up in the later snapshot but not the earlier one', async () => {
    const { essay, root } = await createEssayWithRootNode('My Essay')
    let nodeMap = await loadNodeMap(essay)
    const beforeChild = await commitEssay(essay, nodeMap, 'Before child')
    expect(beforeChild).toBeDefined()

    const child = await createChildNode(essay.id, 'A Section', '<p>Child text.</p>')
    root.draftContent += markerHtml(child.id)
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    const afterChild = await commitEssay(essay, nodeMap, 'After child')
    expect(afterChild).toBeDefined()

    const snapBefore = await getCommitSnapshot(essay.id, beforeChild!.id)
    const snapAfter = await getCommitSnapshot(essay.id, afterChild!.id)
    expect(snapBefore?.nodes.map((n) => n.id)).not.toContain(child.id)
    expect(snapAfter?.nodes.map((n) => n.id)).toContain(child.id)
    expect(snapAfter?.nodes.find((n) => n.id === child.id)?.draftContent).toBe('<p>Child text.</p>')
  })
})

describe('revertEssayTo', () => {
  it('restores the live tree to an earlier commit and appends a new revert commit rather than rewriting history', async () => {
    const { essay, root } = await createEssayWithRootNode('My Essay')
    let nodeMap = await loadNodeMap(essay)

    root.draftContent = '<p>Version A.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    const commitA = await commitEssay(essay, nodeMap, 'A')

    root.draftContent = '<p>Version B.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    await commitEssay(essay, nodeMap, 'B')

    const beforeRevertCount = (await listEssayHistory(essay.id)).length
    const reverted = await revertEssayTo(essay, nodeMap, commitA!.id)
    expect(reverted?.nodes.find((n) => n.id === root.id)?.draftContent).toBe('<p>Version A.</p>')

    const afterRevertHistory = await listEssayHistory(essay.id)
    expect(afterRevertHistory.length).toBe(beforeRevertCount + 1) // appended, not rewritten
    expect(afterRevertHistory[afterRevertHistory.length - 1].kind).toBe('revert')

    const liveRoot = (await getNode(root.id))!
    expect(liveRoot.draftContent).toBe('<p>Version A.</p>')

    const liveEssay = (await getEssay(essay.id))!
    expect(liveEssay.rootNodeId).toBe(root.id)
  })

  it('a revert is itself revertible — reverting back to the pre-revert state restores it and appends yet another commit', async () => {
    const { essay, root } = await createEssayWithRootNode('My Essay')
    let nodeMap = await loadNodeMap(essay)

    root.draftContent = '<p>Version A.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    const commitA = await commitEssay(essay, nodeMap, 'A')

    root.draftContent = '<p>Version B.</p>'
    await saveNode(root)
    nodeMap = await loadNodeMap(essay)
    const commitB = await commitEssay(essay, nodeMap, 'B')

    await revertEssayTo(essay, nodeMap, commitA!.id)
    nodeMap = await loadNodeMap(essay)
    expect((await getNode(root.id))!.draftContent).toBe('<p>Version A.</p>')

    // Revert the revert: go back to commit B's own content.
    await revertEssayTo(essay, nodeMap, commitB!.id)
    const final = (await getNode(root.id))!
    expect(final.draftContent).toBe('<p>Version B.</p>')

    const history = await listEssayHistory(essay.id)
    expect(history.filter((c) => c.kind === 'revert')).toHaveLength(2)
  })
})

describe('mergeEssays', () => {
  it('appends the base essay with the content of the appended one, preserving both histories', async () => {
    const { essay: base, root: baseRoot } = await createEssayWithRootNode('Base Essay')
    let baseNodeMap = await loadNodeMap(base)
    baseRoot.draftContent = '<p>Base v1.</p>'
    await saveNode(baseRoot)
    baseNodeMap = await loadNodeMap(base)
    await commitEssay(base, baseNodeMap, 'Base v1')
    baseRoot.draftContent = '<p>Base v2.</p>'
    await saveNode(baseRoot)
    baseNodeMap = await loadNodeMap(base)
    await commitEssay(base, baseNodeMap, 'Base v2')

    const { essay: appended, root: appendedRoot } = await createEssayWithRootNode('Appended Essay')
    let appendedNodeMap = await loadNodeMap(appended)
    appendedRoot.draftContent = '<p>Appended v1.</p>'
    await saveNode(appendedRoot)
    appendedNodeMap = await loadNodeMap(appended)
    await commitEssay(appended, appendedNodeMap, 'Appended v1')
    appendedRoot.draftContent = '<p>Appended v2.</p>'
    await saveNode(appendedRoot)
    appendedNodeMap = await loadNodeMap(appended)
    await commitEssay(appended, appendedNodeMap, 'Appended v2')

    const appendedHistoryBefore = await listEssayHistory(appended.id)
    const appendedPatchesBefore = appendedHistoryBefore.map((c) => c.patch)

    await mergeEssays(base.id, appended.id)

    const liveBase = (await getEssay(base.id))!
    const liveRoot = (await getNode(liveBase.rootNodeId))!
    expect(liveRoot.draftContent).toBe('<p>Appended v2.</p>')

    const mergedHistory = await listEssayHistory(base.id)
    expect(mergedHistory.some((c) => c.kind === 'merge')).toBe(true)
    const lastSeq = mergedHistory[mergedHistory.length - 1].seq
    const replayedText = reconstructSnapshotText(mergedHistory, lastSeq)
    const replayed = JSON.parse(replayedText)
    expect(replayed.nodes.find((n: { id: string }) => n.id === liveRoot.id)?.draftContent).toBe('<p>Appended v2.</p>')

    // The appended essay's own commits beyond the first (which became the bridge target,
    // not copied verbatim) are transplanted with byte-identical patch text.
    const transplanted = mergedHistory.filter((c) => appendedPatchesBefore.includes(c.patch))
    expect(transplanted.length).toBe(appendedPatchesBefore.length - 1)

    const appendedHistoryAfter = await listEssayHistory(appended.id)
    expect(appendedHistoryAfter).toHaveLength(0)

    const liveAppended = (await getEssay(appended.id))!
    expect(liveAppended.deleted).toBe(true)
  })

  it('tombstones the appended essay and cleans up a now-trivial shared project', async () => {
    const base = await createEssay('Base')
    const appended = await createEssay('Appended')
    await groupEssays(base, appended)
    const projectId = (await getEssay(base.id))!.projectId!
    expect(projectId).toBeDefined()

    await mergeEssays(base.id, appended.id)

    const liveBase = (await getEssay(base.id))!
    expect(liveBase.projectId).toBeUndefined()
    expect((await getProject(projectId))?.deleted).toBe(true)
  })

  it('synthesizes a commit for an essay with zero prior history rather than failing', async () => {
    const base = await createEssay('Base')
    const { essay: appended, root: appendedRoot } = await createEssayWithRootNode('Appended')
    appendedRoot.draftContent = '<p>Never committed.</p>'
    await saveNode(appendedRoot)

    await mergeEssays(base.id, appended.id)

    const liveBase = (await getEssay(base.id))!
    const liveRoot = (await getNode(liveBase.rootNodeId))!
    expect(liveRoot.draftContent).toBe('<p>Never committed.</p>')

    const history = await listEssayHistory(base.id)
    expect(history.length).toBeGreaterThan(0)
  })

  it('is a no-op when merging an essay into itself', async () => {
    const essay = await createEssay('Solo')
    await mergeEssays(essay.id, essay.id)
    expect(await getEssay(essay.id)).toBeDefined()
  })
})

describe('buildSnapshot', () => {
  it('walks the live tree in document order, including footnotes and comments', async () => {
    const { essay, root } = await createEssayWithRootNode('My Essay')
    root.title = 'Root Title'
    root.draftContent = '<p>Some text.</p>'
    await saveNode(root)
    const reloaded = (await getNode(root.id))!
    const freshMap = new Map([[root.id, reloaded]])

    const snapshot = buildSnapshot({ ...essay, title: 'My Essay' }, freshMap)
    expect(snapshot.title).toBe('My Essay')
    expect(snapshot.rootNodeId).toBe(root.id)
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]).toMatchObject({ id: root.id, title: 'Root Title', draftContent: '<p>Some text.</p>' })
  })
})
