import { backend } from '../storage'
import { id } from '../lib/id'
import { displayAuthors, displayTitle } from '../lib/bibtex'
import { gzipCompress, gzipDecompress } from '../lib/compression'
import { buildSearchRegex } from '../lib/pdf'
import { htmlToPlainText } from '../lib/textExtraction'
import type { BibtexEntry, Source } from './types'

const COLLECTION = 'sources'
const CONTENT_COLLECTION = 'sourceContent'

/**
 * A source is split across two records, specifically so *listing* sources
 * never has to touch the large one:
 *
 * - `sources/{id}` (this type) — everything about a source except its
 *   extracted page text: BibTeX, comment, flags, timestamps, and two cheap
 *   numbers (`pageCount`, `contentBytes`) standing in for the content
 *   that's *not* here. `listSources()` reads only this collection — no
 *   decompression, nothing proportional to how much text a source has —
 *   which is the entire reason for the split: a source's own extracted
 *   text (a whole PDF's worth of markup, base64 image data and all, for a
 *   layout-extracted scan) used to live inline on this same record, so
 *   listing *every* source meant decompressing *all* of their text on
 *   every single list load, whether or not anything on screen actually
 *   needed it.
 * - `sourceContent/{id}` (`StoredSourceContent`, below) — the extracted
 *   text itself, gzip-compressed the same way it always was (see that
 *   type's own doc comment), fetched only by `getSource` (one specific
 *   source, actually being opened) and `getSourceContent`/`searchPdfBank`
 *   (which need it for real, and pay accordingly).
 *
 * Both are plain, independent records in the generic `docs` store (see
 * `storage/types.ts`) — no schema change was needed to introduce the
 * second one, just a new collection name — and both sync independently
 * too (see `SENSITIVE_FIELDS` in `sync/syncEngine.ts`), each with its own
 * `updatedAt`: editing the BibTeX entry no longer has anything to do with
 * re-pushing the extracted text, and vice versa.
 */
type StoredSourceMeta = Omit<Source, 'pageHtml'>

/**
 * The extracted-text half of a source (see `StoredSourceMeta` above).
 * `pageHtmlCompressed` is `Source.pageHtml` gzipped down rather than kept
 * as a plain string array — some of the most repetitive text this app
 * ever stores (the layout extractor's own inline `style` attributes
 * repeat the same handful of CSS property names on every run, and a
 * scanned/OCR'd page can add a multi-hundred-KB base64 image on top of
 * that), exactly what gzip is good at. Compression happens purely at the
 * storage boundary — `pageHtml` stays a plain `string[]` everywhere else
 * in the app — and *before* encryption, not after: sync encrypts whatever
 * ends up in this field, and encrypted ciphertext is indistinguishable
 * from random noise, which gzip can't shrink at all, so compressing first
 * and encrypting the smaller result second is the only order that gets
 * both properties rather than one pretending to be the other.
 */
interface StoredSourceContent {
  id: string
  pageHtmlCompressed: Uint8Array
  updatedAt: number
}

async function compressPageHtml(pageHtml: string[]): Promise<Uint8Array> {
  return gzipCompress(JSON.stringify(pageHtml))
}

async function decompressPageHtml(bytes: Uint8Array): Promise<string[]> {
  return JSON.parse(await gzipDecompress(bytes))
}

/**
 * A device's own local `sources` records are guaranteed to already be
 * split (`pageHtmlCompressed` moved out, `pageCount`/`contentBytes` set)
 * by the one-time startup migration (see `storage/migrations.ts` and
 * `sourcesMigrations.ts`) — but a record arriving via sync, pulled down
 * from a device still running pre-split code, bypasses that migration
 * pass entirely (sync writes straight into storage; see the note on
 * `backend.docs.put` in `sync/syncEngine.ts`'s pull loop), and can show up
 * here carrying the old shape at any time, long after this device's own
 * migrations already ran. This is the lazy, read-triggered fallback for
 * exactly that case — the same pattern `localBackend.ts`'s own blob store
 * already uses for a legacy PDF shape, and the one this module used to
 * lean on entirely (via its old `normalizeSource`) before the formal
 * migration system existed.
 *
 * Cheap in the overwhelmingly common case — a single property check — and
 * only pays the real cost (decompressing once, to count pages) for a
 * record that actually still needs splitting. Persists the fix in place,
 * the same way the formal migration does and for the same reason: a pure
 * reshaping of data every device already has, not a real edit, so it
 * deliberately never bumps `updatedAt`.
 */
async function ensureSplit(stored: Record<string, unknown> & { id: string }): Promise<StoredSourceMeta> {
  if (!('pageHtmlCompressed' in stored)) return stored as StoredSourceMeta
  const pageHtmlCompressed = stored.pageHtmlCompressed as Uint8Array | undefined
  const { pageHtmlCompressed: _drop, ...meta } = stored
  const pageCount = pageHtmlCompressed ? (await decompressPageHtml(pageHtmlCompressed)).length : 0
  const fixedMeta = { ...meta, pageCount, contentBytes: pageHtmlCompressed?.byteLength ?? 0 } as StoredSourceMeta
  await backend.docs.put(COLLECTION, fixedMeta as StoredSourceMeta & { id: string })
  if (pageHtmlCompressed) {
    await backend.docs.put<StoredSourceContent>(CONTENT_COLLECTION, { id: stored.id, pageHtmlCompressed, updatedAt: (stored.updatedAt as number | undefined) ?? Date.now() })
  }
  return fixedMeta
}

function metaToSource(meta: StoredSourceMeta): Source {
  return { ...meta, pageHtml: [] }
}

/** Every source's own metadata, `pageHtml` deliberately left empty (see
 * that field's own doc comment on `Source`) — this is the fast path that
 * makes the Sources panel and the quote-insertion dialog's own source
 * picker near-instant regardless of library size: no content record is
 * ever read here, let alone decompressed. */
export async function listSources(): Promise<Source[]> {
  const stored = await backend.docs.list<Record<string, unknown> & { id: string }>(COLLECTION)
  const metas = await Promise.all(stored.map(ensureSplit))
  // Most-recently-viewed first, falling back to most-recently-edited for a
  // source that's never actually been opened in the viewer (including every
  // source that existed before `lastViewedAt` did) — see `touchSourceViewed`
  // below for why "viewed" is tracked as its own thing rather than folded
  // into `updatedAt` itself.
  return metas
    .filter((m) => !m.deleted)
    .map(metaToSource)
    .sort((a, b) => (b.lastViewedAt ?? b.updatedAt) - (a.lastViewedAt ?? a.updatedAt))
}

/** Just a source's own extracted text, decompressed — for a caller (like
 * `searchPdfBank`) that wants the content of a source it already has the
 * id of, without needing its metadata too. */
export async function getSourceContent(sourceId: string): Promise<string[]> {
  const content = await backend.docs.get<StoredSourceContent>(CONTENT_COLLECTION, sourceId)
  return content ? decompressPageHtml(content.pageHtmlCompressed) : []
}

/** The one source a caller actually wants to view, search within, or quote
 * from — unlike `listSources()`, this *does* fetch and decompress the
 * content record (skipped entirely when `pageCount` says there isn't
 * one), since the whole point of asking for a specific source by id is
 * almost always to do something with its real text. */
export async function getSource(sourceId: string): Promise<Source | undefined> {
  const stored = await backend.docs.get<Record<string, unknown> & { id: string }>(COLLECTION, sourceId)
  if (!stored) return undefined
  const meta = await ensureSplit(stored)
  const pageHtml = meta.pageCount > 0 ? await getSourceContent(sourceId) : []
  return { ...meta, pageHtml }
}

/** Writes only the metadata half of a source — never touches
 * `sourceContent` at all, so a comment edit, a bibtex fix, or a page-view
 * touch doesn't cost recompressing (or even reading) a source's own
 * extracted text. The in-memory `source.pageHtml` is simply dropped, not
 * persisted — callers that are actually changing content go through
 * `updateSourceContent` instead, which writes both halves together. */
async function persistMeta(source: Source): Promise<void> {
  const { pageHtml: _drop, ...meta } = source
  await backend.docs.put(COLLECTION, meta)
}

/** Compresses and writes `pageHtml` as `sourceId`'s content record — or,
 * for an empty array, deletes it outright rather than storing a pointless
 * near-empty compressed blob (and pointless content doc to sync) for a
 * source with nothing extracted. Returns the resulting `pageCount`/
 * `contentBytes` so the caller can keep its own in-memory `Source` object
 * consistent with what was actually written. */
async function writeSourceContent(sourceId: string, pageHtml: string[]): Promise<{ pageCount: number; contentBytes: number }> {
  if (pageHtml.length === 0) {
    await backend.docs.delete(CONTENT_COLLECTION, sourceId)
    return { pageCount: 0, contentBytes: 0 }
  }
  const pageHtmlCompressed = await compressPageHtml(pageHtml)
  await backend.docs.put<StoredSourceContent>(CONTENT_COLLECTION, { id: sourceId, pageHtmlCompressed, updatedAt: Date.now() })
  return { pageCount: pageHtml.length, contentBytes: pageHtmlCompressed.byteLength }
}

export async function createSource(
  bibtex: BibtexEntry,
  opts: { comment?: string; pdfFile?: File; pageHtml?: string[]; textOnly?: boolean } = {},
): Promise<Source> {
  const now = Date.now()
  const pageHtml = opts.pageHtml ?? []
  const source: Source = {
    id: id(),
    bibtex,
    comment: opts.comment ?? '',
    pageHtml,
    pageCount: 0,
    contentBytes: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (opts.pdfFile) {
    source.pdfFileName = opts.pdfFile.name
    if (opts.textOnly) {
      // The whole point of this option is that the PDF's bytes never touch
      // storage (local or, eventually, synced) at all — not even briefly —
      // for a PDF large enough that the user doesn't want to risk it. Only
      // the filename (for reference) and the already-extracted pageHtml
      // are kept.
      source.textOnly = true
    } else {
      source.pdfBlobId = id()
      await backend.blobs.put(source.pdfBlobId, opts.pdfFile)
    }
  }
  const { pageCount, contentBytes } = await writeSourceContent(source.id, pageHtml)
  source.pageCount = pageCount
  source.contentBytes = contentBytes
  await persistMeta(source)
  return source
}

export async function updateSource(source: Source): Promise<void> {
  source.updatedAt = Date.now()
  await persistMeta(source)
}

/**
 * Records that this device just looked at `source`'s PDF/text viewer, and
 * (when given) which page — so the next time this source is opened it
 * resumes on the same page (`SourceDetailDialog`'s own initial `page`
 * state), and so `listSources` can order by recency of actual use rather
 * than last edit. Deliberately writes straight through `persistMeta`
 * rather than the generic `updateSource`-style content-blind write it
 * already is: merely viewing a page isn't a real edit, and bumping
 * `updatedAt` for it would make every single page turn look like a change
 * sync needs to push. The cost is that `lastViewedPage`/`lastViewedAt`
 * never themselves sync to another device (they only ever ride along, as
 * plain metadata, the next time something *else* about this source
 * changes for real) — "resume where you left off" and "sort by recently
 * read" are per-device, which is the behavior that actually matters for a
 * reading-position feature like this one.
 */
export async function touchSourceViewed(source: Source, page?: number): Promise<void> {
  source.lastViewedAt = Date.now()
  if (page !== undefined) source.lastViewedPage = page
  await persistMeta(source)
}

/**
 * Writes new extracted-text content for a source that already exists —
 * re-extraction, OCR, attaching/replacing a PDF, or clearing it entirely
 * — updating `source.pageHtml`/`pageCount`/`contentBytes` in place (so the
 * caller's own in-memory object stays accurate) and persisting both the
 * content record and the metadata record together, as one coherent change
 * with a single `updatedAt` bump. The one place in this module (besides
 * `createSource`) that's allowed to change what a source's content record
 * actually holds — every other write goes through `updateSource`, which
 * deliberately never touches it.
 */
export async function updateSourceContent(source: Source, pageHtml: string[]): Promise<void> {
  const { pageCount, contentBytes } = await writeSourceContent(source.id, pageHtml)
  source.pageHtml = pageHtml
  source.pageCount = pageCount
  source.contentBytes = contentBytes
  source.updatedAt = Date.now()
  await persistMeta(source)
}

/**
 * Tombstones the source rather than deleting it outright, so sync can
 * propagate the deletion to other devices (see the `deleted` field note on
 * the Source type) — but the local PDF copy is removed for real right away,
 * same as before, since there's no reason to keep it taking up space on
 * *this* device once its source is gone. The content record is left as is
 * (same known gap as the PDF blob's own orphaned remote copy — see the
 * module doc comment on `syncEngine.ts`), and the now-orphaned encrypted
 * copies in Storage (if this ever synced) are left behind too; cleaning
 * those up remotely isn't implemented, a known gap for this rudimentary a
 * sync setup.
 */
export async function deleteSource(sourceId: string): Promise<void> {
  const source = await getSource(sourceId)
  if (!source) return
  if (source.pdfBlobId) await backend.blobs.delete(source.pdfBlobId)
  source.deleted = true
  await updateSource(source)
}

export async function getSourcePdfBlob(source: Source): Promise<Blob | undefined> {
  if (!source.pdfBlobId) return undefined
  return backend.blobs.get(source.pdfBlobId)
}

/**
 * How many bytes this source is actually taking up in local storage: the
 * PDF blob's own size if it has one, or `source.contentBytes` if it's
 * text-only (see `convertSourceToTextOnly`) — or 0 for a BibTeX-only
 * source with nothing attached. Used purely for the "how much space is
 * this using" UI — never for anything that needs to be exact (sync
 * payload size, quota checks), so this doesn't account for the rest of
 * the JSON structure it's actually stored under.
 *
 * Reads the PDF case via `blobs.sizeOf`, and the text-only case via the
 * metadata record's own `contentBytes` — neither ever decompresses
 * anything, which matters because this runs once per source *every time a
 * list of them renders* (`SourceCard`, via `useSourceStorageBytes`).
 * Confirmed directly, twice over: decompressing every PDF blob at once
 * just to print a size next to each one was once the actual cause of the
 * Sources tab visibly taking a while to settle (fixed by `blobs.sizeOf`);
 * recompressing every text-only source's full extracted text for the same
 * reason was the same bug in the other branch, fixed by `contentBytes`
 * existing at all instead of this function deriving it fresh from
 * `source.pageHtml` (which, per that field's own doc comment, usually
 * isn't even loaded for a source fresh out of `listSources()` in the
 * first place).
 */
export async function getSourceStorageBytes(source: Source): Promise<number> {
  if (source.pdfBlobId) {
    return (await backend.blobs.sizeOf(source.pdfBlobId)) ?? 0
  }
  return source.contentBytes ?? 0
}

/**
 * Attaches a PDF to a source that doesn't have one yet, or swaps out an
 * existing one, given its already-extracted `pageHtml`. Always mints a
 * *fresh* blob id for the new file rather than overwriting the old one in
 * place — same reasoning as everywhere else blobs are replaced: sync tracks
 * "have I pushed this blob id" by id, so reusing one for different bytes
 * would let a device that already pushed the old PDF believe it has nothing
 * left to do. The old blob (if any) is deleted locally only after the new
 * one is safely stored.
 */
export async function setSourcePdf(source: Source, file: File, pageHtml: string[]): Promise<void> {
  const oldBlobId = source.pdfBlobId
  const newBlobId = id()
  await backend.blobs.put(newBlobId, file)
  source.pdfBlobId = newBlobId
  source.pdfFileName = file.name
  source.textOnly = false
  await updateSourceContent(source, pageHtml)
  if (oldBlobId) await backend.blobs.delete(oldBlobId)
}

/**
 * Uploads a candidate re-OCR'd PDF as a standalone blob, without touching
 * the source's own saved data at all — used to let `SourceDetailDialog`
 * preview a fresh OCR pass (via a throwaway `Source`-shaped object pointing
 * at this blob id) before the user decides whether to keep it. Paired with
 * `commitOcrPreview` (keep it) or `discardOcrPreview` (throw it away); the
 * caller is expected to always call exactly one of those once the user
 * decides, so a staged preview never lingers as an orphaned blob.
 */
export async function stageOcrPreview(file: File): Promise<string> {
  const blobId = id()
  await backend.blobs.put(blobId, file)
  return blobId
}

/** Discards a blob staged by `stageOcrPreview` that the user chose not to keep. */
export async function discardOcrPreview(blobId: string): Promise<void> {
  await backend.blobs.delete(blobId)
}

/**
 * Commits a blob staged by `stageOcrPreview` as the source's real PDF —
 * same effect as `setSourcePdf`, but reusing the blob `stageOcrPreview`
 * already uploaded instead of writing the file a second time.
 */
export async function commitOcrPreview(source: Source, blobId: string, fileName: string, pageHtml: string[]): Promise<void> {
  const oldBlobId = source.pdfBlobId
  source.pdfBlobId = blobId
  source.pdfFileName = fileName
  source.textOnly = false
  await updateSourceContent(source, pageHtml)
  if (oldBlobId) await backend.blobs.delete(oldBlobId)
}

/** Detaches a source's PDF entirely, reverting it to BibTeX + comment only. */
export async function removeSourcePdf(source: Source): Promise<void> {
  const oldBlobId = source.pdfBlobId
  if (!oldBlobId) return
  source.pdfBlobId = undefined
  source.pdfFileName = undefined
  source.textOnly = false
  await updateSourceContent(source, [])
  await backend.blobs.delete(oldBlobId)
}

/**
 * Discards a source's PDF file for good, keeping only its already-extracted
 * `pageHtml` — the point being to reclaim whatever space the original PDF
 * (often the large majority of a source's footprint) was taking up, for a
 * source where the text alone is enough to keep browsing and quoting from
 * via `TextViewer`. One-way: there's no PDF byte to restore afterward, only
 * "attach a new one" via `setSourcePdf`, which is why the caller is expected
 * to confirm with the user first. Leaves the content record untouched —
 * the extracted text itself isn't changing, only whether the PDF it came
 * from is still around — so this is a metadata-only write via
 * `updateSource`, not `updateSourceContent`.
 */
export async function convertSourceToTextOnly(source: Source): Promise<void> {
  const oldBlobId = source.pdfBlobId
  if (!oldBlobId) return
  source.pdfBlobId = undefined
  source.textOnly = true
  await updateSource(source)
  await backend.blobs.delete(oldBlobId)
}

/** Whether a source has anything (a PDF, or its extracted text kept on its
 * own via `convertSourceToTextOnly`) to drag-select a quote from — as
 * opposed to typing one in by hand. Uses `pageCount`, not `pageHtml.length`
 * — safe to call on a source straight out of `listSources()`, whose
 * `pageHtml` is typically empty regardless of whether it actually has
 * text (see that field's own doc comment). */
export function hasQuotableText(source: Source): boolean {
  return !!source.pdfBlobId || source.pageCount > 0
}

export function matchesSourceQuery(source: Source, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const haystack = [displayTitle(source.bibtex), displayAuthors(source.bibtex), source.bibtex.fields.year ?? '', source.comment, source.bibtex.key].join(' ').toLowerCase()
  return haystack.includes(q)
}

export interface PdfSearchHit {
  source: Source
  page: number
  snippet: string
}

/** Naive substring search across every source's extracted page text —
 * whitespace-tolerant (see `buildSearchRegex`) so a query typed with an
 * ordinary space still finds a phrase that happens to wrap across one of
 * the line/paragraph breaks `reflowTextItems` now preserves. The snippet
 * itself collapses any such break back down to a plain space, since it's
 * meant to read as a short, single-line preview rather than reproduce the
 * source's own line layout.
 *
 * Unlike `listSources()`, this genuinely needs every source's real content
 * — full-text search has no way around reading all of it — so it fetches
 * each one's `getSourceContent` explicitly rather than relying on
 * `listSources()` to have already loaded it (which it deliberately never
 * does). That cost is real but inherent to the feature, and it's only
 * paid when a search is actually run, not on every list render the way it
 * used to be before the split.
 */
export async function searchPdfBank(query: string): Promise<PdfSearchHit[]> {
  const regex = buildSearchRegex(query)
  if (!regex) return []
  const sources = await listSources()
  const withContent = await Promise.all(
    sources
      .filter((s) => s.pageCount > 0)
      .map(async (source) => ({ source, pageHtml: await getSourceContent(source.id) })),
  )
  const hits: PdfSearchHit[] = []
  for (const { source, pageHtml } of withContent) {
    pageHtml.map(htmlToPlainText).forEach((text, idx) => {
      regex.lastIndex = 0
      const m = regex.exec(text)
      if (m) {
        const start = Math.max(0, m.index - 60)
        const end = Math.min(text.length, m.index + m[0].length + 60)
        const snippet = ((start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')).replace(/\s+/g, ' ')
        hits.push({ source, page: idx + 1, snippet })
      }
    })
  }
  return hits
}
