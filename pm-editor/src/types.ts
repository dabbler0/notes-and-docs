/**
 * Trimmed stand-ins for the real app's `models/types.ts` — just the shape
 * `bibtex.ts`/`export.ts` actually read (`id`, `bibtex.fields`). The real
 * migration imports the genuine `Source`/`BibtexEntry` types directly
 * instead of this file once this code moves into the real app.
 */
export interface BibtexEntry {
  type: string
  key: string
  fields: Record<string, string>
}

export interface Source {
  id: string
  bibtex: BibtexEntry
  noPageNumbers?: boolean
  pageOffset?: number
}
