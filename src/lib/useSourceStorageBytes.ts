import { useEffect, useState } from 'preact/hooks'
import { getSourceStorageBytes } from '../models/sourcesRepo'
import type { Source } from '../models/types'

/** Loads a source's on-disk footprint (see `getSourceStorageBytes`) lazily
 * — it's an IndexedDB read of the PDF blob (or a `Blob([...]).size` over
 * the extracted text), cheap but still async, so this starts out `null`
 * ("not known yet") rather than blocking whatever renders it. */
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
  }, [source.id, source.pdfBlobId, source.textOnly, source.pageHtml])

  return bytes
}
