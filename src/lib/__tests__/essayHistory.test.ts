import { describe, expect, it } from 'vitest'
import { applyPatch, diffSnapshots, reconstructSnapshot, reconstructSnapshotText, snapshotText } from '../essayHistory'
import type { EssayCommitEntry, EssaySnapshot } from '../../models/types'

function snap(overrides: Partial<EssaySnapshot> = {}): EssaySnapshot {
  return { title: 'Essay', rootNodeId: 'root', nodes: [{ id: 'root', title: 'Root', draftContent: '<p>text</p>', footnotes: [], comments: [] }], ...overrides }
}

describe('diffSnapshots / applyPatch', () => {
  it('round-trips a snapshot change', () => {
    const a = snapshotText(snap())
    const b = snapshotText(snap({ nodes: [{ id: 'root', title: 'Root', draftContent: '<p>edited</p>', footnotes: [], comments: [] }] }))
    const patch = diffSnapshots(a, b)
    expect(applyPatch(a, patch)).toBe(b)
  })

  it('diffing from "" (the very first commit) and applying it reproduces the text', () => {
    const text = snapshotText(snap())
    const patch = diffSnapshots('', text)
    expect(applyPatch('', patch)).toBe(text)
  })

  it('a no-op diff (identical text) applies back to the same text unchanged', () => {
    const text = snapshotText(snap())
    const patch = diffSnapshots(text, text)
    expect(applyPatch(text, patch)).toBe(text)
  })

  it('throws rather than silently returning garbage when a patch does not apply to the given text', () => {
    const a = snapshotText(snap())
    const b = snapshotText(snap({ title: 'Different' }))
    const patch = diffSnapshots(a, b)
    expect(() => applyPatch('completely unrelated text', patch)).toThrow()
  })
})

describe('reconstructSnapshotText / reconstructSnapshot', () => {
  function chain(): EssayCommitEntry[] {
    const texts = [snap({ nodes: [{ id: 'root', title: 'Root', draftContent: 'v0', footnotes: [], comments: [] }] }), snap({ nodes: [{ id: 'root', title: 'Root', draftContent: 'v1', footnotes: [], comments: [] }] }), snap({ nodes: [{ id: 'root', title: 'Root', draftContent: 'v2', footnotes: [], comments: [] }] })].map(snapshotText)
    const commits: EssayCommitEntry[] = []
    let prev = ''
    texts.forEach((text, seq) => {
      commits.push({ id: `c${seq}`, essayId: 'e1', seq, createdAt: seq, kind: 'commit', patch: diffSnapshots(prev, text) })
      prev = text
    })
    return commits
  }

  it('replays from the start up through a given seq, not past it', () => {
    const commits = chain()
    expect(JSON.parse(reconstructSnapshotText(commits, 0)).nodes[0].draftContent).toBe('v0')
    expect(JSON.parse(reconstructSnapshotText(commits, 1)).nodes[0].draftContent).toBe('v1')
    expect(JSON.parse(reconstructSnapshotText(commits, 2)).nodes[0].draftContent).toBe('v2')
  })

  it('works regardless of the input array order — always sorts by seq first', () => {
    const commits = chain()
    const shuffled = [commits[2], commits[0], commits[1]]
    expect(JSON.parse(reconstructSnapshotText(shuffled, 1)).nodes[0].draftContent).toBe('v1')
  })

  it('reconstructSnapshot parses the text back into a real EssaySnapshot', () => {
    const commits = chain()
    const snapshot = reconstructSnapshot(commits, 2)
    expect(snapshot.nodes[0].draftContent).toBe('v2')
    expect(snapshot.title).toBe('Essay')
  })

  it('an empty commit list reconstructs to an empty snapshot, not a crash', () => {
    const snapshot = reconstructSnapshot([], 0)
    expect(snapshot).toEqual({ title: '', rootNodeId: '', nodes: [] })
  })
})
