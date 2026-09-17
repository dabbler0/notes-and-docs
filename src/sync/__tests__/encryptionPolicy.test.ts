/**
 * The "every user-editable field is encrypted at rest" policy — what's
 * actually sitting in the remote doc for a fresh push (nothing sensitive
 * ever in plaintext, system-generated ids/timestamps still are, since
 * Firestore has to query `updatedAt` server-side), and the automatic
 * migration of an account whose remote data predates that policy.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { newDeviceSignedIn, type Device } from '../../test/deviceHarness'
import { __getFakeCloud, __resetFakeCloud } from '../../test/fakeFirestore'
import { CURRENT_ENCRYPTION_VERSION } from '../collections'

beforeEach(() => {
  __resetFakeCloud()
})

async function pairedDevices(email = 'alice@example.com'): Promise<{ a: Device; b: Device }> {
  const a = await newDeviceSignedIn(email)
  await a.createLocalKey()
  await a.sync()
  const bundle = a.exportBundle()!
  const b = await newDeviceSignedIn(email)
  await b.importLocalKey(bundle)
  return { a, b }
}

function rawRemoteDoc(uid: string, collectionName: string, id: string): Record<string, unknown> {
  const doc = __getFakeCloud().get(`accounts/${uid}/${collectionName}/${id}`)
  if (!doc) throw new Error(`no remote doc at accounts/${uid}/${collectionName}/${id}`)
  return doc
}

describe('every user-editable field is encrypted on a fresh push', () => {
  it('never leaves an essay title, a node title, or a source bibtex/comment/filename in plaintext', async () => {
    const { a } = await pairedDevices()
    const essay = await a.createEssay('A Secret Working Title')
    const root = await a.getNode(essay.rootNodeId)
    root!.title = 'Also Secret'
    await a.saveNode(root!)
    const source = await a.createSource({ type: 'article', key: 'x2020', fields: { title: 'Secret Paper Title', author: 'Secret Author' } }, { comment: 'a private note' })
    await a.sync()

    const essayDoc = rawRemoteDoc(a.uid!, 'essays', essay.id)
    expect(essayDoc.title).toBeUndefined()
    expect(essayDoc._enc).toBeDefined()
    expect(essayDoc.id).toBe(essay.id)
    expect(typeof essayDoc.updatedAt).toBe('number')

    const nodeDoc = rawRemoteDoc(a.uid!, 'nodes', root!.id)
    expect(nodeDoc.title).toBeUndefined()
    expect(nodeDoc.essayId).toBe(essay.id) // a system-generated reference — fine to stay plaintext

    const sourceDoc = rawRemoteDoc(a.uid!, 'sources', source.id)
    expect(sourceDoc.bibtex).toBeUndefined()
    expect(sourceDoc.comment).toBeUndefined()
    expect(sourceDoc._enc).toBeDefined()
    expect(sourceDoc.id).toBe(source.id)
  })

  it('encrypts a quote bank entry\'s page number along with its text/annotation', async () => {
    const { a } = await pairedDevices()
    const source = await a.createSource({ type: 'article', key: 'y2021', fields: { title: 'Y' } })
    await a.createQuote(source.id, 42, 'a quoted excerpt', 'why it matters')
    await a.sync()

    const quoteDocs = [...__getFakeCloud().entries()].filter(([path]) => path.startsWith(`accounts/${a.uid}/quotes/`))
    expect(quoteDocs).toHaveLength(1)
    const [, quoteDoc] = quoteDocs[0]
    expect(quoteDoc.page).toBeUndefined()
    expect(quoteDoc.quoteText).toBeUndefined()
    expect(quoteDoc.sourceId).toBe(source.id) // identifier — stays plaintext
  })

  it('round-trips correctly to a second device despite everything being encrypted', async () => {
    const { a, b } = await pairedDevices()
    const essay = await a.createEssay('Round Trip Title')
    await a.sync()
    await b.sync()
    const pulled = await b.getEssay(essay.id)
    expect(pulled?.title).toBe('Round Trip Title')
  })
})

describe('migrating an account from the old (partially-plaintext) encryption policy', () => {
  /** Writes a remote essay/source directly, in the *old* (pre-encrypted-title) shape a real pre-migration account's data would actually be in — bypassing the app's own (already-updated) push path entirely, since the whole point is to simulate data that predates it. */
  function seedLegacyData(uid: string, now: number) {
    __getFakeCloud().set(`accounts/${uid}/essays/essay1`, {
      id: 'essay1',
      title: 'Legacy Plaintext Title',
      rootNodeId: 'node1',
      createdAt: now,
      updatedAt: now,
    })
    __getFakeCloud().set(`accounts/${uid}/sources/source1`, {
      id: 'source1',
      bibtex: { type: 'article', key: 'legacy2019', fields: { title: 'Legacy Paper', author: 'Legacy Author' } },
      comment: 'a legacy comment',
      createdAt: now,
      updatedAt: now,
    })
  }

  it('migrates legacy essay/source data to the current policy on the next sync, preserving updatedAt', async () => {
    const a = await newDeviceSignedIn('legacy@example.com')
    await a.createLocalKey()
    await a.sync() // bootstraps meta at the current encryption version — reset below to simulate a pre-existing account
    await a.setAccountMeta((await a.getAccountMeta())!.keyFingerprint, 1)

    const now = 1_000_000
    seedLegacyData(a.uid!, now)

    const before = rawRemoteDoc(a.uid!, 'essays', 'essay1')
    expect(before.title).toBe('Legacy Plaintext Title')
    expect(before._enc).toBeUndefined()

    const result = await a.sync()
    expect(result.pulled.essays).toBe(1)

    const after = rawRemoteDoc(a.uid!, 'essays', 'essay1')
    expect(after.title).toBeUndefined()
    expect(after._enc).toBeDefined()
    expect(after.updatedAt).toBe(now) // migration must never look like a new edit
    expect(after.createdAt).toBe(now)

    const sourceAfter = rawRemoteDoc(a.uid!, 'sources', 'source1')
    expect(sourceAfter.bibtex).toBeUndefined()
    expect(sourceAfter.comment).toBeUndefined()
    expect(sourceAfter._enc).toBeDefined()

    const meta = await a.getAccountMeta()
    expect(meta?.encryptionVersion).toBe(CURRENT_ENCRYPTION_VERSION)

    // And the migrated data is actually usable locally, not just re-shaped.
    const pulledEssay = await a.getEssay('essay1')
    expect(pulledEssay?.title).toBe('Legacy Plaintext Title')
    const pulledSource = await a.getSource('source1')
    expect(pulledSource?.bibtex.fields.title).toBe('Legacy Paper')
    expect(pulledSource?.comment).toBe('a legacy comment')
  })

  it('only migrates once — a second sync does not re-touch already-migrated data', async () => {
    const a = await newDeviceSignedIn('legacy2@example.com')
    await a.createLocalKey()
    await a.sync()
    await a.setAccountMeta((await a.getAccountMeta())!.keyFingerprint, 1)
    seedLegacyData(a.uid!, 2_000_000)

    const messages: string[] = []
    await a.sync((m) => messages.push(m))
    expect(messages.some((m) => m.includes('Upgrading'))).toBe(true)

    const messages2: string[] = []
    await a.sync((m) => messages2.push(m))
    expect(messages2.some((m) => m.includes('Upgrading'))).toBe(false)
  })

  it('a brand-new account never runs the migration at all', async () => {
    const a = await newDeviceSignedIn('fresh@example.com')
    await a.createLocalKey()
    const messages: string[] = []
    await a.sync((m) => messages.push(m))
    expect(messages.some((m) => m.includes('Upgrading'))).toBe(false)
    const meta = await a.getAccountMeta()
    expect(meta?.encryptionVersion).toBe(CURRENT_ENCRYPTION_VERSION)
  })
})
