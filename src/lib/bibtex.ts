import type { BibtexEntry, Source } from '../models/types'
import { escapeAttr, escapeHtml } from './html'

/**
 * Small, permissive BibTeX parser: supports `{ }` and `" "` delimited field
 * values, nested braces, and `@comment`/blank-line separated entries. Good
 * enough for pasted-in entries from Google Scholar / Zotero / etc.; not a
 * full BibTeX-grammar implementation.
 */
export function parseBibtex(src: string): BibtexEntry[] {
  const entries: BibtexEntry[] = []
  let i = 0
  const n = src.length

  const skipWs = () => {
    while (i < n && /\s/.test(src[i])) i++
  }

  while (i < n) {
    const at = src.indexOf('@', i)
    if (at === -1) break
    i = at + 1
    const typeStart = i
    while (i < n && /[a-zA-Z]/.test(src[i])) i++
    const type = src.slice(typeStart, i).toLowerCase()
    skipWs()
    if (src[i] !== '{' && src[i] !== '(') continue
    const closeChar = src[i] === '{' ? '}' : ')'
    i++
    skipWs()
    const keyStart = i
    while (i < n && src[i] !== ',' && src[i] !== closeChar) i++
    const key = src.slice(keyStart, i).trim()
    if (src[i] === ',') i++

    const fields: Record<string, string> = {}
    skipWs()
    while (i < n && src[i] !== closeChar) {
      skipWs()
      const nameStart = i
      while (i < n && /[a-zA-Z0-9_-]/.test(src[i])) i++
      const name = src.slice(nameStart, i).toLowerCase()
      skipWs()
      if (src[i] !== '=') {
        // malformed field, bail to next comma to avoid infinite loop
        while (i < n && src[i] !== ',' && src[i] !== closeChar) i++
        if (src[i] === ',') i++
        continue
      }
      i++ // '='
      skipWs()
      let value = ''
      if (src[i] === '{') {
        i++ // consume the opening brace (not part of the value)
        let depth = 1
        while (i < n && depth > 0) {
          if (src[i] === '{') {
            depth++
            value += src[i]
          } else if (src[i] === '}') {
            depth--
            if (depth > 0) value += src[i]
          } else {
            value += src[i]
          }
          i++
        }
      } else if (src[i] === '"') {
        i++
        while (i < n && src[i] !== '"') {
          value += src[i]
          i++
        }
        i++
      } else {
        const vStart = i
        while (i < n && src[i] !== ',' && src[i] !== closeChar) i++
        value = src.slice(vStart, i).trim()
      }
      if (name) fields[name] = value.replace(/\s+/g, ' ').trim()
      skipWs()
      if (src[i] === ',') {
        i++
        skipWs()
      }
    }
    i++ // closing brace/paren
    if (type && type !== 'comment' && key) {
      entries.push({ type, key, fields })
    }
  }

  return entries
}

export function formatBibtex(entry: BibtexEntry): string {
  const fieldOrder = [
    'title',
    'author',
    'year',
    'journal',
    'booktitle',
    'publisher',
    'volume',
    'number',
    'pages',
    'doi',
    'url',
    'note',
  ]
  const keys = [...fieldOrder.filter((f) => f in entry.fields), ...Object.keys(entry.fields).filter((f) => !fieldOrder.includes(f))]
  const body = keys.map((k) => `  ${k} = {${entry.fields[k]}}`).join(',\n')
  return `@${entry.type}{${entry.key},\n${body}\n}`
}

/** Short inline citation label, e.g. "(Smith, 2020)" or "(Smith & Lee, 2020)". */
export function citationLabel(entry: BibtexEntry): string {
  const authors = entry.fields.author
  const year = entry.fields.year ?? 'n.d.'
  if (!authors) return `(${entry.key}, ${year})`
  const names = authors.split(' and ').map((a) => a.split(',')[0].trim())
  if (names.length === 1) return `(${names[0]}, ${year})`
  if (names.length === 2) return `(${names[0]} & ${names[1]}, ${year})`
  return `(${names[0]} et al., ${year})`
}

export function displayTitle(entry: BibtexEntry): string {
  return entry.fields.title || entry.key
}

/**
 * A single-paragraph, human-readable rendering of a BibTeX entry — "Jane
 * Tester (2024). A Test PDF Document. Journal of Examples, 12(3), 45-67."
 * — for showing in place of the raw `@article{…}` source everywhere that
 * source isn't actually being edited (see `formatBibtex`, which this is
 * deliberately not: that one round-trips back through `parseBibtex`, this
 * one never needs to be parsed, only read). Not tied to any particular
 * citation style (APA, MLA, …) — just author/year/title/venue in a plain,
 * legible order, degrading gracefully as fields go missing (an entry with
 * only a title still renders as just the title, not a sentence of empty
 * punctuation).
 */
export function formatCitation(entry: BibtexEntry): string {
  const f = entry.fields
  const sentences: string[] = []
  const authorYear = [f.author, f.year ? `(${f.year})` : ''].filter(Boolean).join(' ')
  if (authorYear) sentences.push(authorYear)
  sentences.push(f.title || entry.key)
  const venue = f.journal || f.booktitle
  const venueBits = [venue, f.volume ? (f.number ? `${f.volume}(${f.number})` : f.volume) : '', f.pages ? `pp. ${f.pages}` : ''].filter(Boolean)
  if (venueBits.length > 0) sentences.push(venueBits.join(', '))
  else if (f.publisher) sentences.push(f.publisher)
  return sentences.join('. ') + '.'
}

export function displayAuthors(entry: BibtexEntry): string {
  return entry.fields.author || ''
}

export function emptyEntry(key: string): BibtexEntry {
  return { type: 'article', key, fields: {} }
}

/**
 * Turns a raw page number — always the literal PDF/text-viewer page a quote
 * was taken from, the same one "View in source" navigates by — into what a
 * citation should actually display, honoring a source's own page-numbering
 * preferences (set in `SourceWorkspace`): `null` (no page shown at all)
 * for a source marked as having no page numbers of its own, or the raw page
 * shifted by `pageOffset` otherwise. `pageOffset` can run either direction:
 * positive for a PDF with some number of unnumbered pages (a cover, a title
 * page) before the document's own page 1, negative for a work — a journal
 * article, typically — whose PDF starts already numbered higher than 1 (a
 * PDF starting on the work's own printed page 153 wants an offset of -152,
 * so its page 1 still shifts up to 153). Also `null` for a falsy raw page
 * or an offset big enough to push the result to zero or below, since
 * neither is a real page to cite.
 */
export function citationPage(source: Source, page: number | undefined): number | null {
  if (!page || source.noPageNumbers) return null
  const shifted = page - (source.pageOffset ?? 0)
  return shifted > 0 ? shifted : null
}

/**
 * `essaysRepo.ts`'s own migration for a legacy citation (see
 * `citationHtml`'s doc comment on `data-cite-v`) uses this to recover a
 * freeform note from a chip's old, otherwise-unstructured label text, now
 * that `data-source-id` alone is enough to know *which* source it was
 * always pointing to — the one piece of real information such a label
 * ever added on top of that is wherever it mentioned a page, so this
 * pulls out the last run of digits in the text, or the last `N-N` page
 * range (arbitrary whitespace allowed, or none, around the dash — "12-15",
 * "12 - 15", "12-  15" all match as one range rather than two separate
 * numbers), whichever comes later — and formats it the way a page note
 * from this migration is meant to read: `p12` for a single page, `pp12-15`
 * for a range (dashes/whitespace normalized away either way).
 *
 * Returns `''` — no note at all, the ordinary case for a citation that
 * never had a page in the first place — in two situations: no digits
 * anywhere in the text, or the text contains *exactly one* number and
 * that number is the source's own publication year (`(Smith, 2020)`,
 * where "2020" is the year the citation label itself always included,
 * not a page). That exclusion only fires when it's the *only* number in
 * the text — a citation that mentions the year *and* a real page
 * ("Smith, 2020, p. 2020" — contrived, but possible) still gets that
 * page, since there's then no ambiguity about which number is which.
 */
export function extractLegacyCitationNote(text: string, year: string | undefined): string {
  const matches = Array.from(text.matchAll(/\d+\s*-\s*\d+|\d+/g)).map((m) => m[0])
  if (matches.length === 0) return ''
  const last = matches[matches.length - 1]
  const range = last.match(/^(\d+)\s*-\s*(\d+)$/)
  if (matches.length === 1 && !range && year !== undefined && last === year) return ''
  return range ? `pp${range[1]}-${range[2]}` : `p${last}`
}

/**
 * Which citation style a label is rendered in — only `'author-date'` (the
 * parenthetical form this app has always used) is actually implemented
 * below, but it's kept as its own type/parameter from the start so a
 * future citation-style setting (author-title, numeric, …) has something
 * to switch on without needing another data migration: every citation
 * chip's own structured data (a source reference plus a freeform note —
 * see `citationHtml`) already carries everything any of those styles
 * would need to render from. Adding a style is purely a matter of
 * extending `renderCitationLabel`'s own switch, never touching stored
 * data or how a chip is inserted.
 */
export type CitationStyle = 'author-date'

/**
 * Turns a `BibtexEntry` plus an optional freeform note ("p. 5", "ch. 3",
 * "forthcoming", …) into a citation's actual display text. The one
 * function a future citation-style setting would extend — see
 * `CitationStyle`'s own doc comment.
 */
export function renderCitationLabel(entry: BibtexEntry, note?: string, _style: CitationStyle = 'author-date'): string {
  const base = citationLabel(entry)
  return note ? `${base}, ${note}` : base
}

/**
 * The literal text (", " for `'author-date'`, the only style that exists
 * today) joining `citationLabel`'s own output to a freeform note, when
 * there is one — `citationHtml` needs this on its own, split out from
 * `renderCitationLabel` above, since the note has to be its own real text
 * node in the DOM (see that function's own doc comment on why) rather
 * than baked into one flat label string. A future second style would
 * need its own separator here too, alongside its own case in
 * `renderCitationLabel`.
 */
function citationNoteSeparator(_style: CitationStyle = 'author-date'): string {
  return ', '
}

/**
 * `citationHtml`'s own page-number convenience, also usable directly by
 * any other caller that already has a raw PDF/text-viewer page rather
 * than freeform note text (a quote's own page, mainly) — see
 * `citationPage`'s own doc comment for the offset/no-page-numbers
 * handling this defers to. Empty string (not null) when there's nothing
 * to show, so a caller can splice it straight into a template without an
 * extra null check.
 */
export function pageNote(source: Source, page: number | undefined): string {
  const p = citationPage(source, page)
  return p ? `p. ${p}` : ''
}

/**
 * The inline citation chip inserted by "Cite," "Quote from PDF," and "Link
 * to source": a `<cite>` when the source has no URL to point at, or an
 * `<a>` wearing the same `.citation` styling when it does — either way
 * carrying two structured fields as data attributes, not just baked into
 * the rendered text: `data-source-id`, a unique reference to the source,
 * and `data-note` (omitted when empty), a separate freeform "page number
 * or other note." Together they're everything `renderCitationLabel` (and
 * so a future citation-style setting) needs to re-render this exact
 * citation in a different style later, without re-deriving anything from
 * the display text itself.
 *
 * The rendered content is split into two pieces, not one flat label
 * string: `citationLabel`'s own output sits in a `.citation-base` span
 * marked `contenteditable="false"`, and the note (plus its separator,
 * when there is one) follows as plain text, a normal sibling inside the
 * chip. `SectionBlock.tsx`'s `syncCitationNotes` reads that trailing text
 * back out on every keystroke and keeps `data-note` in sync with it — so
 * a citation is editable exactly where it has a real freeform field to
 * edit (the note) and nowhere else: the base span is unfocusable/
 * unenterable the same way any other `contenteditable="false"` marker in
 * this editor is (a subsection embed, a footnote ref), so arrow-key
 * navigation and typing both skip over it rather than editing the
 * generated author/date text in place.
 *
 * `data-cite-v="2"` marks a chip as using this structured shape.
 * `essaysRepo.ts`'s own `migrateLegacyCitations` upgrades any `.citation`
 * element *without* it — one from before this existed, where the label
 * was the only thing ever stored, freeform and hand-editable — into this
 * same shape (or, failing that, flattens it to plain text): anything
 * downstream (export, a future style change, `syncCitationNotes` above)
 * that expects structured data now expects it from every `.citation`
 * element it sees, which only holds if there's no silent, unstructured
 * leftover from before passing itself off as one.
 *
 * `opts.note` is used directly when given; `opts.page` is the older,
 * still-supported shorthand for a caller that has a raw PDF page rather
 * than already-formatted note text (quote insertion, mainly), converted
 * via `pageNote`. Passing both prefers `note`.
 *
 * A note-less chip still gets one real, invisible zero-width-space
 * character (`​`) after the base span, rather than nothing — the
 * same caret-landing-placeholder trick `insertFootnote` in
 * EssayWorkspace.tsx uses for its own otherwise-empty marker (see that
 * function's own doc comment for the fuller browser-behavior story),
 * applied here for the opposite reason: that one keeps a blank click
 * from landing *inside* an empty marker, this one keeps it from landing
 * *outside* the chip entirely. Confirmed live: with truly nothing after
 * `.citation-base` (the chip's last child, `contenteditable="false"`),
 * clicking right after the chip and typing placed the new text as a
 * sibling of the whole `<cite>`/`<a>` in the surrounding paragraph
 * instead of inside it, so a citation with no note yet had no way to
 * gain one by typing — only ever extending an *existing* note worked.
 * `syncCitationNotes` strips any zero-width space out of what it reads
 * back as the note, and the export helpers that escape plain text
 * (`mdEscapeText`/`texEscape`) strip it from exported output too, so it
 * never surfaces as a stray invisible character anywhere downstream.
 */
export function citationHtml(source: Source, opts: { page?: number; note?: string } = {}): string {
  const note = opts.note?.trim() || pageNote(source, opts.page)
  const base = escapeHtml(citationLabel(source.bibtex))
  const trailing = note ? escapeHtml(citationNoteSeparator() + note) : '​'
  const noteAttr = note ? ` data-note="${escapeAttr(note)}"` : ''
  const inner = `<span class="citation-base" contenteditable="false">${base}</span>${trailing}`
  const url = source.bibtex.fields.url
  if (url) {
    return `<a class="citation" data-source-id="${source.id}" data-cite-v="2"${noteAttr} href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
  }
  return `<cite class="citation" data-source-id="${source.id}" data-cite-v="2"${noteAttr}>${inner}</cite>`
}
