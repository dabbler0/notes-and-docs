import JSZip from 'jszip'
import type { LegacyEssay, LegacyEssayNode, LegacyGraveyardFragment, Source } from './types'

/**
 * Reads just enough of the real app's own backup `.zip` (`lib/backup.ts`'s
 * `BackupManifest`, `exportBackup`'s own output) to drive `migrate.ts` —
 * `essays`/`nodes`/`sources`/`graveyard` only. Every other field a real
 * backup carries (`quotes`, `bookmarks`, `todos`, `sourceContent`,
 * `essayHistory`, `projects`, `blobs`) isn't read by this demo — it's
 * simply nothing this migration (essay structure/content) has any use for.
 */
export interface LoadedBackup {
  essays: LegacyEssay[]
  nodes: LegacyEssayNode[]
  sources: Map<string, Source>
  graveyard: LegacyGraveyardFragment[]
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
  const graveyard: LegacyGraveyardFragment[] = (manifest.graveyard ?? []).filter((g: LegacyGraveyardFragment) => !g.deleted)
  return { essays, nodes, sources, graveyard }
}
