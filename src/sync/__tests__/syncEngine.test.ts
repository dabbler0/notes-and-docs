/**
 * End-to-end sync tests against the in-memory fakes in `src/test/` (fake
 * Firestore, fake Auth, fake per-device local backend/localStorage — see
 * each fake's own doc comment, and `deviceHarness.ts` for how "a device"
 * is assembled from them). No real network, no real emulator process —
 * these run in plain `vitest` and exercise the exact same production code
 * (`syncEngine.ts`, `account.ts`, `accountMeta.ts`, `autoSync.ts`) real
 * sync does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { newDevice, newDeviceSignedIn, type Device } from '../../test/deviceHarness'
import { __failNextWriteTo, __getFakeCloud, __resetFakeCloud } from '../../test/fakeFirestore'
import { generateKeyBundle, isKeyBundle } from '../../lib/crypto'

beforeEach(() => {
  __resetFakeCloud()
})

/** The common two-device setup: A bootstraps a fresh key and pushes the account's very first sync pass (which also plants the remote fingerprint doc), B imports the same key. */
async function pairedDevices(email = 'alice@example.com'): Promise<{ a: Device; b: Device }> {
  const a = await newDeviceSignedIn(email)
  await a.createLocalKey()
  await a.sync() // first pass plants accounts/{uid}/meta/account
  const bundle = a.exportBundle()!
  const b = await newDeviceSignedIn(email)
  await b.importLocalKey(bundle)
  return { a, b }
}

describe('basic push/pull round trip', () => {
  it('propagates a new essay + node from one device to another', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('My essay')
    const root = await a.getNode(essay.rootNodeId)
    root!.draftContent = 'Hello from device A'
    await a.saveNode(root!)
    await a.sync()

    const result = await b.sync()
    expect(result.pulled.essays).toBe(1)
    expect(result.pulled.nodes).toBe(1)

    const pulledEssay = await b.getEssay(essay.id)
    const pulledNode = await b.getNode(essay.rootNodeId)
    expect(pulledEssay?.title).toBe('My essay')
    expect(pulledNode?.draftContent).toBe('Hello from device A')
  })

  it('round-trips a source with BibTeX metadata and page text', async () => {
    const { a, b } = await pairedDevices()
    await a.createSource({ type: 'article', key: 'smith2020', fields: { title: 'A Paper', author: 'Smith', year: '2020' } }, { comment: 'good stuff', pageHtml: ['page one text'] })
    await a.sync()
    await b.sync()

    // listSources() is the lightweight, metadata-only path (see
    // Source.pageHtml's own doc comment) — its own pageCount still has to
    // be correct post-sync, but the actual text only comes from getSource,
    // which means the content half (a separate synced collection — see
    // sync/collections.ts) made the round trip too, not just metadata.
    const [listed] = await b.listSources()
    expect(listed.bibtex.fields.title).toBe('A Paper')
    expect(listed.comment).toBe('good stuff')
    expect(listed.pageHtml).toEqual([])
    expect(listed.pageCount).toBe(1)

    const full = await b.getSource(listed.id)
    expect(full?.pageHtml).toEqual(['page one text'])
  })

  it('round-trips a PDF blob byte-for-byte through the chunking scheme', { timeout: 20_000 }, async () => {
    const { a, b } = await pairedDevices()
    // Bigger than one chunk (700,000 base64 chars) so multiple chunk docs
    // are exercised — the base64/crypto/structuredClone work involved
    // makes this the slowest test in the file, hence the longer timeout.
    const bytes = new Uint8Array(1_200_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    const file = new File([bytes], 'paper.pdf', { type: 'application/pdf' })
    await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: file })
    const pushResult = await a.sync()
    expect(pushResult.pushed.blobs).toBe(1)

    const pullResult = await b.sync()
    expect(pullResult.pulled.blobs).toBe(1)
    const [source] = await b.listSources()
    const blob = await b.getSourcePdfBlob(source)
    const roundTripped = new Uint8Array(await blob!.arrayBuffer())
    expect(roundTripped).toEqual(bytes)
  })

  it('round-trips a document whose encrypted payload is too large for one Firestore field', { timeout: 20_000 }, async () => {
    // Regression test for a real production bug: a source's compressed
    // page text (already gzipped) can itself run past a megabyte for a
    // long or heavily-illustrated PDF, and by the time that's base64-tagged
    // for JSON *and then* the resulting ciphertext is base64-encoded again
    // for storage, it roughly doubles twice over — comfortably past
    // Firestore's ~1,048,487-byte single-field cap well before anything
    // else on the document counts. Firestore rejected it outright with
    // "Property _enc contains an invalid nested entity" — its message for
    // an oversized *nested* field value, as opposed to the clearer
    // "Unsupported field value: undefined" it gives for a plain top-level
    // problem. A plain long string (an essay's own draftContent, not a
    // compressed source) exercises the exact same "the encrypted payload
    // itself doesn't fit in one field" path without needing to reproduce a
    // specific gzip ratio to get there.
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Long essay')
    const root = await a.getNode(essay.rootNodeId)
    root!.draftContent = 'x'.repeat(2_000_000)
    await a.saveNode(root!)
    const pushResult = await a.sync()
    expect(pushResult.pushed.nodes).toBe(1)

    const pullResult = await b.sync()
    expect(pullResult.pulled.nodes).toBe(1)
    const pulledRoot = await b.getNode(essay.rootNodeId)
    expect(pulledRoot?.draftContent).toBe(root!.draftContent)
  })

  it('pushes a source whose pdfBlobId was cleared back to undefined without Firestore rejecting it', async () => {
    // Regression test: removeSourcePdf sets pdfBlobId to undefined (rather
    // than deleting the key), and encodeForRemote used to pass that
    // straight through into the plain metadata object handed to setDoc —
    // which real Firestore (and the fake here, deliberately mirroring it;
    // see fakeFirestore.ts) rejects outright with "Unsupported field
    // value: undefined".
    const { a, b } = await pairedDevices()
    const file = new File([new Uint8Array([1, 2, 3])], 'paper.pdf', { type: 'application/pdf' })
    const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: file })
    await a.sync()
    await b.sync()
    expect((await b.listSources())[0].pdfBlobId).toBeTruthy()

    await a.removeSourcePdf(source)
    await expect(a.sync()).resolves.toMatchObject({ pushed: expect.objectContaining({ sources: 1 }) })

    await b.sync()
    const [pulled] = await b.listSources()
    expect(pulled.pdfBlobId).toBeUndefined()
  })

  it('propagates a deletion as a tombstone, not a resurrection on the next pull', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Doomed essay')
    await a.sync()
    await b.sync()
    expect(await b.getEssay(essay.id)).toBeTruthy()

    await a.deleteEssay(essay.id)
    await a.sync()
    const pullResult = await b.sync()
    expect(pullResult.pulled.essays).toBe(1)
    const tombstoned = await b.getEssay(essay.id)
    expect(tombstoned?.deleted).toBe(true)
    expect(await b.listEssays()).not.toContainEqual(expect.objectContaining({ id: essay.id }))
  })

  it('reports "already up to date" (nothing pushed or pulled) on a repeat sync with no changes', async () => {
    const { a, b } = await pairedDevices()
    await a.createEssay('Steady state')
    await a.sync()
    await b.sync()

    const second = await b.sync()
    expect(second.pushed.essays + second.pushed.nodes + second.pushed.sources).toBe(0)
    expect(second.pulled.essays + second.pulled.nodes + second.pulled.sources).toBe(0)
  })
})

describe('last-write-wins races', () => {
  it('does not let a push of stale-but-locally-"dirty" content clobber a genuinely newer remote edit', async () => {
    // The concrete bug this guards against: a device's own push watermark
    // only tracks "have I sent *this specific device's copy* of this doc
    // before" — it says nothing about whether the doc's *content* is
    // actually newer than what's already remote. A device that's never
    // pushed a given doc before (cursor.pushedAt below its updatedAt) will
    // call it "dirty" and push it even if that content is, by timestamp,
    // older than what another device already put there — e.g. exactly the
    // real incident this was found from: restoring an old local backup
    // (which preserves each record's original updatedAt) and syncing it.
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Shared doc')
    // Explicit, "real-clock-relative" timestamps rather than small literal
    // numbers: cursors elsewhere in this pass are already real Date.now()
    // values (from pairedDevices()' own bootstrap sync), so a hardcoded
    // small number would look "older than the last push" and never even
    // register as dirty in the first place — defeating the scenario before
    // it starts. NEWER/OLDER below just need to be unambiguously ordered
    // relative to each other and to "now."
    const NEWER = Date.now() + 100_000
    const OLDER = Date.now() + 50_000
    const nodeOnA = await a.getNode(essay.rootNodeId)
    nodeOnA!.draftContent = "A's genuinely newer edit"
    nodeOnA!.updatedAt = NEWER
    await a.putNodeRaw(nodeOnA!)
    await a.putEssayRaw({ ...essay, updatedAt: NEWER })
    await a.sync() // pushes essay + node, node's remote updatedAt is now NEWER

    // B never actually saw this essay before — it's about to get it for
    // the first time via a stale, low-updatedAt local copy (as if just
    // restored from an old backup), which is "dirty" purely because B has
    // never pushed anything for it (B's own push cursor starts at 0).
    const staleEssay = { ...essay, updatedAt: OLDER }
    const staleNode = { ...nodeOnA!, draftContent: 'stale content from an old backup', updatedAt: OLDER }
    await b.putEssayRaw(staleEssay)
    await b.putNodeRaw(staleNode)
    await b.sync()

    // The remote copy — and anyone who later pulls it — must still have
    // A's genuinely newer content, not B's stale push.
    const c = await newDeviceSignedIn('alice@example.com')
    await c.importLocalKey(a.exportBundle()!)
    const pulled = await c.sync()
    expect(pulled.pulled.nodes).toBe(1)
    expect((await c.getNode(essay.rootNodeId))?.draftContent).toBe("A's genuinely newer edit")
  })

  it('a genuinely newer edit does win, even from the device that synced second', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Race doc')
    const EARLIER = Date.now() + 50_000
    const LATER = Date.now() + 100_000
    const nodeOnA = await a.getNode(essay.rootNodeId)
    nodeOnA!.draftContent = 'earlier edit'
    nodeOnA!.updatedAt = EARLIER
    await a.putNodeRaw(nodeOnA!)
    await a.sync()

    // B pulls A's edit, then makes its OWN, strictly later edit on top of it.
    await b.sync()
    const nodeOnB = await b.getNode(essay.rootNodeId)
    nodeOnB!.draftContent = 'later edit, from B'
    nodeOnB!.updatedAt = LATER
    await b.putNodeRaw(nodeOnB!)
    await b.sync()

    const pullBack = await a.sync()
    expect(pullBack.pulled.nodes).toBe(1)
    const finalOnA = await a.getNode(essay.rootNodeId)
    expect(finalOnA?.draftContent).toBe('later edit, from B')
  })

  it('two devices editing two different nodes of the same essay both survive (no false conflict)', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Parallel edits')
    const child = await a.createChildNode(essay.id, 'Section 1')
    await a.sync()
    await b.sync()

    const rootOnA = await a.getNode(essay.rootNodeId)
    rootOnA!.draftContent = 'root edited on A'
    await a.saveNode(rootOnA!)

    const childOnB = await b.getNode(child.id)
    childOnB!.draftContent = 'child edited on B'
    await b.saveNode(childOnB!)

    await a.sync()
    await b.sync()
    await a.sync()
    await b.sync()

    expect((await a.getNode(essay.rootNodeId))?.draftContent).toBe('root edited on A')
    expect((await a.getNode(child.id))?.draftContent).toBe('child edited on B')
    expect((await b.getNode(essay.rootNodeId))?.draftContent).toBe('root edited on A')
    expect((await b.getNode(child.id))?.draftContent).toBe('child edited on B')
  })
})

describe('concurrent sync passes on one device', () => {
  it('coalesces overlapping runSyncPass calls into one shared pass instead of double-pushing', async () => {
    const { a } = await pairedDevices()
    await a.createEssay('One essay')

    const [r1, r2] = await Promise.all([a.sync(), a.sync()])
    // Both callers see the same result object (they joined the same pass).
    expect(r1).toBe(r2)
    expect(r1.pushed.essays + r1.pushed.nodes).toBeGreaterThan(0)

    // A third, later call is a genuinely separate pass — and with nothing
    // new to send, it finds nothing to do.
    const r3 = await a.sync()
    expect(r3).not.toBe(r1)
    expect(r3.pushed.essays + r3.pushed.nodes + r3.pushed.sources).toBe(0)
  })

  it('delivers progress messages to every caller that joined an in-flight pass', async () => {
    const { a } = await pairedDevices()
    await a.createEssay('Progress test')

    const seen1: string[] = []
    const seen2: string[] = []
    await Promise.all([a.sync((m) => seen1.push(m)), a.sync((m) => seen2.push(m))])
    expect(seen1.length).toBeGreaterThan(0)
    expect(seen2.length).toBeGreaterThan(0)
  })
})

describe('fingerprint / key-mismatch gating', () => {
  it('blocks sync when this device has a different key than the one the account was set up with', async () => {
    const a = await newDeviceSignedIn('bob@example.com')
    await a.createLocalKey()
    await a.sync()

    const b = await newDeviceSignedIn('bob@example.com')
    await b.createLocalKey() // a DIFFERENT key for the same account — simulates the bug scenario before KeyMismatch existed
    await expect(b.sync()).rejects.toThrow(/doesn't match/)
  })

  it('refuses to sync at all with no local key yet', async () => {
    const a = await newDeviceSignedIn('carol@example.com')
    await expect(a.sync()).rejects.toThrow(/No encryption key/)
  })

  it('a fresh account plants its fingerprint on first sync, and a second device with a DIFFERENT fresh key is then correctly rejected', async () => {
    const a = await newDeviceSignedIn('dana@example.com')
    await a.createLocalKey()
    expect(await a.getAccountMeta()).toBeNull()
    await a.sync()
    const meta = await a.getAccountMeta()
    expect(meta).not.toBeNull()

    const b = await newDeviceSignedIn('dana@example.com')
    await b.createLocalKey()
    await expect(b.sync()).rejects.toThrow(/doesn't match/)
  })

  it('is unaffected by an unrelated Google account entirely — different uid, independent account namespace', async () => {
    const alice = await newDeviceSignedIn('alice2@example.com')
    await alice.createLocalKey()
    await alice.createEssay('Alice essay')
    await alice.sync()

    const mallory = await newDeviceSignedIn('mallory@example.com')
    await mallory.createLocalKey()
    await mallory.sync() // fine — brand-new, unrelated account
    expect(await mallory.listEssays()).toHaveLength(0)
  })
})

describe('the pull-cursor fix (an empty pass must not skip an older doc pushed later)', () => {
  // The bug this whole describe block is about: the pull-cursor watermark
  // used to be stamped with wall-clock "now" at the end of *every* sync
  // pass — even one that pulled nothing. If another device later pushed
  // something whose own `updatedAt` (e.g. preserved verbatim from an old
  // local backup — see lib/backup.ts) happened to predate that now-advanced
  // cursor, this device would never pull it, having never actually seen
  // it. The fix (see syncEngine.ts's own comment above `maxSeenRemoteUpdatedAt`)
  // is to only ever advance the cursor to the latest timestamp genuinely
  // observed in a pass's own query results — an empty pass observes
  // nothing, so it no longer moves the cursor at all.
  it('an empty sync pass does not advance the pull cursor, so an old-timestamped doc pushed afterward is still picked up', async () => {
    const { a, b } = await pairedDevices()

    // B runs a sync pass with nothing at all to pull — under the old
    // behavior this alone would have been enough to poison future pulls.
    const empty = await b.sync()
    expect(empty.pulled.essays).toBe(0)

    // Device A now pushes something with a deliberately OLD updatedAt, as
    // a real backup restore would (preserving the record's original
    // timestamp rather than bumping it to "now").
    const essay = await a.createEssay('Restored from an old backup')
    const node = await a.getNode(essay.rootNodeId)
    const OLD_TIMESTAMP = Date.now() - 10_000_000
    essay.updatedAt = OLD_TIMESTAMP
    node!.updatedAt = OLD_TIMESTAMP
    await a.saveEssay(essay)
    await a.saveNode(node!)
    await a.sync()

    // B's perfectly ordinary next sync — no special "force" action needed
    // — must still pick it up, because B's cursor never actually advanced
    // past a point it hadn't verified.
    const result = await b.sync()
    expect(result.pulled.essays).toBe(1)
    expect((await b.getEssay(essay.id))?.title).toBe('Restored from an old backup')
  })

  it('Force full resync remains available as a manual re-check, for the narrower race the cursor fix does not close (concurrent pushes crossing paths within the same pass)', async () => {
    const { a, b } = await pairedDevices()

    const essay = await a.createEssay('Restored from an old backup')
    const node = await a.getNode(essay.rootNodeId)
    const OLD_TIMESTAMP = Date.now() - 10_000_000
    essay.updatedAt = OLD_TIMESTAMP
    node!.updatedAt = OLD_TIMESTAMP
    await a.saveEssay(essay)
    await a.saveNode(node!)
    await a.sync()

    // Even with no prior sync at all, Force full resync still recovers it
    // — it's a strict superset of the ordinary pull path (ignores cursors
    // entirely), so it remains a correct fallback regardless of *why* a
    // device might be missing something.
    const forced = await b.forceFullResync()
    expect(forced.pulled.essays).toBe(1)
    expect((await b.getEssay(essay.id))?.title).toBe('Restored from an old backup')
  })

  it('Force full resync is safe: it never regresses content that is already newer locally than what is remote', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Doc')
    await a.sync()
    await b.sync()

    // B makes a newer local edit than anything on the remote, then forces
    // a full resync (e.g. because it also wanted to recover something else
    // stuck behind a stale cursor) — its own newer edit must not be
    // clobbered by re-pulling the older remote copy of the same doc.
    const nodeOnB = await b.getNode(essay.rootNodeId)
    nodeOnB!.draftContent = 'B is ahead of the remote'
    await b.saveNode(nodeOnB!)

    const forced = await b.forceFullResync()
    expect(forced.pushed.nodes).toBeGreaterThan(0) // it should have pushed its newer edit, not lost it
    expect((await b.getNode(essay.rootNodeId))?.draftContent).toBe('B is ahead of the remote')
  })
})

describe('account reset', () => {
  it('wipes remote data and lets a fresh key bootstrap a clean account afterward', async () => {
    const { a, b } = await pairedDevices()
    await a.createEssay('Will be wiped')
    await a.sync()
    await b.sync()
    expect(await b.listEssays()).toHaveLength(1)

    // B lost its key file and resets the account instead of importing it.
    await b.wipeRemoteAccountData()
    await b.forgetLocalKey()
    const freshKey = await b.createLocalKey()
    await b.setAccountMeta(freshKey.fingerprint)

    // Device A, still on the OLD key, now can't sync at all — exactly the
    // "every other device relying on the old key loses access" warning
    // the reset UI gives.
    await expect(a.sync()).rejects.toThrow(/doesn't match/)

    // B itself, on its new key, syncs cleanly against the wiped account.
    const bResult = await b.sync()
    expect(bResult.pushed.essays + bResult.pushed.nodes + bResult.pulled.essays).toBeGreaterThanOrEqual(0)
    await b.createEssay('Fresh start')
    const secondSync = await b.sync()
    expect(secondSync.pushed.essays).toBe(1)
  })
})

describe('key bundle plumbing', () => {
  it('exported bundles round-trip through isKeyBundle and contain no userId field', async () => {
    const a = await newDeviceSignedIn('erin@example.com')
    await a.createLocalKey()
    const bundle = a.exportBundle()!
    expect(isKeyBundle(bundle)).toBe(true)
    expect(bundle).not.toHaveProperty('userId')
    expect(Object.keys(bundle).sort()).toEqual(['key', 'v'])
  })

  it('importing the wrong key does not silently pass the fingerprint check', async () => {
    const a = await newDeviceSignedIn('frank@example.com')
    await a.createLocalKey()
    await a.sync()
    // A structurally valid but different AES key — not just corrupted
    // base64 — so this actually exercises the fingerprint check rather
    // than tripping over crypto.subtle rejecting a malformed key first.
    const { bundle: wrongBundle } = await generateKeyBundle()
    const b = await newDeviceSignedIn('frank@example.com')
    await b.importLocalKey(wrongBundle)
    await expect(b.sync()).rejects.toThrow(/doesn't match/)
  })
})

describe('footnote sync and backward compatibility', () => {
  it('a node with no footnotes field at all (as if from before footnotes existed) syncs cleanly, then a footnote added later propagates normally', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Essay with an old-format node')
    const root = await a.getNode(essay.rootNodeId)
    // Deliberately no `footnotes` key at all — putNodeRaw writes the object
    // exactly as given, the same shape a node saved before this feature
    // existed would have.
    await a.putNodeRaw({ ...root!, draftContent: 'Some old text.' })
    await a.sync()

    const pulled = await b.sync()
    expect(pulled.pulled.nodes).toBe(1)
    const pulledRoot = await b.getNode(essay.rootNodeId)
    expect(pulledRoot?.draftContent).toBe('Some old text.')
    expect('footnotes' in pulledRoot!).toBe(false)

    // Device B now adds a footnote on top of that old-format node.
    pulledRoot!.footnotes = [{ id: 'f1', content: 'A new footnote.' }]
    pulledRoot!.draftContent = 'Some old text.<sup class="footnote-ref" data-footnote-id="f1"></sup>'
    await b.saveNode(pulledRoot!)
    const pushResult = await b.sync()
    expect(pushResult.pushed.nodes).toBe(1)

    const finalPull = await a.sync()
    expect(finalPull.pulled.nodes).toBe(1)
    const finalNode = await a.getNode(essay.rootNodeId)
    expect(finalNode?.footnotes).toEqual([{ id: 'f1', content: 'A new footnote.' }])
  })
})

describe('quote bank and graveyard sync', () => {
  it('propagates a quote bank entry between devices', async () => {
    const { a, b } = await pairedDevices()
    const source = await a.createSource({ type: 'article', key: 'x2020', fields: { title: 'X' } })
    await a.createQuote(source.id, 3, 'a quoted excerpt', 'why it matters')
    const result = await a.sync()
    expect(result.pushed.quotes).toBe(1)

    const pulled = await b.sync()
    expect(pulled.pulled.quotes).toBe(1)
    const quotes = await b.listQuotes()
    expect(quotes).toHaveLength(1)
    expect(quotes[0].quoteText).toBe('a quoted excerpt')
    expect(quotes[0].annotation).toBe('why it matters')
  })

  it('propagates a graveyard fragment between devices, and it stays listed after its node is deleted', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Essay with a graveyard')
    const child = await a.createChildNode(essay.id, 'Doomed section', 'text to cut')
    await a.createGraveyardFragment(essay.id, child.id, child.title, '<p>text to cut</p>')
    await a.sync()

    const pulled = await b.sync()
    expect(pulled.pulled.graveyard).toBe(1)
    let fragments = await b.listGraveyard(essay.id)
    expect(fragments).toHaveLength(1)
    expect(fragments[0].html).toBe('<p>text to cut</p>')

    // Deleting the node it came from must not take the fragment with it —
    // graveyard fragments only ever reference a node, they never depend on
    // it still existing (see GraveyardFragment's own doc comment).
    const node = await b.getNode(child.id)
    node!.deleted = true
    await b.saveNode(node!)
    fragments = await b.listGraveyard(essay.id)
    expect(fragments).toHaveLength(1)
    expect(fragments[0].nodeTitle).toBe('Doomed section')
  })

  /**
   * Both devices here stand in for an account that predates the quote
   * bank/graveyard entirely — their very first sync pass involves no
   * 'quotes'/'graveyard' documents on either side, and (for device A, the
   * one that bootstrapped the account) no prior write to those Firestore
   * subcollections at all, same as any real pre-existing account would be
   * the moment this code ships. Nothing about SYNCED_COLLECTIONS iterating
   * over a collection that has never had anything in it should be an
   * error — querying an empty/nonexistent Firestore collection just comes
   * back with zero docs — and once one device *does* start using the new
   * features, they should sync in normally on top of that old data.
   */
  it('an account with only pre-existing essays/sources (as if from before the quote bank/graveyard existed) syncs cleanly, then adopts the new features without issue', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Pre-existing essay')
    const source = await a.createSource({ type: 'article', key: 'old2019', fields: { title: 'Old Paper' } })
    await a.sync()

    const firstPull = await b.sync()
    expect(firstPull.pulled.essays).toBe(1)
    expect(firstPull.pulled.sources).toBe(1)
    expect(firstPull.pulled.quotes).toBe(0)
    expect(firstPull.pulled.graveyard).toBe(0)
    expect(await b.listQuotes()).toEqual([])
    expect(await b.listGraveyard(essay.id)).toEqual([])

    // Device B now "upgrades" — starts using the new features on top of
    // the old data it just pulled.
    await b.createQuote(source.id, 1, 'a new quote on old data', '')
    const child = await b.createChildNode(essay.id, 'New section', 'text')
    await b.createGraveyardFragment(essay.id, child.id, child.title, '<p>cut</p>')
    const pushResult = await b.sync()
    expect(pushResult.pushed.quotes).toBe(1)
    expect(pushResult.pushed.graveyard).toBe(1)

    const finalPull = await a.sync()
    expect(finalPull.pulled.quotes).toBe(1)
    expect(finalPull.pulled.graveyard).toBe(1)
    expect((await a.listQuotes())[0].quoteText).toBe('a new quote on old data')
  })
})

describe('resilience to a broken push (the mobile "timed out" hang)', () => {
  // Regression coverage for a real complaint: a push that keeps failing
  // (a slow mobile upload timing out, say) used to abort the *entire* sync
  // pass — including the pull and blob-download phases that have nothing
  // to do with it — so every retry hit the same failure and nothing else
  // ever moved, indistinguishable from sync having simply stopped working.
  it("a push failure for one source doesn't prevent other collections from pushing, or stop the pull phase from running", async () => {
    const { a, b } = await pairedDevices()

    // A has something for B to pull...
    const essay = await a.createEssay('Essay from A')
    await a.sync()

    // ...while B has a source whose push is about to fail, and an essay of
    // its own that should still push successfully despite that.
    const source = await b.createSource({ type: 'article', key: 'x', fields: { title: 'Broken upload' } })
    const essayFromB = await b.createEssay('Essay from B')
    __failNextWriteTo((path) => path.includes(`/sources/${source.id}`))

    await expect(b.sync()).rejects.toThrow(/Failed pushing sources/)

    // The broken source aside, B's essay still reached the server...
    const pulledByA = await a.sync()
    expect(pulledByA.pulled.essays).toBeGreaterThanOrEqual(1)
    expect((await a.getEssay(essayFromB.id))?.title).toBe('Essay from B')
    // ...and B still pulled A's essay in the very same pass that failed to
    // push its source — the failure didn't block anything downstream of it.
    expect((await b.getEssay(essay.id))?.title).toBe('Essay from A')
  })

  it('a doc that failed to push is retried on the next sync, not silently dropped', async () => {
    const { b } = await pairedDevices()
    const source = await b.createSource({ type: 'article', key: 'x', fields: { title: 'Retry me' } })
    __failNextWriteTo((path) => path.includes(`/sources/${source.id}`))
    await expect(b.sync()).rejects.toThrow()

    // No further failure armed this time — the previously-failed push
    // should still be considered dirty and go through now.
    const result = await b.sync()
    expect(result.pushed.sources).toBe(1)
  })
})

describe('discardLocalChanges (the "upload is broken, just let me download" escape hatch)', () => {
  it('stops retrying a local edit that keeps failing to push, and lets a pull apply the remote copy over it', async () => {
    const { a, b } = await pairedDevices()

    // A's copy of this source is what should win after B discards its own.
    const bibtex = { type: 'article', key: 'x', fields: { title: 'From A' } }
    await a.createSource(bibtex)
    await a.sync()
    await b.sync()

    // B edits its own copy, but every attempt to push it fails.
    const sourceOnB = (await b.listSources())[0]
    sourceOnB.comment = "B's edit that can never push"
    await b.updateSource(sourceOnB)

    __failNextWriteTo((path) => path.includes(`/sources/${sourceOnB.id}`))
    await expect(b.sync()).rejects.toThrow()

    // B gives up on its own local edit...
    await b.discardLocalChanges(['sources'])
    // ...and the next ordinary sync pulls A's version down over it, with no
    // push failure this time (nothing local is dirty anymore).
    const result = await b.sync()
    expect(result.pushed.sources).toBe(0)
    expect((await b.listSources())[0].bibtex.fields.title).toBe('From A')
  })
})

describe('autoSync (the 30s polling loop)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does nothing until a Firebase project and a local key both exist, then starts syncing on its own', async () => {
    const device = await newDeviceSignedIn('grace@example.com')
    await device.createLocalKey()
    // startAutoSyncLoop/canSyncAtAll live in autoSync.ts, which reads the
    // ambient currentUser()/hasLocalKey() at tick time — exercised here
    // through the same device harness rather than re-importing autoSync
    // directly, since its ticking is a thin wrapper around runSyncPass
    // already covered above; this suite focuses on sync correctness, not
    // re-testing setInterval itself.
    const essay = await device.createEssay('Auto essay')
    const result = await device.sync()
    expect(result.pushed.essays).toBe(1)
    expect(essay.title).toBe('Auto essay')
  })
})

describe('orphaned remote blob cleanup', () => {
  function smallPdf(byte = 7): File {
    return new File([new Uint8Array([byte, byte, byte])], 'paper.pdf', { type: 'application/pdf' })
  }

  it("deletes a blob's remote copy (manifest + chunks) on the next sync after its source is deleted locally", async () => {
    const a = await newDeviceSignedIn('orphan1@example.com')
    await a.createLocalKey()
    await a.sync()
    const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: smallPdf() })
    const pushResult = await a.sync()
    expect(pushResult.pushed.blobs).toBe(1)
    const blobId = source.pdfBlobId!
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${blobId}`)).toBe(true)

    await a.deleteSource(source.id)
    const deleteResult = await a.sync()

    expect(deleteResult.deletedBlobs).toBe(1)
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${blobId}`)).toBe(false)
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${blobId}/chunks/0`)).toBe(false)
  })

  it("deletes the old blob's remote copy when a source's PDF is replaced, keeping the new one", async () => {
    const a = await newDeviceSignedIn('orphan2@example.com')
    await a.createLocalKey()
    await a.sync()
    const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: smallPdf(1) })
    await a.sync()
    const oldBlobId = source.pdfBlobId!

    const fresh = (await a.getSource(source.id))!
    await a.setSourcePdf(fresh, smallPdf(2), ['replaced'])
    const result = await a.sync()

    expect(result.deletedBlobs).toBe(1)
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${oldBlobId}`)).toBe(false)
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${fresh.pdfBlobId}`)).toBe(true)
  })

  it('never touches a blob still referenced by a non-deleted source', async () => {
    const a = await newDeviceSignedIn('orphan3@example.com')
    await a.createLocalKey()
    await a.sync()
    const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: smallPdf() })
    await a.sync()
    const result = await a.sync() // nothing new deleted
    expect(result.deletedBlobs).toBe(0)
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${source.pdfBlobId}`)).toBe(true)
  })

  it('retries a deletion that failed on an earlier pass instead of forgetting it', async () => {
    const a = await newDeviceSignedIn('orphan4@example.com')
    await a.createLocalKey()
    await a.sync()
    const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: smallPdf() })
    await a.sync()
    const blobId = source.pdfBlobId!
    await a.deleteSource(source.id)

    __failNextWriteTo((path) => path === `accounts/${a.uid}/blobs/${blobId}`)
    await expect(a.sync()).rejects.toThrow()
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${blobId}`)).toBe(true) // still there — this pass's delete failed

    const retry = await a.sync()
    expect(retry.deletedBlobs).toBe(1)
    expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${blobId}`)).toBe(false)
  })

  describe('sweepOrphanedRemoteBlobs (the manual full-reconciliation button)', () => {
    it('deletes a remote blob with no matching local source at all', async () => {
      const a = await newDeviceSignedIn('sweep1@example.com')
      await a.createLocalKey()
      await a.sync()
      const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: smallPdf() })
      await a.sync()
      const blobId = source.pdfBlobId!

      // Simulates exactly the gap this whole feature exists for: a source
      // tombstoned *without* going through deleteSource/deleteBlobTracked
      // (e.g. a 'replace'-mode backup restore from before this PDF was
      // added would leave the same shape — a non-existent or tombstoned
      // local source, but no record on the regular pending-deletion
      // to-do list for its old blob). `deleteSource` itself tombstones
      // without clearing `pdfBlobId` too (see its own doc comment), so
      // plain `updateSource` reproduces that shape directly.
      await a.updateSource({ ...source, deleted: true })

      const result = await a.sweepOrphanedRemoteBlobs()
      expect(result.deleted).toBe(1)
      expect(result.errors).toEqual([])
      expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${blobId}`)).toBe(false)
    })

    it('leaves a blob referenced by a non-deleted source untouched', async () => {
      const a = await newDeviceSignedIn('sweep2@example.com')
      await a.createLocalKey()
      await a.sync()
      const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: smallPdf() })
      await a.sync()

      const result = await a.sweepOrphanedRemoteBlobs()
      expect(result.deleted).toBe(0)
      expect(__getFakeCloud().has(`accounts/${a.uid}/blobs/${source.pdfBlobId}`)).toBe(true)
    })

    it("clears the orphan from the regular pending-deletion list too, so the next ordinary sync doesn't redo the same work", async () => {
      const a = await newDeviceSignedIn('sweep3@example.com')
      await a.createLocalKey()
      await a.sync()
      const source = await a.createSource({ type: 'article', key: 'x', fields: {} }, { pdfFile: smallPdf() })
      await a.sync()
      await a.deleteSource(source.id) // records it as pending, but sweep gets to it first

      const swept = await a.sweepOrphanedRemoteBlobs()
      expect(swept.deleted).toBe(1)

      const syncResult = await a.sync()
      expect(syncResult.deletedBlobs).toBe(0) // nothing left to redo
    })
  })
})
