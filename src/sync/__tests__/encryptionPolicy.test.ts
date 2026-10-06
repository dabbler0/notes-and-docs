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
import { CURRENT_REMOTE_SCHEMA_VERSION } from '../collections'
import { decryptJson, encryptJson, generateKeyBundle, type EncryptedField } from '../../lib/crypto'
import { gzipCompress, gzipDecompress } from '../../lib/compression'

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

  it("encrypts a source's extracted PDF/text-only page text, not just its bibtex/comment", async () => {
    const { a, b } = await pairedDevices()
    const source = await a.createSource(
      { type: 'article', key: 'z2022', fields: { title: 'Z' } },
      { pageHtml: ['Secret extracted page one text.', 'Secret extracted page two text.'] },
    )
    await a.sync()

    const sourceDoc = rawRemoteDoc(a.uid!, 'sources', source.id)
    expect(sourceDoc.pageHtml).toBeUndefined()
    expect(JSON.stringify(sourceDoc)).not.toContain('Secret extracted page')
    expect(sourceDoc._enc).toBeDefined()

    // And it comes back intact on another device, same as any other
    // encrypted field — this is text-only mode's whole point (see
    // convertSourceToTextOnly): the extracted text is the thing that
    // still needs to sync once the PDF itself is gone.
    await b.sync()
    const pulled = await b.getSource(source.id)
    expect(pulled?.pageHtml).toEqual(['Secret extracted page one text.', 'Secret extracted page two text.'])
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

    const schemaDoc = rawRemoteDoc(a.uid!, '__meta', 'schemaVersion')
    expect(schemaDoc.version).toBe(CURRENT_REMOTE_SCHEMA_VERSION)

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
    expect(messages.some((m) => m.includes('Applying migration'))).toBe(true)

    const messages2: string[] = []
    await a.sync((m) => messages2.push(m))
    expect(messages2.some((m) => m.includes('Applying migration'))).toBe(false)
  })

  it('a brand-new account never runs the migration at all', async () => {
    const a = await newDeviceSignedIn('fresh@example.com')
    await a.createLocalKey()
    const messages: string[] = []
    await a.sync((m) => messages.push(m))
    expect(messages.some((m) => m.includes('Applying migration'))).toBe(false)
    const meta = await a.getAccountMeta()
    expect(meta?.encryptionVersion).toBe(CURRENT_REMOTE_SCHEMA_VERSION)
  })
})

describe('migrating remote source data through the source-content-split chain (versions 3-5)', () => {
  it("splits an old remote source doc (already fully encrypted, but pre-split) into sources + sourceContent on the next sync", async () => {
    const { bundle, cryptoKey } = await generateKeyBundle()
    const a = await newDeviceSignedIn('oldshape@example.com')
    await a.importLocalKey(bundle)
    await a.sync() // bootstraps meta at the current version — reset below to simulate an account that's already past the encryption-policy migration, but predates the source-content split
    await a.setAccountMeta((await a.getAccountMeta())!.keyFingerprint, 2)

    // A real account pushed from a device running the previous version of
    // this app — already encrypted under the current field policy (so
    // `bibtex`/`comment`/`pageHtmlCompressed` all sit under `_enc`), but
    // from before the split existed, so the page content is still inline
    // on the `sources` record rather than its own `sourceContent` one.
    const now = 3_000_000
    const pageHtmlCompressed = await gzipCompress(JSON.stringify(['<p>Old inline page one.</p>', '<p>Old inline page two.</p>']))
    const enc = await encryptJson(cryptoKey, {
      bibtex: { type: 'article', key: 'old2018', fields: { title: 'Old Shape Paper', author: 'Old Author' } },
      comment: 'kept from before the split',
      pageHtmlCompressed,
    })
    __getFakeCloud().set(`accounts/${a.uid}/sources/source1`, { id: 'source1', createdAt: now, updatedAt: now, _enc: enc })

    await a.sync()

    const sourceAfter = rawRemoteDoc(a.uid!, 'sources', 'source1') as { updatedAt: number; pageCount: number; contentBytes: number; _enc: EncryptedField }
    expect(sourceAfter.updatedAt).toBe(now) // migration must never look like a new edit
    expect(sourceAfter.pageCount).toBe(2)
    expect(sourceAfter.contentBytes).toBe(pageHtmlCompressed.byteLength)
    const decodedMeta = await decryptJson<Record<string, unknown>>(cryptoKey, sourceAfter._enc)
    expect(decodedMeta.pageHtmlCompressed).toBeUndefined() // moved out, not just re-encrypted in place
    expect((decodedMeta.bibtex as { fields: { title: string } }).fields.title).toBe('Old Shape Paper')

    const contentDoc = rawRemoteDoc(a.uid!, 'sourceContent', 'source1') as { _enc: EncryptedField }
    const decodedContent = await decryptJson<{ pageHtmlCompressed: Uint8Array }>(cryptoKey, contentDoc._enc)
    expect(JSON.parse(await gzipDecompress(decodedContent.pageHtmlCompressed))).toEqual(['<p>Old inline page one.</p>', '<p>Old inline page two.</p>'])

    const schemaDoc = rawRemoteDoc(a.uid!, '__meta', 'schemaVersion')
    expect(schemaDoc.version).toBe(CURRENT_REMOTE_SCHEMA_VERSION)

    // And a second device, pulling fresh, sees a fully usable, correctly
    // migrated source — not just correctly re-shaped remote bytes.
    const b = await newDeviceSignedIn('oldshape@example.com')
    await b.importLocalKey(bundle)
    await b.sync()
    const pulled = await b.getSource('source1')
    expect(pulled?.bibtex.fields.title).toBe('Old Shape Paper')
    expect(pulled?.pageHtml).toEqual(['<p>Old inline page one.</p>', '<p>Old inline page two.</p>'])
  })
})

describe('migrating remote quote data through the quote-kind backfill (version 6)', () => {
  it("backfills kind: 'quote' (as plaintext metadata, not under _enc) on an old remote quote doc that predates margin annotations", async () => {
    const { bundle, cryptoKey } = await generateKeyBundle()
    const a = await newDeviceSignedIn('oldquoteshape@example.com')
    await a.importLocalKey(bundle)
    await a.sync() // bootstraps meta at the current version — reset below to simulate an account that's already past every other migration, but predates the quote-kind backfill
    await a.setAccountMeta((await a.getAccountMeta())!.keyFingerprint, 5)

    // A real account pushed from a device running the previous version of
    // this app — already encrypted under the current field policy, but
    // from before `kind` existed at all, so there's no such field anywhere
    // on the doc, encrypted or not.
    const now = 4_000_000
    const enc = await encryptJson(cryptoKey, { quoteText: 'an old quoted excerpt', annotation: 'why it mattered', page: 7 })
    __getFakeCloud().set(`accounts/${a.uid}/quotes/quote1`, { id: 'quote1', sourceId: 'source1', createdAt: now, updatedAt: now, _enc: enc })

    await a.sync()

    const after = rawRemoteDoc(a.uid!, 'quotes', 'quote1')
    expect(after.kind).toBe('quote') // backfilled, as plaintext — not one of quotes' sensitive fields
    expect(after.updatedAt).toBe(now) // migration must never look like a new edit
    expect(after._enc).toBeDefined()
    const decoded = await decryptJson<Record<string, unknown>>(cryptoKey, after._enc as EncryptedField)
    expect(decoded.quoteText).toBe('an old quoted excerpt') // untouched by the migration

    const schemaDoc = rawRemoteDoc(a.uid!, '__meta', 'schemaVersion')
    expect(schemaDoc.version).toBe(CURRENT_REMOTE_SCHEMA_VERSION)

    // And a second device, pulling fresh, sees it as a normal, usable quote.
    const b = await newDeviceSignedIn('oldquoteshape@example.com')
    await b.importLocalKey(bundle)
    await b.sync()
    const pulled = await b.listQuotes()
    expect(pulled.map((q) => ({ quoteText: q.quoteText, kind: q.kind }))).toEqual([{ quoteText: 'an old quoted excerpt', kind: 'quote' }])
  })
})
