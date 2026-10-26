/**
 * The impure half of importing a zipped LaTeX project: unzip, parse the
 * attached `.bib` file(s) into sources (creating one per new entry — an
 * entry whose key already matches an existing local source is left alone
 * rather than duplicated, so re-importing the same project twice doesn't
 * pile up copies), hand the resolved source map to `parseLatexDocument()`
 * (see `lib/latexImport.ts` for the actual parsing — this file is
 * deliberately thin around it), then builds a real, doc-based `Essay`
 * record out of the resulting tree.
 *
 * `parseLatexDocument` already produces a `ParsedLatexNode` tree shaped
 * exactly like a real `EssayNode` tree (`html`-as-`draftContent`, children
 * embedded via the same `markerHtml` markers, footnotes scoped per node) —
 * rather than hand-building PM JSON nodes a second time here, this flattens
 * that tree into real-shaped (if never-persisted) `EssayNode` objects and
 * feeds them straight through `migrateEssay` (`lib/pmMigration.ts`), the
 * exact same HTML->doc conversion a real account's own essays go through.
 */
import JSZip from 'jszip'
import { id } from '../lib/id'
import { parseBibtex } from '../lib/bibtex'
import { extractBibSource, parseLatexDocument, pickMainTexFile, type ParsedLatexNode, type ProjectFile } from '../lib/latexImport'
import { migrateEssay } from '../lib/pmMigration'
import { backend } from '../storage'
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

/** Flattens a parsed node tree into real-shaped `EssayNode` objects, depth-first — never persisted, just `migrateEssay`'s own expected input shape (it already walks from a root id through child markers exactly like `loadNodeMap` does on real stored nodes). */
function flattenParsedTree(essayId: string, node: ParsedLatexNode, now: number, out: EssayNode[]): void {
  out.push({
    id: node.id,
    essayId,
    title: node.title,
    versions: [],
    headVersionId: '',
    draftContent: node.html,
    footnotes: node.footnotes,
    createdAt: now,
    updatedAt: now,
  })
  for (const child of node.children) flattenParsedTree(essayId, child, now, out)
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
  const essayId = id()
  const flatNodes: EssayNode[] = []
  flattenParsedTree(essayId, parsed.root, now, flatNodes)
  // `citationHtml` (used by `parseLatexDocument`/`convertInline` above)
  // bakes each citation chip's `data-source-id` as the `Source`'s own
  // `id`, not its bibtex key — `migrateEssay` needs its `sources` map
  // keyed the same way to resolve them back, unlike `sourceByKey` here
  // (keyed by bibtex key, for citation-key/footnote-matching lookups).
  const sourcesById = new Map<string, Source>([...sourceByKey.values()].map((s) => [s.id, s]))
  const migrated = migrateEssay({ title: parsed.title, rootNodeId: parsed.root.id }, flatNodes, sourcesById)

  const essay: Essay = { id: essayId, title: parsed.title, rootNodeId: parsed.root.id, doc: migrated.doc, comments: migrated.comments, createdAt: now, updatedAt: now }
  await backend.docs.put<Essay>('essays', essay)

  return {
    essay,
    sourcesInBib: bibEntries.length,
    sourcesAdded,
    footnotesConverted: parsed.stats.footnotesConverted,
    footnotesKept: parsed.stats.footnotesKept,
    warnings: [...parsed.warnings, ...migrated.warnings],
  }
}
