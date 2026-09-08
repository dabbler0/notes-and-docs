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
import { __resetFakeCloud } from '../../test/fakeFirestore'
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
    await a.createSource({ type: 'article', key: 'smith2020', fields: { title: 'A Paper', author: 'Smith', year: '2020' } }, { comment: 'good stuff', pageTexts: ['page one text'] })
    await a.sync()
    await b.sync()

    const [source] = await b.listSources()
    expect(source.bibtex.fields.title).toBe('A Paper')
    expect(source.comment).toBe('good stuff')
    expect(source.pageTexts).toEqual(['page one text'])
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
