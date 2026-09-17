/**
 * A couple of small, side-effect-free constants both `accountMeta.ts` and
 * `syncEngine.ts` need to agree on — kept in their own module specifically
 * so neither has to import the other just for this, which would create an
 * import cycle (`syncEngine.ts` already imports `accountMeta.ts`'s
 * `getAccountMeta`/`setAccountMeta`/`markEncryptionVersion`).
 */

/** Every top-level collection under `accounts/{uid}/...` that holds real user data — `wipeRemoteAccountData` (account reset) and `migrateAccountEncryption` (below) both need this same list, and used to each hardcode their own slightly-stale copy. */
export const SYNCED_COLLECTIONS = ['essays', 'nodes', 'sources', 'quotes', 'graveyard'] as const
export type SyncedCollection = (typeof SYNCED_COLLECTIONS)[number]

/**
 * Bumped whenever which fields get encrypted at rest changes (see
 * `SENSITIVE_FIELDS` in `syncEngine.ts`). An account's remote meta doc
 * records the version its data is currently guaranteed to be fully in
 * (`AccountMeta.encryptionVersion`) — anything lower, including "absent,"
 * for an account whose meta doc predates this field entirely, means some
 * remote documents may still be sitting in an older, less-encrypted shape.
 * The next device to sign in and sync migrates them automatically (see
 * `migrateAccountEncryption()` in `syncEngine.ts`) before doing anything
 * else, then records the new version — so this only ever costs one full
 * collection scan per account, not one per device or one per sync.
 *
 * 1 — original policy: only actual document *content* (a node's draft
 *     text and version history, a source's extracted PDF page text, a
 *     quote's own text/annotation, a footnote/graveyard fragment's HTML)
 *     was encrypted; titles, comments, bibliographic metadata, and PDF
 *     filenames were left as plaintext metadata.
 * 2 — current policy: every user-editable field is encrypted — essay and
 *     section titles, a source's whole bibtex entry plus its comment and
 *     PDF filename, and a quote bank entry's page number on top of its
 *     text/annotation. Left as plaintext metadata: `id` and other
 *     system-generated references (an id is never user-typed content, and
 *     most — headVersionId, sourceId, nodeId, a blob id — only ever point
 *     into data that's *itself* fully encrypted, so a bare id alone
 *     reveals nothing), plus `createdAt`/`updatedAt`/`deleted`, which are
 *     system-stamped rather than user-entered and, for `updatedAt`
 *     specifically, load-bearing: Firestore has to filter and sort on it
 *     server-side for incremental sync to work at all, which an encrypted
 *     value could never support.
 */
export const CURRENT_ENCRYPTION_VERSION = 2
