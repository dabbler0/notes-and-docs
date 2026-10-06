/**
 * The remote (Firestore) counterpart to `storage/migrationRegistry.ts` —
 * the chronologically ordered list of migrations that bring one account's
 * remote data up to `CURRENT_REMOTE_SCHEMA_VERSION` (see that constant's
 * own doc comment in `collections.ts` for the full version history). Run
 * via the exact same generic `runMigrations` used for local storage (see
 * `storage/migrations.ts`), just pointed at a `DocStore` adapter that reads
 * and writes through Firestore and this account's encryption key instead
 * of IndexedDB — see `createFirestoreDocStore` in `syncEngine.ts`.
 *
 * Versions 3-5 here are the exact same shape changes as local migrations
 * 1-3 in `models/sourcesMigrations.ts` (pageTexts -> pageHtml -> compressed
 * -> split into `sourceContent`) — reusing their `run` functions directly,
 * unmodified, rather than re-implementing the same transform twice. Both
 * ultimately operate on nothing more than the generic `DocStore` shape
 * (`list`/`put`), so the exact same pure transform works unchanged whether
 * `ctx` happens to be backed by IndexedDB or by Firestore. This also means
 * the remote chain has to be able to walk the *whole* history on its own,
 * not assume local's own migrations already covered it: a remote document
 * can easily be sitting in any of these old shapes independently of what
 * this device has locally, pushed by some other, possibly much older,
 * device at some point in the past.
 *
 * A future remote-only shape change (or another encryption-policy change)
 * adds a version 6 here and bumps `CURRENT_REMOTE_SCHEMA_VERSION`, not
 * another one-off migration function wired in by hand.
 */
import type { Migration } from '../storage/migrations'
import { migrateCompressPageHtml, migratePageTextsToPageHtml, migrateSplitSourceContent } from '../models/sourcesMigrations'
import { migrateDefaultQuoteKind } from '../models/quoteBankMigrations'
import { SYNCED_COLLECTIONS } from './collections'

/**
 * "Upgrade to the current field-encryption policy" reduces to just
 * re-saving every document in every synced collection once: `ctx.list`
 * (via `createFirestoreDocStore`'s own `decodeFromRemote`) already
 * tolerates any mix of old-plaintext/new-encrypted fields on the way in,
 * and `ctx.put` (via `encodeForRemote`) always re-encrypts under whatever
 * `SENSITIVE_FIELDS` currently says on the way back out — so nothing
 * collection-specific is needed here beyond visiting every document once.
 * This is version 2 (not 1) because version 1 is the implied starting
 * shape itself, never a migration that runs.
 */
const migrateEncryptEveryField: Migration = {
  version: 2,
  description: 'encrypt every user-editable field (previously only document content was encrypted)',
  run: async (ctx) => {
    for (const col of SYNCED_COLLECTIONS) {
      const docs = await ctx.list<{ id: string }>(col)
      for (const doc of docs) await ctx.put(col, doc)
    }
  },
}

export const remoteMigrations: Migration[] = [
  migrateEncryptEveryField,
  { ...migratePageTextsToPageHtml, version: 3 },
  { ...migrateCompressPageHtml, version: 4 },
  { ...migrateSplitSourceContent, version: 5 },
  { ...migrateDefaultQuoteKind, version: 6 },
]
