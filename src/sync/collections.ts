/**
 * A couple of small, side-effect-free constants both `accountMeta.ts` and
 * `syncEngine.ts` need to agree on — kept in their own module specifically
 * so neither has to import the other just for this, which would create an
 * import cycle (`syncEngine.ts` already imports `accountMeta.ts`'s
 * `getAccountMeta`/`setAccountMeta`).
 */

/** Every top-level collection under `accounts/{uid}/...` that holds real user data — `wipeRemoteAccountData` (account reset) and the account-wide re-encryption migration (`remoteMigrationRegistry.ts`) both need this same list, and used to each hardcode their own slightly-stale copy.
 *
 * `sourceContent` holds a source's own extracted page text, split out of
 * its `sources` record locally (see `sourcesRepo.ts`'s own doc comment on
 * `StoredSourceMeta`) specifically so listing sources never has to load
 * it — it syncs as its own independent collection for the same reason:
 * nothing about pulling/pushing a library's worth of BibTeX metadata
 * should have to also move everyone's extracted text around with it. */
export const SYNCED_COLLECTIONS = ['essays', 'nodes', 'sources', 'sourceContent', 'quotes', 'graveyard', 'bookmarks'] as const
export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number]

/**
 * The target version for an account's *remote* data — the Firestore
 * counterpart to a local database's own schema version (see
 * `storage/migrations.ts`). Chained, numbered migrations that bring an
 * account's remote data up to this version live in
 * `sync/remoteMigrationRegistry.ts`, run via the exact same generic
 * `runMigrations` used for local storage, just pointed at a `DocStore`
 * adapter over Firestore instead of IndexedDB (`createFirestoreDocStore`
 * in `syncEngine.ts`). The next device to sign in and sync runs whatever
 * chain of migrations an account still needs before doing anything else —
 * so this only ever costs one full scan of whatever's changed per account,
 * not one per device or one per sync.
 *
 * This single counter has carried two different *kinds* of remote change
 * so far (see `remoteMigrationRegistry.ts` for exactly how each version's
 * migration is implemented):
 *
 * 1 — the original shape, implied for any account whose meta doc predates
 *     this version-tracking scheme entirely (see
 *     `AccountMeta.encryptionVersion`'s own doc comment in
 *     `sync/accountMeta.ts` — the single-purpose counter this one
 *     generalizes). Only actual document *content* (a node's draft text
 *     and version history, a source's extracted PDF page text, a quote's
 *     own text/annotation, a footnote/graveyard fragment's HTML) was
 *     encrypted; titles, comments, bibliographic metadata, and PDF
 *     filenames were left as plaintext metadata. A source's own extracted
 *     text could also still be sitting under any of its three earlier,
 *     pre-`sourceContent`-split on-disk shapes — see versions 3-5 below.
 * 2 — every user-editable field is encrypted — essay and section titles, a
 *     source's whole bibtex entry plus its comment and PDF filename, and a
 *     quote bank entry's page number on top of its text/annotation. Left
 *     as plaintext metadata: `id` and other system-generated references
 *     (an id is never user-typed content, and most — headVersionId,
 *     sourceId, nodeId, a blob id — only ever point into data that's
 *     *itself* fully encrypted, so a bare id alone reveals nothing), plus
 *     `createdAt`/`updatedAt`/`deleted`, which are system-stamped rather
 *     than user-entered and, for `updatedAt` specifically, load-bearing:
 *     Firestore has to filter and sort on it server-side for incremental
 *     sync to work at all, which an encrypted value could never support.
 * 3 — a source's legacy plain-text `pageTexts` field (from before
 *     `pageHtml` existed) converted to `pageHtml`. Same transform as local
 *     migration version 1 in `models/sourcesMigrations.ts`, reused
 *     verbatim — a remote document can be sitting in this shape
 *     independently of what's on any particular device locally, pushed by
 *     some other, possibly much older, device.
 * 4 — a source's inline, uncompressed `pageHtml` compressed into
 *     `pageHtmlCompressed`. Same transform as local migration version 2.
 * 5 — a source's `pageHtmlCompressed` split out of the `sources` record
 *     into its own `sourceContent` record, same reason and same transform
 *     as local migration version 3: nothing about listing/pulling a
 *     library's worth of bibliographic metadata should also have to move
 *     everyone's extracted text around with it.
 * 6 — a `quotes` record's new `kind` field (`'quote'` vs. `'annotation'` —
 *     see `QuoteBankEntryKind`'s own doc comment in `models/types.ts`)
 *     backfilled to `'quote'` on every entry that predates margin
 *     annotations, same transform as local migration version 4 in
 *     `models/quoteBankMigrations.ts`. `kind` is plaintext metadata, not
 *     one of `quotes`' sensitive fields, so this is the one migration here
 *     that isn't itself about the encryption policy — just keeping the
 *     on-disk shape honest, the same reasoning version 3-5 above give for
 *     a source's own shape history.
 */
export const CURRENT_REMOTE_SCHEMA_VERSION = 6
