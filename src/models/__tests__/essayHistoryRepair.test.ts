import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fakeBackend'
import { diffSnapshots, reconstructSnapshotText } from '../../lib/essayHistory'
import { pmSnapshotText } from '../../lib/pmMigration'
import { essayHistoryChainIsBroken, findCorruptedEssayHistories, resetEssayHistory } from '../essayHistoryRepair'
import type { Essay, EssayCommitEntry } from '../types'

function essay(overrides: Partial<Essay> & { id: string }): Essay {
  return { title: 'Essay', rootNodeId: 'root', createdAt: 0, updatedAt: 0, ...overrides }
}

function commit(overrides: Partial<EssayCommitEntry> & { id: string; essayId: string; seq: number; patch: string }): EssayCommitEntry {
  return { createdAt: 0, kind: 'commit', ...overrides }
}

describe('essayHistoryChainIsBroken', () => {
  it('is false for an empty chain', () => {
    expect(essayHistoryChainIsBroken([])).toBe(false)
  })

  it('is false for a chain whose patches apply cleanly in order', () => {
    const text1 = pmSnapshotText({ title: 'Essay', doc: { type: 'doc', content: [] } })
    const text2 = pmSnapshotText({ title: 'Essay v2', doc: { type: 'doc', content: [] } })
    const commits = [
      commit({ id: 'c0', essayId: 'e1', seq: 0, patch: diffSnapshots('', text1) }),
      commit({ id: 'c1', essayId: 'e1', seq: 1, patch: diffSnapshots(text1, text2) }),
    ]
    expect(essayHistoryChainIsBroken(commits)).toBe(false)
  })

  it('is true for a chain whose patch no longer applies to the previous reconstructed text', () => {
    const commits = [commit({ id: 'c0', essayId: 'e1', seq: 0, patch: diffSnapshots('', 'original text') }), commit({ id: 'c1', essayId: 'e1', seq: 1, patch: diffSnapshots('something totally different', 'v2') })]
    expect(essayHistoryChainIsBroken(commits)).toBe(true)
  })
})

describe('findCorruptedEssayHistories', () => {
  it('returns only the essays whose own history is broken, each with its title', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essays', essay({ id: 'healthy', title: 'Healthy Essay' }))
    await docs.put('essayHistory', commit({ id: 'h0', essayId: 'healthy', seq: 0, patch: diffSnapshots('', pmSnapshotText({ title: 'Healthy Essay', doc: {} })) }))

    await docs.put('essays', essay({ id: 'broken', title: 'Broken Essay' }))
    await docs.put('essayHistory', commit({ id: 'b0', essayId: 'broken', seq: 0, patch: diffSnapshots('', 'original') }))
    await docs.put('essayHistory', commit({ id: 'b1', essayId: 'broken', seq: 1, patch: diffSnapshots('does not match', 'v2') }))

    const found = await findCorruptedEssayHistories(docs)
    expect(found).toEqual([{ essayId: 'broken', title: 'Broken Essay' }])
  })

  it('skips a deleted essay even if its history is broken', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essays', essay({ id: 'gone', title: 'Gone Essay', deleted: true }))
    await docs.put('essayHistory', commit({ id: 'g0', essayId: 'gone', seq: 0, patch: diffSnapshots('', 'original') }))
    await docs.put('essayHistory', commit({ id: 'g1', essayId: 'gone', seq: 1, patch: diffSnapshots('does not match', 'v2') }))

    expect(await findCorruptedEssayHistories(docs)).toEqual([])
  })

  it('returns an empty list when nothing is broken', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essays', essay({ id: 'e1', title: 'Essay One' }))
    expect(await findCorruptedEssayHistories(docs)).toEqual([])
  })
})

describe('resetEssayHistory', () => {
  it("discards every existing commit and replaces them with a single fresh one matching the essay's current content", async () => {
    const { docs } = createFakeBackend()
    const doc = { type: 'doc', content: [{ type: 'section', attrs: { id: 'root' }, content: [] }] }
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', doc }))
    await docs.put('essayHistory', commit({ id: 'c0', essayId: 'e1', seq: 0, patch: diffSnapshots('', 'original') }))
    await docs.put('essayHistory', commit({ id: 'c1', essayId: 'e1', seq: 1, patch: diffSnapshots('does not match', 'v2') }))

    await resetEssayHistory(docs, 'e1')

    const commits = (await docs.list<EssayCommitEntry>('essayHistory')).filter((c) => c.essayId === 'e1')
    expect(commits).toHaveLength(1)
    expect(commits[0].seq).toBe(0)
    const text = reconstructSnapshotText(commits, 0)
    expect(JSON.parse(text)).toEqual({ title: 'My Essay', doc })
  })

  it('is a no-op when the essay itself does not exist', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essayHistory', commit({ id: 'c0', essayId: 'ghost', seq: 0, patch: diffSnapshots('', 'original') }))

    await resetEssayHistory(docs, 'ghost')

    const commits = (await docs.list<EssayCommitEntry>('essayHistory')).filter((c) => c.essayId === 'ghost')
    expect(commits).toHaveLength(1) // untouched — left exactly as it was
  })

  it('leaves the essay healthy afterward — reconstructable, and no longer flagged by findCorruptedEssayHistories', async () => {
    const { docs } = createFakeBackend()
    await docs.put('essays', essay({ id: 'e1', title: 'My Essay', doc: { type: 'doc', content: [] } }))
    await docs.put('essayHistory', commit({ id: 'c0', essayId: 'e1', seq: 0, patch: diffSnapshots('', 'original') }))
    await docs.put('essayHistory', commit({ id: 'c1', essayId: 'e1', seq: 1, patch: diffSnapshots('does not match', 'v2') }))
    expect(await findCorruptedEssayHistories(docs)).toHaveLength(1)

    await resetEssayHistory(docs, 'e1')

    expect(await findCorruptedEssayHistories(docs)).toEqual([])
  })
})
