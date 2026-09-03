/** Triggers a browser download of `blob` as `filename`, the ordinary way (a throwaway anchor + object URL). */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A safe-ish filename stem derived from an essay's title. */
export function filenameFor(title: string): string {
  return (
    (title || 'essay')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'essay'
  )
}
