/**
 * The chronological history of how a `sources` record's own extracted-text
 * field has been shaped on disk, as formal, numbered migrations (see
 * `storage/migrations.ts` for the runner these plug into) rather than the
 * lazy "handle the old shape too, forever, on every read" branches
 * `sourcesRepo.ts`'s own `normalizeSource` used to carry for exactly this
 * history. Each one is a pure, idempotent transformation of whatever's
 * already in local storage — safe to run unconditionally, including on a
 * database with nothing for it to do.
 *
 * Versions 1-2 are the two shape changes that predate this migration
 * system existing at all (folded in here instead of only ever having
 * lived as inline `normalizeSource` branches); version 3 is the one this
 * module was actually introduced for. A future change to how sources are
 * stored adds a version 4 here, not another `if` in a read path.
 */
import type { Migration } from '../storage/migrations'
import { gzipCompress, gzipDecompress } from '../lib/compression'
import { plainTextToHtml } from '../lib/textExtraction'

const SOURCES = 'sources'
const SOURCE_CONTENT = 'sourceContent'

async function decompressPageHtml(bytes: Uint8Array): Promise<string[]> {
  return JSON.parse(await gzipDecompress(bytes))
}

async function compressPageHtml(pageHtml: string[]): Promise<Uint8Array> {
  return gzipCompress(JSON.stringify(pageHtml))
}

/** From before `pageHtml` existed at all: a page's extracted text was kept
 * as genuine plain text (`pageTexts`). Converts it to the HTML shape every
 * extractor has produced since, via `plainTextToHtml` — by construction,
 * renders identically to how the plain text used to display. */
export const migratePageTextsToPageHtml: Migration = {
  version: 1,
  description: 'sources: convert legacy plain-text pageTexts into pageHtml',
  run: async (ctx) => {
    const sources = await ctx.list<Record<string, unknown>>(SOURCES)
    for (const stored of sources) {
      const pageTexts = stored.pageTexts as string[] | undefined
      if (!pageTexts) continue
      const { pageTexts: _drop, pageHtml: _dropToo, pageHtmlCompressed: _dropThree, ...rest } = stored
      await ctx.put(SOURCES, { ...rest, pageHtml: pageTexts.map(plainTextToHtml) } as unknown as { id: string })
    }
  },
}

/** From before `pageHtml` was stored gzip-compressed: an uncompressed
 * `pageHtml: string[]` sitting directly on the record. Compresses it into
 * `pageHtmlCompressed`, the shape every write has produced since. */
export const migrateCompressPageHtml: Migration = {
  version: 2,
  description: 'sources: compress inline pageHtml into pageHtmlCompressed',
  run: async (ctx) => {
    const sources = await ctx.list<Record<string, unknown>>(SOURCES)
    for (const stored of sources) {
      const pageHtml = stored.pageHtml as string[] | undefined
      if (!pageHtml) continue
      const { pageHtml: _drop, ...rest } = stored
      await ctx.put(SOURCES, { ...rest, pageHtmlCompressed: await compressPageHtml(pageHtml) } as unknown as { id: string })
    }
  },
}

/**
 * The migration this module was actually introduced for: a source's own
 * `pageHtmlCompressed` — often the large majority of its footprint, and
 * the one field nothing actually needs just to *list* sources — moves out
 * of the `sources` record entirely, into its own `sourceContent` record
 * under the same id. The `sources` record keeps two small, cheap numbers
 * in its place: `pageCount` (so "does this source have extracted text, and
 * how many pages" never needs the content record at all) and
 * `contentBytes` (so the storage-size display doesn't need to recompress
 * — or even touch — the content just to report its own size). See
 * `sourcesRepo.ts`'s own doc comment on `StoredSourceMeta` for why this is
 * what actually makes listing sources fast.
 *
 * `pageCount` does need the content decompressed once, here, to count it
 * — the one-time cost this whole migration exists to move *out* of every
 * future list load and into this single pass instead. Every record gets
 * `pageCount`/`contentBytes` added, not just ones that had content to
 * split — a BibTeX-only source with no `pageHtmlCompressed` at all still
 * needs `pageCount: 0` written explicitly, or it would be left with
 * neither field at all (not even a correct zero), breaking the invariant
 * every reader downstream of this relies on: that they're always present.
 */
export const migrateSplitSourceContent: Migration = {
  version: 3,
  description: 'sources: split pageHtmlCompressed out into its own sourceContent collection',
  run: async (ctx) => {
    const sources = await ctx.list<Record<string, unknown>>(SOURCES)
    for (const stored of sources) {
      if ('pageCount' in stored) continue // already migrated (or created after this version existed)
      const pageHtmlCompressed = stored.pageHtmlCompressed as Uint8Array | undefined
      const { pageHtmlCompressed: _drop, ...meta } = stored
      const pageCount = pageHtmlCompressed ? (await decompressPageHtml(pageHtmlCompressed)).length : 0
      await ctx.put(SOURCES, { ...meta, pageCount, contentBytes: pageHtmlCompressed?.byteLength ?? 0 } as unknown as { id: string })
      if (pageHtmlCompressed) {
        await ctx.put(SOURCE_CONTENT, { id: stored.id, pageHtmlCompressed, updatedAt: stored.updatedAt } as unknown as { id: string })
      }
    }
  },
}

export const sourcesMigrations: Migration[] = [migratePageTextsToPageHtml, migrateCompressPageHtml, migrateSplitSourceContent]
