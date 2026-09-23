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
import { __resetFakeCloud } from '../../test/fakeFirestore'
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
})
