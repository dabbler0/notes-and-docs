/**
 * The experimental "download as EPUB" feature's single entry point: turns a
 * source's already-extracted `pageHtml` into a downloadable, sectioned
 * EPUB, best-effort-classified by `classify.ts` and assembled by
 * `buildEpub.ts`. See both of those for what this can and can't reliably
 * detect — this file is purely the glue between a `Source` and a `Blob`.
 */
import { displayAuthors, displayTitle } from '../bibtex'
import { filenameFor } from '../download'
import type { Source } from '../../models/types'
import { buildEpub } from './buildEpub'
import { classifyPages } from './classify'

export async function generateEpub(source: Source): Promise<Blob> {
  const blocks = classifyPages(source.pageHtml)
  const title = displayTitle(source.bibtex)
  const author = displayAuthors(source.bibtex) || undefined
  return buildEpub({ title, author }, blocks)
}

export function epubFilenameFor(source: Source): string {
  return `${filenameFor(displayTitle(source.bibtex))}.epub`
}
