import JSZip from 'jszip'
import type { LegacyEssay, LegacyEssayNode, Source } from './types'

/**
 * Reads just enough of the real app's own backup `.zip` (`lib/backup.ts`'s
 * `BackupManifest`, `exportBackup`'s own output) to drive `migrate.ts` —
 * `essays`/`nodes`/`sources` only. Every other field a real backup carries
 * (`quotes`, `graveyard`, `bookmarks`, `todos`, `sourceContent`,
 * `essayHistory`, `projects`, `blobs`) is read by this demo, it's simply
 * nothing this migration (essay structure/content only) has any use for.
 */
export interface LoadedBackup {
  essays: LegacyEssay[]
  nodes: LegacyEssayNode[]
  sources: Map<string, Source>
}

export async function loadBackupZip(file: File | Blob): Promise<LoadedBackup> {
  const zip = await JSZip.loadAsync(file)
  const dataFile = zip.file('data.json')
  if (!dataFile) throw new Error('Not a Marginal backup file — no data.json found inside it.')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manifest: any = JSON.parse(await dataFile.async('string'))
  const essays: LegacyEssay[] = manifest.essays ?? []
  const nodes: LegacyEssayNode[] = manifest.nodes ?? []
  const sources = new Map<string, Source>((manifest.sources ?? []).map((s: Source) => [s.id, s]))
  return { essays, nodes, sources }
}
