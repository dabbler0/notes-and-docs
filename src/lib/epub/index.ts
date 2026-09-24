/**
 * The experimental "download as EPUB" feature's small shared bit: the
 * filename a generated EPUB downloads under. Building the file itself goes
 * through `EpubExportDialog.tsx`, which calls `classify.ts`/`buildEpub.ts`
 * directly rather than through a one-shot helper here — the whole point of
 * that dialog is to let a person confirm or correct the classification
 * (running headers/footers, headings, footnotes) before it's baked into the
 * download, which a single `source -> Blob` call couldn't offer a hook for.
 */
import { displayTitle } from '../bibtex'
import { filenameFor } from '../download'
import type { Source } from '../../models/types'

export function epubFilenameFor(source: Source): string {
  return `${filenameFor(displayTitle(source.bibtex))}.epub`
}
