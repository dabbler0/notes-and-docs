import type { DocStore } from './types'

/**
 * General-purpose "database migration" discipline for this app's local
 * IndexedDB storage — the same idea as an ordinary SQL app's chronological,
 * sequentially-applied migration list with a tracked schema version,
 * adapted to a flat collection/id document store. Exists specifically so a
 * change to how one collection's documents are shaped on disk (compressing
 * a field, splitting a record in two, renaming something) is handled once,
 * as a single new entry appended to whichever domain module's own
 * migration list owns that collection, rather than as another lazily-
 * triggered "handle the old shape too" branch threaded through every read
 * path forever (which is what `sourcesRepo.ts` used to do for its own
 * `pageHtml` field's three earlier shapes, before this existed).
 *
 * A `Migration`'s `run` only ever needs plain collection reads/writes —
 * the same four operations any `DocStore` already exposes — so this
 * reuses that interface directly as the context migrations run with,
 * rather than inventing a parallel one. Nothing here needs to know what a
 * "source" or a "node" is; that's each domain module's own business (see
 * `models/sourcesMigrations.ts` for the migrations that actually touch
 * source data), kept separate from this generic runner for the same
 * reason `localBackend.ts` itself knows nothing about app-level schemas.
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

async function readSchemaVersion(ctx: DocStore): Promise<number> {
  const doc = await ctx.get<SchemaVersionDoc>(SCHEMA_META_COLLECTION, SCHEMA_VERSION_DOC_ID)
  return doc?.version ?? 0
}

async function writeSchemaVersion(ctx: DocStore, version: number): Promise<void> {
  await ctx.put<SchemaVersionDoc>(SCHEMA_META_COLLECTION, { id: SCHEMA_VERSION_DOC_ID, version })
}

/**
 * Runs every migration in `migrations` whose `version` is still ahead of
 * what's stored, in ascending order, persisting the new version after each
 * one individually completes — not just once at the end — so a failure
 * partway through (an unexpected shape, a thrown error) leaves the
 * database at the last version that actually finished, and the next
 * attempt (next app load) resumes from there instead of re-running
 * already-applied migrations or skipping the one that failed. A database
 * already at or past the highest version in `migrations` (including a
 * brand new one, with nothing stored yet) is a no-op beyond the one cheap
 * version read.
 *
 * Called once, from `localBackend.ts`'s own `db()`, before the connection
 * it returns is handed to anything else — every ordinary `docs.*` call
 * anywhere in the app is guaranteed to only ever see already-migrated data
 * as a result, the same guarantee a real SQL migration runner gives an
 * application's models.
 */
export async function runMigrations(ctx: DocStore, migrations: Migration[]): Promise<void> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  let current = await readSchemaVersion(ctx)
  for (const migration of sorted) {
    if (migration.version <= current) continue
    console.info(`[migrations] applying v${migration.version}: ${migration.description}`)
    await migration.run(ctx)
    await writeSchemaVersion(ctx, migration.version)
    current = migration.version
  }
}
