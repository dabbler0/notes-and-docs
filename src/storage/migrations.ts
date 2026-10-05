import type { DocStore } from './types'

/**
 * General-purpose "database migration" discipline — the same idea as an
 * ordinary SQL app's chronological, sequentially-applied migration list
 * with a tracked schema version, adapted to a flat collection/id document
 * store. Exists specifically so a change to how one collection's documents
 * are shaped on disk (compressing a field, splitting a record in two,
 * renaming something) is handled once, as a single new entry appended to
 * whichever domain module's own migration list owns that collection,
 * rather than as another lazily-triggered "handle the old shape too"
 * branch threaded through every read path forever (which is what
 * `sourcesRepo.ts` used to do for its own `pageHtml` field's three earlier
 * shapes, before this existed).
 *
 * A `Migration`'s `run` only ever needs plain collection reads/writes —
 * the same four operations any `DocStore` already exposes — so this
 * reuses that interface directly as the context migrations run with,
 * rather than inventing a parallel one. Nothing here needs to know what a
 * "source" or a "node" is, nor whether `ctx` is backed by IndexedDB or by
 * Firestore: that's each domain module's own business (see
 * `models/sourcesMigrations.ts` for the migrations that actually touch
 * source data) and each backend's own adapter's business (see
 * `localBackend.ts`'s `runPendingMigrations` for the IndexedDB case and
 * `syncEngine.ts`'s `createFirestoreDocStore` for the remote-account
 * case — the exact same `migrateSplitSourceContent`/etc. migrations run,
 * unmodified, against both).
 */
export interface Migration {
  /** Strictly increasing, globally unique across every domain's migrations
   * — this is the database's own version number once this migration has
   * run, not a per-domain counter. Pick the next integer after whatever
   * the highest existing migration (across all domains) already uses. */
  version: number
  /** One line, for the console log a migration run emits and for anyone
   * reading the list later to understand the database's own history. */
  description: string
  /** Transforms whatever data needs it for this one version step. Must be
   * safe to run against a database that has nothing for it to do (an
   * empty collection, or no documents in the old shape) — every migration
   * runs over the *whole* matching collection, not just records a caller
   * already knows are stale, so this is the common case, not an edge one. */
  run: (ctx: DocStore) => Promise<void>
}

// Reserved, not a real app collection — `localBackend.ts`'s `key()` just
// prefixes any collection name with `${collection}/`, so this lives in the
// exact same underlying object store as everything else without needing
// its own. No real collection is ever named this (all of them are plain
// lowercase domain words — essays, nodes, sources, sourceContent, quotes,
// graveyard, bookmarks); the leading underscores just make that obvious
// at a glance.
const SCHEMA_META_COLLECTION = '__meta'
const SCHEMA_VERSION_DOC_ID = 'schemaVersion'

interface SchemaVersionDoc {
  id: string
  version: number
}

export interface RunMigrationsOptions {
  /** Called once per migration actually applied, right before it runs —
   * lets a slow backend (a remote migration that may have to touch every
   * document in every collection of a real account, over the network)
   * surface live progress to whoever's watching, on top of the
   * `console.info` this always logs regardless. */
  onProgress?: (message: string) => void
  /**
   * Only ever consulted when this store has no schema-version doc at all
   * yet — a store that predates this generic migration system, whose
   * version was tracked some other, older, single-purpose way before (see
   * `AccountMeta.encryptionVersion`'s own doc comment in `sync/
   * accountMeta.ts` for the real example: an already-existing account's
   * remote data was versioned by that one field alone, long before this
   * module's remote use existed). Lets that prior version seed the
   * starting point here, so a store that's already effectively been
   * through some of this history doesn't redundantly re-run migrations it
   * doesn't need. A genuinely fresh store has nothing to seed from and
   * correctly starts at 0 by simply never providing this.
   */
  seedVersion?: () => number | Promise<number>
}

async function readSchemaVersion(ctx: DocStore, seedVersion?: RunMigrationsOptions['seedVersion']): Promise<number> {
  const doc = await ctx.get<SchemaVersionDoc>(SCHEMA_META_COLLECTION, SCHEMA_VERSION_DOC_ID)
  if (doc) return doc.version
  return seedVersion ? await seedVersion() : 0
}

async function writeSchemaVersion(ctx: DocStore, version: number): Promise<void> {
  await ctx.put<SchemaVersionDoc>(SCHEMA_META_COLLECTION, { id: SCHEMA_VERSION_DOC_ID, version })
}

/**
 * Runs every migration in `migrations` whose `version` is still ahead of
 * what's stored, in ascending order, persisting the new version after each
 * one individually completes — not just once at the end — so a failure
 * partway through (an unexpected shape, a thrown error) leaves the
 * store at the last version that actually finished, and the next attempt
 * resumes from there instead of re-running already-applied migrations or
 * skipping the one that failed. A store already at or past the highest
 * version in `migrations` (including a brand new one, with nothing stored
 * yet and no `seedVersion` given) is a no-op beyond the one cheap version
 * read.
 *
 * Called once per connection/account before anything else touches it:
 * from `localBackend.ts`'s own `db()`, before the connection it returns is
 * handed to anything else, and from `syncEngine.ts`'s `runSyncPassNow`,
 * before the ordinary push/pull loops run — every ordinary `docs.*` call
 * or sync pass is guaranteed to only ever see already-migrated data as a
 * result, the same guarantee a real SQL migration runner gives an
 * application's models.
 */
export async function runMigrations(ctx: DocStore, migrations: Migration[], options?: RunMigrationsOptions): Promise<void> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  let current = await readSchemaVersion(ctx, options?.seedVersion)
  for (const migration of sorted) {
    if (migration.version <= current) continue
    const message = `Applying migration v${migration.version}: ${migration.description}`
    console.info(`[migrations] ${message}`)
    options?.onProgress?.(message)
    await migration.run(ctx)
    await writeSchemaVersion(ctx, migration.version)
    current = migration.version
  }
}
