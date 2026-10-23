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
    'editor',
    'translator',
    'year',
    'journal',
    'booktitle',
    'publisher',
    'volume',
    'number',
    'pages',
    'isbn',
    'doi',
    'url',
    'note',
  ]
  const keys = [...fieldOrder.filter((f) => f in entry.fields), ...Object.keys(entry.fields).filter((f) => !fieldOrder.includes(f))]
  const body = keys.map((k) => `  ${k} = {${entry.fields[k]}}`).join(',\n')
  return `@${entry.type}{${entry.key},\n${body}\n}`
}

/** "Smith", "Smith & Lee", or "Smith et al." from a raw BibTeX author field ("Smith, Jane and Lee, Bob and …"), or `fallback` when there's no author field at all — the name-shortening both `citationLabel` and `citationLabelAuthorTitle` need. */
function shortAuthorNames(authors: string | undefined, fallback: string): string {
  if (!authors) return fallback
  const names = authors.split(' and ').map((a) => a.split(',')[0].trim())
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} & ${names[1]}`
  return `${names[0]} et al.`
}

/** The part of `citationLabel`'s output inside the parens, e.g. "Smith, 2020" — shared with `citationLabelOpen` below, which needs the same text but without the closing paren. */
function authorYearCore(entry: BibtexEntry): string {
  const year = entry.fields.year ?? 'n.d.'
  return `${shortAuthorNames(entry.fields.author, entry.key)}, ${year}`
}

/** The author-title equivalent of `authorYearCore`, e.g. 'Smith, "An Early Paper"'. */
function authorTitleCore(entry: BibtexEntry): string {
  const title = entry.fields.title || entry.key
  return `${shortAuthorNames(entry.fields.author, entry.key)}, "${title}"`
}

/**
 * Short inline citation label, e.g. "(Smith, 2020)" — or, with a freeform
 * note (a page number, "ch. 3", …), "(Smith, 2020, p. 12)": the note sits
 * *inside* the parens, alongside the author/year, rather than trailing
 * them outside — e.g. "(Smith, 2020, p. 12)" not "(Smith, 2020), p. 12".
 */
export function citationLabel(entry: BibtexEntry, note?: string): string {
  const core = authorYearCore(entry)
  return note ? `(${core}, ${note})` : `(${core})`
}

/**
 * The print export's "author-title" citation style, e.g. '(Smith, "An
 * Early Paper")' or '(Smith et al., "Longer Title", p. 12)' with a note —
 * see `PrintCitationStyle` in lib/export.ts for where this is chosen from.
 */
export function citationLabelAuthorTitle(entry: BibtexEntry, note?: string): string {
  const core = authorTitleCore(entry)
  return note ? `(${core}, ${note})` : `(${core})`
}

/**
 * The citation chip's own non-editable prefix (see `citationHtml`'s doc
 * comment on why the chip is split into a fixed base and an editable
 * note): the opening paren plus author/year, deliberately *without* the
 * closing paren — the note (editable) and a fixed closing-paren span both
 * come after it, so the rendered result still reads as one parenthetical
 * with the note inside it ("(Smith, 2020, p. 12)") while only the note
 * itself is ever actually edited in place.
 */
export function citationLabelOpen(entry: BibtexEntry): string {
  return `(${authorYearCore(entry)}`
}

export function displayTitle(entry: BibtexEntry): string {
  return entry.fields.title || entry.key
}

/**
 * Whether to include a source's own `url` field alongside its `doi` —
 * when `false`, the URL is only shown if there's no DOI at all, since a
 * DOI already resolves to a URL of its own (`https://doi.org/<doi>`) and
 * showing both reads as redundant. `ExportDialog`'s own checkbox drives
 * this for an actual export; every other caller (a source's own display
 * in `SourceWorkspace`, etc.) leaves it at the default — always show
 * both when both are present — since there's no "already showing a DOI
 * elsewhere in this same document" context to reason about there.
 */
export interface TrailingFieldsOptions {
  includeUrlWhenDoi?: boolean
}

/**
 * ISBN, a DOI (rendered as a clickable link whose own visible text drops
 * the "https://" scheme — "doi.org/10.1000/…", not
 * "https://doi.org/10.1000/…" — via plain Markdown link syntax, resolved
 * to a real `<a>` by `inlineMarkdownToHtml` wherever a citation ends up
 * in the print view, and still perfectly readable as literal
 * `[text](url)` in the plain .md export), a URL (same link treatment,
 * verbatim, only shown per `opts.includeUrlWhenDoi` — see its own doc
 * comment — when a DOI is also present), and a free-text BibTeX `note`
 * field — in that order, one clause per field actually present, appended
 * to the very end of a citation/bibliography entry by every renderer in
 * this app (`formatCitation` right below, and the APA/MLA/Chicago
 * formatters in lib/export.ts). `escape` lets a caller Markdown-escape
 * each field's own text first (the export.ts formatters do, via
 * `mdEscapeText`; this function's own default — identity — matches how
 * `formatCitation` has never escaped any of its other fields either) —
 * never applied to the `[text](url)` link syntax itself, only to the raw
 * field value substituted inside it, so a stray Markdown-special
 * character sitting in a URL can't accidentally break or extend the link.
 */
export function trailingCitationFields(f: Record<string, string>, escape: (s: string) => string = (s) => s, opts: TrailingFieldsOptions = {}): string[] {
  const { includeUrlWhenDoi = true } = opts
  const out: string[] = []
  if (f.isbn) out.push(`ISBN: ${escape(f.isbn)}`)
  if (f.doi) {
    const doiUrl = /^https?:\/\//.test(f.doi) ? f.doi : `https://doi.org/${f.doi}`
    const doiDisplay = doiUrl.replace(/^https?:\/\//, '')
    out.push(`[${escape(doiDisplay)}](${escape(doiUrl)})`)
  }
  if (f.url && (includeUrlWhenDoi || !f.doi)) out.push(`[${escape(f.url)}](${escape(f.url)})`)
  if (f.note) out.push(escape(f.note))
  return out
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
export function formatCitation(entry: BibtexEntry, escape: (s: string) => string = (s) => s, opts: TrailingFieldsOptions = {}): string {
  const f = entry.fields
  const sentences: string[] = []
  const authorYear = [f.author ? escape(f.author) : '', f.year ? `(${escape(f.year)})` : ''].filter(Boolean).join(' ')
  if (authorYear) sentences.push(authorYear)
  sentences.push(escape(f.title || entry.key))
  // Shown as its own short sentence, right after the title — whichever of
  // the two is actually present (an edited volume's own editor, a
  // translated work's own translator, both, or neither).
  const editorTranslator = [f.editor ? `Ed. ${escape(f.editor)}` : '', f.translator ? `Trans. ${escape(f.translator)}` : ''].filter(Boolean).join('. ')
  if (editorTranslator) sentences.push(editorTranslator)
  const venue = f.journal || f.booktitle
  const venueBits = [venue ? escape(venue) : '', f.volume ? (f.number ? `${escape(f.volume)}(${escape(f.number)})` : escape(f.volume)) : '', f.pages ? `pp. ${escape(f.pages)}` : ''].filter(Boolean)
  if (venueBits.length > 0) sentences.push(venueBits.join(', '))
  else if (f.publisher) sentences.push(escape(f.publisher))
  sentences.push(...trailingCitationFields(f, escape, opts))
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
 * anywhere in the text, or the text contains *exactly one* number (or
 * one `N-N` range) and that matches the source's own publication year
 * (`(Smith, 2020)`, where "2020" is the year the citation label itself
 * always included, not a page). That exclusion only fires when it's the
 * *only* match in the text — a citation that mentions the year *and* a
 * real page ("Smith, 2020, p. 2020" — contrived, but possible) still
 * gets that page, since there's then no ambiguity about which number is
 * which.
 *
 * The range half of that exclusion exists for a real, reported bug: a
 * source whose year field used to itself be entered as a range (or a
 * repeated "2020-2020") rather than a plain number. Fixing the source's
 * year to a plain number afterward doesn't touch any citation already
 * baked from the old range-shaped one — so this had to recognize "the
 * *old* range this legacy label's year-slot actually held" is now this
 * source's current year, not guess that a dash-joined pair of digits
 * must always mean a page range. The check is "does either half of the
 * range match the current year," not "does the whole range," since a
 * genuine year *range* (e.g. "2020-2021" for a report spanning two
 * years) now fixed down to just one of those two years should also be
 * recognized as the year slot, not misread as a page range.
 */
export function extractLegacyCitationNote(text: string, year: string | undefined): string {
  const matches = Array.from(text.matchAll(/\d+\s*-\s*\d+|\d+/g)).map((m) => m[0])
  if (matches.length === 0) return ''
  const last = matches[matches.length - 1]
  const range = last.match(/^(\d+)\s*-\s*(\d+)$/)
  if (matches.length === 1 && year !== undefined) {
    if (!range && last === year) return ''
    if (range && (range[1] === year || range[2] === year)) return ''
  }
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
  return citationLabel(entry, note)
}

/**
 * The literal text (", " for `'author-date'`, the only style that exists
 * today) joining `citationLabelOpen`'s own output to a freeform note, when
 * there is one — `citationHtml` needs this on its own, split out from
 * `citationLabel` above, since the note has to be its own real text node
 * in the DOM (see that function's own doc comment on why) rather than
 * baked into one flat label string. A future second style would need its
 * own separator here too.
 */
export function citationNoteSeparator(_style: CitationStyle = 'author-date'): string {
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
 * The rendered content is split into three pieces, not one flat label
 * string, so the note reads *inside* the parens ("(Smith, 2020, p. 12)")
 * while still being independently editable: `citationLabelOpen`'s own
 * output (the opening paren plus author/year, no closing paren) sits in a
 * `.citation-base` span marked `contenteditable="false"`, the note (plus
 * its separator, when there is one) follows as plain text, a normal
 * sibling inside the chip, and a fixed closing paren closes it out in its
 * own `.citation-close` span, also `contenteditable="false"`.
 * `SectionBlock.tsx`'s `syncCitationNotes` reads that middle text back out
 * on every keystroke (everything between the base and close spans) and
 * keeps `data-note` in sync with it — so a citation is editable exactly
 * where it has a real freeform field to edit (the note) and nowhere else:
 * both the base and close spans are unfocusable/unenterable the same way
 * any other `contenteditable="false"` marker in this editor is (a
 * subsection embed, a footnote ref), so arrow-key navigation and typing
 * both skip over them rather than editing the generated author/date text
 * or the closing paren in place.
 *
 * `data-cite-v="2"` marks a chip as using this structured shape.
 * `essaysRepo.ts`'s own `syncCitations` upgrades any `.citation` element
 * *without* it — one from before this existed, where the label was the
 * only thing ever stored, freeform and hand-editable — into this same
 * shape (or, failing that, flattens it to plain text): anything
 * downstream (export, a future style change, `syncCitationNotes` above)
 * that expects structured data now expects it from every `.citation`
 * element it sees, which only holds if there's no silent, unstructured
 * leftover from before passing itself off as one. That same function
 * also keeps an already-structured chip's own label re-derived from its
 * source's current bibtex on every load, so a later fix to the source
 * (a corrected year, a typo) actually reaches citations that already
 * point to it, rather than leaving them citing whatever was true the
 * moment they were inserted.
 *
 * `opts.note` is used directly when given; `opts.page` is the older,
 * still-supported shorthand for a caller that has a raw PDF page rather
 * than already-formatted note text (quote insertion, mainly), converted
 * via `pageNote`. Passing both prefers `note`.
 *
 * A note-less chip still gets one real, invisible zero-width-space
 * character (`​`) between the base and close spans, rather than
 * nothing — the same caret-landing-placeholder trick `insertFootnote` in
 * EssayWorkspace.tsx uses for its own otherwise-empty marker (see that
 * function's own doc comment for the fuller browser-behavior story),
 * applied here for the opposite reason: that one keeps a blank click
 * from landing *inside* an empty marker, this one keeps it from landing
 * *outside* the editable gap between two adjacent non-editable spans.
 * Confirmed live: with truly nothing between `.citation-base` and
 * `.citation-close` (both `contenteditable="false"`), clicking between
 * them and typing placed the new text as a sibling of the whole
 * `<cite>`/`<a>` in the surrounding paragraph instead of inside it, so a
 * citation with no note yet had no way to gain one by typing — only ever
 * extending an *existing* note worked. `syncCitationNotes` strips any
 * zero-width space out of what it reads back as the note, and the export
 * helpers that escape plain text (`mdEscapeText`/`texEscape`) strip it
 * from exported output too, so it never surfaces as a stray invisible
 * character anywhere downstream.
 */
export function citationHtml(source: Source, opts: { page?: number; note?: string } = {}): string {
  const note = opts.note?.trim() || pageNote(source, opts.page)
  const base = escapeHtml(citationLabelOpen(source.bibtex))
  const middle = note ? escapeHtml(citationNoteSeparator() + note) : '​'
  const noteAttr = note ? ` data-note="${escapeAttr(note)}"` : ''
  const inner = `<span class="citation-base" contenteditable="false">${base}</span>${middle}<span class="citation-close" contenteditable="false">)</span>`
  // Double-click to edit the page/note is `EssayWorkspace`'s own
  // `handleCitationDblClick` — this tooltip is the only hint of it in the
  // UI, since the click target otherwise has nothing to show for itself
  // (a lone zero-width space) until there's already a note to click on.
  const titleAttr = ' title="Double-click to edit page/note"'
  const url = source.bibtex.fields.url
  if (url) {
    return `<a class="citation" data-source-id="${source.id}" data-cite-v="2"${noteAttr}${titleAttr} href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
  }
  return `<cite class="citation" data-source-id="${source.id}" data-cite-v="2"${noteAttr}${titleAttr}>${inner}</cite>`
}
