import { useEffect, useState } from 'preact/hooks'
import { getSourceStorageBytes } from '../models/sourcesRepo'
import type { Source } from '../models/types'

/** Loads a source's on-disk footprint (see `getSourceStorageBytes`) lazily
 * — a metadata-only IndexedDB read (`blobs.sizeOf`) for a PDF, or just
 * `source.contentBytes` itself for text-only (no read at all, let alone a
 * decompress/recompress), so this starts out `null` ("not known yet")
 * mostly for the PDF case's one genuinely async read, rather than because
 * computing it is ever actually slow. Depends on `contentBytes`/
 * `pdfBlobId`/`textOnly` specifically (not `pageHtml`, which this never
 * touches and which usually isn't even loaded — see that field's own doc
 * comment on `Source`) so this doesn't re-fire on an identity change that
 * has nothing to do with what it's actually reporting. */
export function useSourceStorageBytes(source: Source): number | null {
  const [bytes, setBytes] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setBytes(null)
    getSourceStorageBytes(source).then((b) => {
      if (!cancelled) setBytes(b)
    })
    return () => {
      cancelled = true
    }
  }, [source.id, source.pdfBlobId, source.textOnly, source.contentBytes])

  return bytes
}
