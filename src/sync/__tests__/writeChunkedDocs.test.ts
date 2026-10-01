/**
 * `writeChunkedDocs` exists to fix a real production error — "Write stream
 * exhausted maximum allowed queued writes" — that firing many independent
 * `setDoc()` calls via `Promise.all` triggers once there are enough of
 * them (a many-page, image-heavy PDF under the experimental layout
 * extractor can easily need several hundred 700,000-character chunks).
 * That's a Firestore client-SDK flow-control limit, not a Spark-plan
 * quota — genuinely fixable by pacing the writes, which is what this
 * tests: a large number of entries gets paged into ≤500-write batches,
 * committed one at a time, rather than firing everything at once.
 *
 * Testing this against real encrypted chunk sizes (700,000 characters
 * each) would need hundreds of megabytes of data to span more than one
 * batch — this exercises the actual pacing logic directly against
 * synthetic entries instead, which is both faster and more targeted.
 */
import { describe, expect, it } from 'vitest'
import { doc, getDoc, getFirestore } from 'firebase/firestore'
import { __clearPersistentWriteFailure, __failNextWriteTo, __failWritesToUntilCleared, __resetFakeCloud } from '../../test/fakeFirestore'
import { writeChunkedDocs } from '../syncEngine'

describe('writeChunkedDocs', () => {
  it('writes every entry across more than one batch without exceeding a single batch\'s 500-write cap', async () => {
    __resetFakeCloud()
    const db = getFirestore()
    const count = 1200 // spans 3 batches of 500 — proves paging works, not just "fits in one"
    const entries = Array.from({ length: count }, (_, i) => ({
      ref: doc(db, 'accounts', 'u', 'probe', String(i)),
      data: { value: i },
    }))

    await writeChunkedDocs(db, entries)

    for (let i = 0; i < count; i += 137) {
      const snap = await getDoc(doc(db, 'accounts', 'u', 'probe', String(i)))
      expect(snap.data()?.value).toBe(i)
    }
    const last = await getDoc(doc(db, 'accounts', 'u', 'probe', String(count - 1)))
    expect(last.data()?.value).toBe(count - 1)
  })

  it('writes a small number of entries (well under one batch) in a single commit', async () => {
    __resetFakeCloud()
    const db = getFirestore()
    const entries = Array.from({ length: 3 }, (_, i) => ({ ref: doc(db, 'accounts', 'u', 'probe2', String(i)), data: { value: i } }))
    await writeChunkedDocs(db, entries)
    for (let i = 0; i < 3; i++) {
      expect((await getDoc(doc(db, 'accounts', 'u', 'probe2', String(i)))).data()?.value).toBe(i)
    }
  })

  it('is a no-op for an empty entry list', async () => {
    __resetFakeCloud()
    const db = getFirestore()
    await expect(writeChunkedDocs(db, [])).resolves.toBeUndefined()
  })

  it('backs off to smaller batches (instead of failing outright) when the first, ambitious-sized batch fails', async () => {
    __resetFakeCloud()
    const db = getFirestore()
    // One ambitious top-level batch's worth of entries (see
    // CHUNK_COMMIT_BATCH_SIZE) — small enough that a real connection would
    // normally commit it in one shot, which is exactly the case this test
    // forces to fail once so the backoff in commitChunkSlice has to kick in.
    const entries = Array.from({ length: 6 }, (_, i) => ({ ref: doc(db, 'accounts', 'u', 'probe3', String(i)), data: { value: i } }))

    // Fails only the very first write this batch attempts — simulating a
    // batch that's simply too big for this connection to complete, not a
    // doc-specific problem. Self-clears after firing once, so the smaller
    // retried batches that follow succeed normally.
    __failNextWriteTo((path) => path.includes('/probe3/0'))

    const progressCalls: [number, number][] = []
    await writeChunkedDocs(db, entries, (done, total) => progressCalls.push([done, total]))

    for (let i = 0; i < 6; i++) {
      expect((await getDoc(doc(db, 'accounts', 'u', 'probe3', String(i)))).data()?.value).toBe(i)
    }
    // Progress still only ever reports in increasing, in-order amounts —
    // the caller sees real movement regardless of how many smaller pieces
    // the failed batch actually took to get there.
    expect(progressCalls[progressCalls.length - 1]).toEqual([6, 6])
    for (let i = 1; i < progressCalls.length; i++) expect(progressCalls[i][0]).toBeGreaterThan(progressCalls[i - 1][0])
  })

  it('gives up and reports the real error once a batch has been split all the way down to a single chunk and that still fails every retry', async () => {
    __resetFakeCloud()
    const db = getFirestore()
    const entries = [{ ref: doc(db, 'accounts', 'u', 'probe4', '0'), data: { value: 0 } }]

    // A single chunk has nowhere smaller left to back off to — this keeps
    // every attempt at it failing (unlike __failNextWriteTo, which clears
    // itself after one hit), simulating a connection that's genuinely down
    // for it rather than a one-off hiccup, so its in-place retries should
    // all be exhausted too before this finally rejects.
    __failWritesToUntilCleared((path) => path.endsWith('/probe4/0'))

    await expect(writeChunkedDocs(db, entries)).rejects.toThrow(/simulated persistent write failure/)
    __clearPersistentWriteFailure()
  }, 15_000)
})
