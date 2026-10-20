/**
 * A full local-database export/import, independent of the sync feature —
 * this works with no Firebase project or account configured at all, since
 * it just serializes what's already in IndexedDB (via the same `backend`
 * abstraction everything else uses) into one zip file, and reads it back
 * the same way. Meant as a disaster-recovery / move-to-a-new-browser tool,
 * not a sync mechanism: there's no watermark, no incremental anything, and
 * — unlike sync — nothing here is encrypted, since the file never leaves
 * the user's own hands by design.
 */
import JSZip from 'jszip'
import { backend } from '../storage'
import type { Bookmark, Essay, EssayCommitEntry, EssayNode, GraveyardFragment, Project, QuoteBankEntry, Source, TodoItem } from '../models/types'
import type { StoredSourceContent } from '../models/sourcesRepo'

const BACKUP_VERSION = 1

export interface BackupManifest {
  version: typeof BACKUP_VERSION
  exportedAt: number
  essays: Essay[]
  nodes: EssayNode[]
  sources: Source[]
  /** Absent in a backup made before the quote bank/graveyard existed — always read with `?? []`, never assumed present. */
  quotes?: QuoteBankEntry[]
  graveyard?: GraveyardFragment[]
  /** Absent in a backup made before bookmarks existed — always read with `?? []`. */
  bookmarks?: Bookmark[]
  /** Absent in a backup made before the TODO list existed — always read with `?? []`. */
  todos?: TodoItem[]
  /**
   * Every source's own extracted-text content record — `id` (matching a
   * `sources` entry's own id) and `updatedAt` only; the real payload
   * (`StoredSourceContent.pageHtmlCompressed`) is written out as a binary
   * `sourceContent/{id}` file in the zip instead, exactly the way a PDF's
   * own bytes go in `blobs/{id}` rather than into this JSON — a
   * `Uint8Array` run through `JSON.stringify` balloons to several times
   * its real size (every byte as a decimal array entry, comma-separated),
   * for exactly the content this is: a source's full extracted page
   * text/layout markup, gzip-compressed, often the single largest thing a
   * source holds (easily dwarfing its own metadata or even its PDF, for a
   * layout-extracted scan carrying inline base64 images). Absent in a
   * backup made before this field existed — always read with `?? []`.
   *
   * **Missing from every backup made before this field existed at all** —
   * `sources`/`nodes`/`essays`/etc. were always written straight from
   * `backend.docs.list(...)`, but a source's own text is split out into
   * this *separate* `sourceContent` collection specifically so listing
   * sources doesn't have to load it (see `sourcesRepo.ts`'s own doc
   * comment on the split) — a split this export never actually accounted
   * for until now, so every earlier backup silently carried a source's
   * `pageCount`/`contentBytes` (both live on the `sources` record itself)
   * with no matching text behind them at all. A source extracted before
   * this field existed needs *re*-extracting (or restoring from sync, if
   * another device still has it) — there's no way to recover text that
   * was simply never written to an old backup in the first place.
   */
  sourceContent?: { id: string; updatedAt: number }[]
  /**
   * Every essay's own commit history (`EssayCommitEntry` — see its own doc
   * comment in `models/types.ts`) — unlike `sourceContent` above, included
   * directly here rather than as separate zip files: a commit's own payload
   * (`patch`, a plain unified-diff *string*) has no binary field to avoid
   * bloating a JSON array with, so there's no reason to reach for the
   * zip-folder-of-files trick `sourceContent`/`blobs` need. Absent in a
   * backup made before this field existed — always read with `?? []`.
   */
  essayHistory?: EssayCommitEntry[]
  /** Every essay-grouping record (`Project` — see its own doc comment in `models/types.ts`). A genuinely new collection with no binary payload, so — like `essayHistory` — included directly here rather than as zip files. Absent in a backup made before projects existed. */
  projects?: Project[]
  /** Which blob ids the zip's blobs/ folder actually contains — a source can reference a pdfBlobId whose blob went missing locally, so this isn't just "every source's pdfBlobId." */
  blobs: string[]
}

export async function exportBackup(): Promise<Blob> {
  const [essays, nodes, sources, quotes, graveyard, bookmarks, todos, sourceContentRecords, essayHistory, projects] = await Promise.all([
    backend.docs.list<Essay>('essays'),
    backend.docs.list<EssayNode>('nodes'),
    backend.docs.list<Source>('sources'),
    backend.docs.list<QuoteBankEntry>('quotes'),
    backend.docs.list<GraveyardFragment>('graveyard'),
    backend.docs.list<Bookmark>('bookmarks'),
    backend.docs.list<TodoItem>('todos'),
    // Every source's own extracted-text content — see BackupManifest's own
    // doc comment on `sourceContent` for why this is a whole separate
    // collection (and so a whole separate `backend.docs.list` call) rather
    // than something already sitting on each `Source` record above.
    backend.docs.list<StoredSourceContent>('sourceContent'),
    backend.docs.list<EssayCommitEntry>('essayHistory'),
    backend.docs.list<Project>('projects'),
  ])

  const zip = new JSZip()
  const blobsFolder = zip.folder('blobs')!
  const blobIds: string[] = []
  for (const source of sources) {
    if (!source.pdfBlobId) continue
    const blob = await backend.blobs.get(source.pdfBlobId)
    if (!blob) continue
    blobsFolder.file(source.pdfBlobId, await blob.arrayBuffer())
    blobIds.push(source.pdfBlobId)
  }

  const sourceContentFolder = zip.folder('sourceContent')!
  const sourceContent: { id: string; updatedAt: number }[] = []
  for (const record of sourceContentRecords) {
    // Re-wrapped rather than handed to JSZip as-is: `record.pageHtmlCompressed`
    // reaches here via `backend.docs.list`, which — for the real IndexedDB
    // backend — always returns a plain, same-realm `Uint8Array`, but
    // JSZip's own `instanceof Uint8Array` type check can fail for one
    // that merely *looks* like one (confirmed against the in-memory test
    // backend's `structuredClone`-based storage, which can hand back a
    // cross-realm typed array); constructing a fresh `Uint8Array` from it
    // is a no-op for the normal case and a free fix for that one.
    sourceContentFolder.file(record.id, new Uint8Array(record.pageHtmlCompressed))
    sourceContent.push({ id: record.id, updatedAt: record.updatedAt })
  }

  const manifest: BackupManifest = { version: BACKUP_VERSION, exportedAt: Date.now(), essays, nodes, sources, quotes, graveyard, bookmarks, todos, sourceContent, essayHistory, projects, blobs: blobIds }
  zip.file('data.json', JSON.stringify(manifest, null, 2))
  return zip.generateAsync({ type: 'blob' })
}

export interface RestoreResult {
  mode: 'merge' | 'replace'
  essays: number
  nodes: number
  sources: number
  quotes: number
  graveyard: number
  bookmarks: number
  todos: number
  sourceContent: number
  essayHistory: number
  projects: number
  blobs: number
}

/**
 * `mode: 'merge'` (the safe default) applies a backup doc only where it's
 * newer than whatever's already local — the same last-write-wins rule sync
 * uses, so restoring from an old backup can't clobber newer local work
 * just because it's older. `mode: 'replace'` is the actual disaster-recovery
 * path: wipe local data first, then load the backup verbatim, for "this
 * device's data is gone/corrupted, put it back exactly as it was."
 */
export async function restoreBackup(file: File | Blob, opts: { mode: 'merge' | 'replace' }): Promise<RestoreResult> {
  const zip = await JSZip.loadAsync(file)
  const dataFile = zip.file('data.json')
  if (!dataFile) throw new Error('Not a Marginal backup file — no data.json found inside it.')
  const manifest: BackupManifest = JSON.parse(await dataFile.async('string'))
  if (manifest.version !== BACKUP_VERSION) throw new Error(`Unsupported backup version (${manifest.version}).`)

  if (opts.mode === 'replace') await clearAllLocalData()

  const result: RestoreResult = { mode: opts.mode, essays: 0, nodes: 0, sources: 0, quotes: 0, graveyard: 0, bookmarks: 0, todos: 0, sourceContent: 0, essayHistory: 0, projects: 0, blobs: 0 }

  async function applyDocs<T extends { id: string; updatedAt?: number }>(collection: string, items: T[]): Promise<number> {
    let applied = 0
    for (const item of items) {
      if (opts.mode === 'merge') {
        const existing = await backend.docs.get<T>(collection, item.id)
        if (existing && (existing.updatedAt ?? 0) >= (item.updatedAt ?? 0)) continue
      }
      await backend.docs.put(collection, item)
      applied++
    }
    return applied
  }

  result.essays = await applyDocs('essays', manifest.essays)
  result.nodes = await applyDocs('nodes', manifest.nodes)
  result.sources = await applyDocs('sources', manifest.sources)
  result.quotes = await applyDocs('quotes', manifest.quotes ?? [])
  result.graveyard = await applyDocs('graveyard', manifest.graveyard ?? [])
  result.bookmarks = await applyDocs('bookmarks', manifest.bookmarks ?? [])
  result.todos = await applyDocs('todos', manifest.todos ?? [])

  // Each record's real payload (`pageHtmlCompressed`) lives as its own
  // `sourceContent/{id}` file in the zip, not in the manifest JSON — see
  // BackupManifest's own doc comment on `sourceContent` for why — so
  // reassembling the full `StoredSourceContent` shape `applyDocs` expects
  // means pairing each manifest entry back up with its own file first.
  const sourceContentItems: StoredSourceContent[] = []
  for (const entry of manifest.sourceContent ?? []) {
    const contentFile = zip.file(`sourceContent/${entry.id}`)
    if (!contentFile) continue // the record was listed but its own file went missing from the zip somehow — nothing to restore it from
    const pageHtmlCompressed = await contentFile.async('uint8array')
    sourceContentItems.push({ id: entry.id, updatedAt: entry.updatedAt, pageHtmlCompressed })
  }
  result.sourceContent = await applyDocs('sourceContent', sourceContentItems)
  result.essayHistory = await applyDocs('essayHistory', manifest.essayHistory ?? [])
  result.projects = await applyDocs('projects', manifest.projects ?? [])

  for (const blobId of manifest.blobs) {
    const blobFile = zip.file(`blobs/${blobId}`)
    if (!blobFile) continue
    if (opts.mode === 'merge' && (await backend.blobs.has(blobId))) continue // blob ids are never reused for a different file, so an existing one is already correct
    const bytes = await blobFile.async('arraybuffer')
    await backend.blobs.put(blobId, new Blob([bytes], { type: 'application/pdf' }))
    result.blobs++
  }

  return result
}

async function clearAllLocalData(): Promise<void> {
  const [essays, nodes, sources, quotes, graveyard, bookmarks, todos, essayHistory, projects] = await Promise.all([
    backend.docs.list<Essay>('essays'),
    backend.docs.list<EssayNode>('nodes'),
    backend.docs.list<Source>('sources'),
    backend.docs.list<QuoteBankEntry>('quotes'),
    backend.docs.list<GraveyardFragment>('graveyard'),
    backend.docs.list<Bookmark>('bookmarks'),
    backend.docs.list<TodoItem>('todos'),
    backend.docs.list<EssayCommitEntry>('essayHistory'),
    backend.docs.list<Project>('projects'),
  ])
  for (const e of essays) await backend.docs.delete('essays', e.id)
  for (const n of nodes) await backend.docs.delete('nodes', n.id)
  // Same untracked-transient-wipe reasoning as the sourceContent/blob
  // deletes below — immediately followed by `restoreBackup` writing the
  // backup's own `essayHistory` rows back in, so an old commit left behind
  // here would otherwise dangle as an orphan under an essay id the fresh
  // restore no longer has anything else for.
  for (const c of essayHistory) await backend.docs.delete('essayHistory', c.id)
  for (const s of sources) {
    // Deliberately the plain, untracked `backend.blobs.delete` here, not
    // `deleteBlobTracked` (see `storage/pendingBlobDeletions.ts`) — this is
    // a transient wipe immediately followed by `restoreBackup` writing the
    // backup's own blobs back in, often under these exact same ids. Tracking
    // this as a real remote deletion would, for any blob id the backup
    // happens to restore, mark a blob that's still genuinely in use for
    // deletion on the next sync. A backup that's actually missing some of
    // this account's PDFs (restoring an older one, say) is exactly what
    // `sweepOrphanedRemoteBlobs`'s on-demand full reconciliation is for.
    if (s.pdfBlobId) await backend.blobs.delete(s.pdfBlobId)
    // Same reasoning as the blob deletion right above: a plain, untracked
    // delete, immediately followed by `restoreBackup` writing the
    // backup's own `sourceContent` records back in under these same ids
    // (see its own call to `applyDocs('sourceContent', ...)`) — without
    // this, a 'replace' restore from a backup missing some source's
    // content (an older backup, or one made before this field existed)
    // would leave that source's *old* content record behind as an orphan
    // no longer paired with any `sources` doc, rather than actually
    // reflecting "this device's data is gone, put it back exactly as the
    // backup says it was."
    await backend.docs.delete('sourceContent', s.id)
    await backend.docs.delete('sources', s.id)
  }
  for (const p of projects) await backend.docs.delete('projects', p.id)
  for (const q of quotes) await backend.docs.delete('quotes', q.id)
  for (const g of graveyard) await backend.docs.delete('graveyard', g.id)
  for (const b of bookmarks) await backend.docs.delete('bookmarks', b.id)
  for (const t of todos) await backend.docs.delete('todos', t.id)
}

export function backupFileName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `marginal-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`
}
