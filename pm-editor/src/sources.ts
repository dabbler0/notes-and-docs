import type { Source } from './types'

/**
 * A tiny stand-in for the real app's `sourcesRepo.ts` — real `Source`
 * shapes (so `bibtex.ts`/`export.ts`, copied in unmodified, work exactly
 * as they do against the real app's own data) rather than a one-off
 * `{id, label}` shape. The `citation` NodeView (`nodeViews.ts`) renders
 * fresh from this map on every call — the actual thing this prototype
 * exists to demonstrate (see `schema.ts`'s own doc comment on `citation`).
 * The real migration wires the same NodeView up to `sourcesRepo.ts` instead.
 */
export const fakeSources: Record<string, Source> = {
  src1: { id: 'src1', bibtex: { type: 'article', key: 'smith2020', fields: { author: 'Smith, Jane', year: '2020', title: 'On Structured Documents', journal: 'Journal of Examples' } } },
  src2: {
    id: 'src2',
    bibtex: { type: 'incollection', key: 'doelee2019', fields: { author: 'Doe, John and Lee, Pat', year: '2019', title: 'A Chapter Worth Citing', booktitle: 'The Big Book of Examples' } },
  },
}

export const fakeSourcesMap = new Map(Object.entries(fakeSources))
