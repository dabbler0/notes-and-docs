/**
 * The chronological history of how a `quotes` record's own shape has
 * changed on disk — see `storage/migrations.ts` for the runner this plugs
 * into, and `sourcesMigrations.ts` for the sibling module this one mirrors.
 */
import type { Migration } from '../storage/migrations'

const QUOTES = 'quotes'

/**
 * Before margin annotations existed, every `quotes` record was implicitly
 * a quote-bank quote — there was nothing else it could be. Backfills the
 * new `kind` field explicitly for every existing entry, so a reader that
 * ever stops defaulting a missing `kind` to `'quote'` (see `QuoteBankEntry`'s
 * own doc comment) still sees correct data. Every current read path already
 * defaults a missing `kind` on its own, so this migration isn't load-bearing
 * for correctness today — it exists so the on-disk shape itself stops
 * lying about what's actually true, the same reasoning `sourcesMigrations.ts`
 * gives for formalizing a shape change instead of leaving it as a permanent
 * "handle the old shape too" branch in every reader.
 */
export const migrateDefaultQuoteKind: Migration = {
  version: 4,
  description: "quotes: default existing entries' kind to 'quote' (margin annotations are new)",
  run: async (ctx) => {
    const entries = await ctx.list<Record<string, unknown>>(QUOTES)
    for (const stored of entries) {
      if ('kind' in stored) continue // already migrated (or created after this version existed)
      await ctx.put(QUOTES, { ...stored, kind: 'quote' } as unknown as { id: string })
    }
  },
}

export const quoteBankMigrations: Migration[] = [migrateDefaultQuoteKind]
