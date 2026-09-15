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
import type { Essay, EssayNode, GraveyardFragment, QuoteBankEntry, Source } from '../models/types'

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
  /** Which blob ids the zip's blobs/ folder actually contains — a source can reference a pdfBlobId whose blob went missing locally, so this isn't just "every source's pdfBlobId." */
  blobs: string[]
}

export async function exportBackup(): Promise<Blob> {
  const [essays, nodes, sources, quotes, graveyard] = await Promise.all([
    backend.docs.list<Essay>('essays'),
    backend.docs.list<EssayNode>('nodes'),
    backend.docs.list<Source>('sources'),
    backend.docs.list<QuoteBankEntry>('quotes'),
    backend.docs.list<GraveyardFragment>('graveyard'),
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

  const manifest: BackupManifest = { version: BACKUP_VERSION, exportedAt: Date.now(), essays, nodes, sources, quotes, graveyard, blobs: blobIds }
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

  const result: RestoreResult = { mode: opts.mode, essays: 0, nodes: 0, sources: 0, quotes: 0, graveyard: 0, blobs: 0 }

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
  const [essays, nodes, sources, quotes, graveyard] = await Promise.all([
    backend.docs.list<Essay>('essays'),
    backend.docs.list<EssayNode>('nodes'),
    backend.docs.list<Source>('sources'),
    backend.docs.list<QuoteBankEntry>('quotes'),
    backend.docs.list<GraveyardFragment>('graveyard'),
  ])
  for (const e of essays) await backend.docs.delete('essays', e.id)
  for (const n of nodes) await backend.docs.delete('nodes', n.id)
  for (const s of sources) {
    if (s.pdfBlobId) await backend.blobs.delete(s.pdfBlobId)
    await backend.docs.delete('sources', s.id)
  }
  for (const q of quotes) await backend.docs.delete('quotes', q.id)
  for (const g of graveyard) await backend.docs.delete('graveyard', g.id)
}

export function backupFileName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `marginal-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`
}
