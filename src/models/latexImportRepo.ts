/**
 * The impure half of importing a zipped LaTeX project: unzip, parse the
 * attached `.bib` file(s) into sources (creating one per new entry — an
 * entry whose key already matches an existing local source is left alone
 * rather than duplicated, so re-importing the same project twice doesn't
 * pile up copies), hand the resolved source map to `parseLatexDocument()`
 * (see `lib/latexImport.ts` for the actual parsing — this file is
 * deliberately thin around it), then persist the resulting tree as a real
 * Essay + EssayNode records.
 */
import JSZip from 'jszip'
import { backend } from '../storage'
import { id } from '../lib/id'
import { parseBibtex } from '../lib/bibtex'
import { extractBibSource, parseLatexDocument, pickMainTexFile, type ParsedLatexNode, type ProjectFile } from '../lib/latexImport'
import { createSource, listSources } from './sourcesRepo'
import type { Essay, EssayNode, Source } from './types'

export interface LatexImportSummary {
  essay: Essay
  sourcesInBib: number
  sourcesAdded: number
  footnotesConverted: number
  footnotesKept: number
  warnings: string[]
}

async function readProjectFiles(zipFile: Blob): Promise<ProjectFile[]> {
  const zip = await JSZip.loadAsync(zipFile)
  const files: ProjectFile[] = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    if (path.startsWith('__MACOSX/') || path.split('/').pop()?.startsWith('.')) continue
    if (!/\.(tex|bib)$/i.test(path)) continue
    files.push({ path, content: await entry.async('string') })
  }
  return files
}

function titleFromFileName(path: string): string {
  const base = path.split('/').pop() || path
  const withoutExt = base.replace(/\.tex$/i, '')
  const spaced = withoutExt.replace(/[_-]+/g, ' ').trim()
  return spaced || 'Imported LaTeX project'
}

/** Persists a parsed node tree depth-first, writing each node's own record directly (bypassing essaysRepo's createEssay/createChildNode, which each mint their own id — this tree already has real ids baked into its embedded child markers and footnote-ref attributes, from parseLatexDocument). */
async function persistTree(essayId: string, node: ParsedLatexNode, now: number): Promise<void> {
  const record: EssayNode = {
    id: node.id,
    essayId,
    title: node.title,
    versions: [{ id: id(), content: node.html, comments: [], createdAt: now, label: 'Imported from LaTeX' }],
    headVersionId: '',
    draftContent: node.html,
    footnotes: node.footnotes,
    createdAt: now,
    updatedAt: now,
  }
  record.headVersionId = record.versions[0].id
  await backend.docs.put<EssayNode>('nodes', record)
  for (const child of node.children) await persistTree(essayId, child, now)
}

export async function importLatexProject(zipFile: Blob): Promise<LatexImportSummary> {
  const files = await readProjectFiles(zipFile)
  const bibEntries = parseBibtex(extractBibSource(files))

  const existingSources = await listSources()
  const sourceByKey = new Map<string, Source>(existingSources.map((s) => [s.bibtex.key, s]))
  let sourcesAdded = 0
  for (const entry of bibEntries) {
    if (sourceByKey.has(entry.key)) continue
    const source = await createSource(entry)
    sourceByKey.set(entry.key, source)
    sourcesAdded++
  }

  const mainTex = pickMainTexFile(files)
  if (!mainTex) throw new Error('No .tex file found in this zip.')

  const parsed = parseLatexDocument(mainTex.content, sourceByKey, titleFromFileName(mainTex.path))

  const now = Date.now()
  const essay: Essay = { id: id(), title: parsed.title, rootNodeId: parsed.root.id, createdAt: now, updatedAt: now }
  await persistTree(essay.id, parsed.root, now)
  await backend.docs.put<Essay>('essays', essay)

  return {
    essay,
    sourcesInBib: bibEntries.length,
    sourcesAdded,
    footnotesConverted: parsed.stats.footnotesConverted,
    footnotesKept: parsed.stats.footnotesKept,
    warnings: parsed.warnings,
  }
}
