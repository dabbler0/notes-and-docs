/**
 * Best-effort parser for a single pasted, already-formatted citation — the
 * kind almost every website's own "Cite this" button hands you (APA, MLA,
 * Chicago, IEEE, Harvard, and close variants), as opposed to actual BibTeX
 * (`parseBibtex` already handles that). There is no single grammar here —
 * every style orders author/year/title/venue differently and punctuates
 * them differently — so this doesn't attempt a real parse so much as a
 * sequence of increasingly-generic heuristics: pull out the pieces that are
 * unambiguous regardless of style (a DOI, a URL, a year, a quoted title),
 * then use *where* those landed in the string to guess where the author
 * list ends and the venue begins. Every extracted field is a guess, some
 * more confident than others — this is explicitly a starting point for the
 * user to correct in "Add a source"'s own fields afterward, not a
 * guarantee of a correct parse for every citation style in existence.
 *
 * Deliberately conservative about author-name reformatting: it splits a
 * multi-author list into individual names, but never tries to reorder a
 * bare "First Last" into "Last, First" — guessing a surname for an
 * arbitrary name is exactly the kind of guess that can turn a
 * mostly-right parse into a confidently-wrong one, and leaving it in
 * whatever order the citation already used degrades far more gracefully
 * (`citationLabel` still finds *something* to show, just not always the
 * bare surname).
 */
import type { BibtexEntry } from '../models/types'
import { emptyEntry } from './bibtex'

export interface ParsedCitationFields {
  title?: string
  author?: string
  year?: string
  url?: string
  doi?: string
  journal?: string
  note?: string
}

const DOI_RE = /\bdoi\s*:?\s*(10\.\d{4,9}\/\S+)|https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/\S+)/i
const URL_RE = /https?:\/\/[^\s)>\]]+/i
// Prefer a year in parens (APA/Harvard: "Smith, J. (2020)."), but fall back
// to a bare one (Chicago author-date, MLA "2020,", Vancouver-ish "2020;")
// — never one immediately adjacent to another digit (a page number, a
// volume like "2020-45", an ISBN fragment), which a bare 4-digit scan would
// otherwise happily mistake for a year.
const YEAR_PAREN_RE = /\((\d{4})[a-z]?\)/
const YEAR_BARE_RE = /(?<![\d-])(1[5-9]\d{2}|20\d{2})[a-z]?(?![\d-])/
const DOUBLE_QUOTE_RE = /[“"]([^”"]{3,300})[”"]/
// Harvard style quotes a title in single quotes ('Title of article') —
// tried only as a fallback when there's no double-quoted title, since a
// bare `'...'` is far more likely to misfire on an apostrophe somewhere
// in ordinary text (a possessive, a contraction) than a double quote is.
const SINGLE_QUOTE_RE = /'([^']{3,300})'/
const VOLUME_ISSUE_PAREN_RE = /\b(\d{1,4})\s*\((\d{1,4}[a-zA-Z]?)\)/ // APA/Harvard: "12(3)"
const VOLUME_WORD_RE = /\bvol\.?\s*(\d{1,4})\b/i
const ISSUE_WORD_RE = /\bno\.?\s*(\d{1,4})\b/i
const PAGES_RE = /\bpp?\.?\s*(\d{1,5}\s*[-–—]\s*\d{1,5})\b|[:,]\s*(\d{1,5}\s*[-–—]\s*\d{1,5})\s*\.?\s*$/i

function clean(s: string | undefined): string | undefined {
  if (!s) return undefined
  let t = s
    .replace(/\s+/g, ' ')
    // Collapses a run of separator punctuation left behind wherever a
    // matched field (a year, a volume, ...) was cut out from between two
    // others — e.g. "Examples, , , 2020" once "2020" itself is gone next
    // becomes "Examples, , ," here, not "Examples, , , " with a stray
    // double comma surviving because it wasn't at either end of the string.
    .replace(/[,;]\s*(?:[,;]\s*)+/g, ', ')
    .trim()
    .replace(/^[,;:\s]+/, '')
    .trim()
  // A trailing period is ordinary sentence punctuation to strip — *unless*
  // it's the period on a trailing initial ("Smith, J. A." should keep its
  // final "."; "Publisher Name." shouldn't). `\b[A-Z]\.$` — a single
  // capital letter immediately before the trailing period, at a word
  // boundary — is what tells the two apart. Done *before* the trailing
  // separator strip below, not after: a period stranded behind a comma
  // this function already cut out from the middle (e.g. once a trailing
  // year is removed, "Examples, , 2020, ." becomes "Examples, ." here) has
  // to come off first so the comma it was hiding behind is exposed for
  // that second pass to actually reach.
  if (!/\b[A-Z]\.$/.test(t)) t = t.replace(/\.+\s*$/, '')
  t = t.replace(/[,;:\s]+$/, '')
  return t.trim() || undefined
}

/** Splits an extracted author-list substring into individual names, joined
 * back with BibTeX's own " and " separator — see this module's doc
 * comment for what this deliberately does and doesn't try to fix. */
function splitAuthorList(raw: string): string | undefined {
  let s = raw.trim()
  if (!s) return undefined
  const sawEtAl = /,?\s*et\s+al\.?$/i.test(s)
  s = s.replace(/,?\s*et\s+al\.?$/i, '').trim()
  s = s.replace(/\s*&\s*/g, ' and ')
  const roughParts = s
    .split(/\s*,?\s+and\s+/i)
    .map((p) => p.trim())
    .filter(Boolean)

  const names: string[] = []
  for (const part of roughParts) {
    const commaIdx = part.indexOf(',')
    if (commaIdx === -1) {
      names.push(part)
      continue
    }
    const before = part.slice(0, commaIdx).trim()
    const after = part.slice(commaIdx + 1)
    if (/\./.test(before)) {
      // "A. Smith, B. Doe" — the bit before the comma already looks like a
      // complete "Initial. Last" name (a period — an initial — inside
      // it), so every comma here is separating two different people, not
      // introducing a first name for one.
      names.push(...part.split(',').map((t) => t.trim()).filter(Boolean))
      continue
    }
    // Plain "Smith, John" (no period before the comma) is a single
    // "Last, First" name — *but* a style that only writes its first
    // author that way and every later one as plain "First Last" (MLA's
    // own convention for 3+ authors: "Smith, John, Jane Doe, and Alex
    // Lee") means anything past that first comma is already its own
    // separate, complete name rather than more of the first author's —
    // so only the segment right after the first comma is paired with
    // `before`; every comma-separated segment beyond that is its own name.
    const afterParts = after.split(',').map((t) => t.trim()).filter(Boolean)
    if (afterParts.length === 0) {
      names.push(part)
      continue
    }
    names.push(`${before}, ${afterParts[0]}`)
    for (let i = 1; i < afterParts.length; i++) names.push(afterParts[i])
  }
  if (sawEtAl) names.push('others')
  const cleaned = names.map((n) => clean(n)).filter((n): n is string => !!n)
  return cleaned.length > 0 ? cleaned.join(' and ') : undefined
}

/** Pulls whatever looks like a journal/publisher name, volume, issue, and
 * page range out of the venue text left over once authors/year/title/doi/
 * url have all already been accounted for. Returns the journal name
 * separately (folded into `fields.journal`) from volume/issue/pages, which
 * — since `BibtexEntry` has no dedicated slot the "Add a source" manual
 * fields surface — just get appended onto the journal string the way a
 * formatted citation would already read (e.g. "Journal Name, 12(3),
 * 45-67"), so nothing extracted is silently dropped even though it isn't
 * split into its own field. */
function parseVenue(raw: string): string | undefined {
  // The year was already captured separately (`fields.year`, extracted
  // from the whole citation up front) — stripped again here too, so it
  // doesn't linger as stray leftover text in the journal string (a year
  // sitting right next to the volume/issue/pages, as in MLA's "vol. 12,
  // no. 3, 2020, pp. 45-67", is otherwise textual content `clean()`'s own
  // edge-trimming can't remove, unlike the punctuation around it).
  let s = raw.replace(YEAR_PAREN_RE, ' ').replace(YEAR_BARE_RE, ' ')

  const pagesMatch = s.match(PAGES_RE)
  let pages: string | undefined
  if (pagesMatch) {
    pages = (pagesMatch[1] ?? pagesMatch[2])?.replace(/\s*[-–—]\s*/, '–')
    s = s.slice(0, pagesMatch.index) + s.slice(pagesMatch.index! + pagesMatch[0].length)
  }

  let volume: string | undefined
  let issue: string | undefined
  const volIssueParen = s.match(VOLUME_ISSUE_PAREN_RE)
  if (volIssueParen) {
    volume = volIssueParen[1]
    issue = volIssueParen[2]
    s = s.slice(0, volIssueParen.index) + s.slice(volIssueParen.index! + volIssueParen[0].length)
  } else {
    const volWord = s.match(VOLUME_WORD_RE)
    if (volWord) {
      volume = volWord[1]
      s = s.slice(0, volWord.index) + s.slice(volWord.index! + volWord[0].length)
    }
    const issueWord = s.match(ISSUE_WORD_RE)
    if (issueWord) {
      issue = issueWord[1]
      s = s.slice(0, issueWord.index) + s.slice(issueWord.index! + issueWord[0].length)
    }
  }

  const journalName = clean(s.replace(/^\s*in\s*:?\s*/i, ''))
  const parts = [journalName, volume ? (issue ? `${volume}(${issue})` : volume) : undefined, pages].filter(Boolean)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/** Whether the text sitting before the detected author/title boundary
 * actually looks like a list of names, rather than (the one style this
 * whole approach can't really untangle) a title that happens to come
 * *before* the year with no author at all — an anonymous web page, an
 * encyclopedia entry, many of Wikipedia's own "Cite this page" outputs:
 * "Article Title. (2023). In Wikipedia. https://...". A real author list
 * either has an explicit separator (a comma, "and", "&" — anything
 * multi-author) or, for a single name with none of those, is short; a bare
 * multi-word phrase with no separator at all reads more like a sentence
 * (a title) than a name. Not a fix for the author-less case (this module
 * doesn't attempt to notice "the year came before any author at all and
 * shift what follows accordingly") — just a guard against the *worse*
 * outcome of confidently mislabeling that title as the author instead of
 * just leaving the field blank. */
function looksLikeAuthorList(s: string): boolean {
  const trimmed = clean(s)
  if (!trimmed) return false
  if (/,| and | & /i.test(trimmed)) return true
  return trimmed.split(/\s+/).length <= 4
}

/** Parses one pasted, human-formatted citation into best-effort BibTeX-like
 * fields — see this module's own doc comment for the overall approach and
 * its limits. Never returns `null`/empty-handed for non-blank input: even
 * a citation none of the heuristics below recognize at all still comes
 * back with the whole (URL/DOI-stripped) text as the title, so pasting
 * *something* always produces *something* to start correcting from. */
export function parseCitationFields(input: string): ParsedCitationFields {
  let s = input.replace(/\s+/g, ' ').trim().replace(/^\[\d+\]\s*/, '')
  if (!s) return {}

  const fields: ParsedCitationFields = {}

  const doiMatch = s.match(DOI_RE)
  if (doiMatch) {
    fields.doi = clean((doiMatch[1] ?? doiMatch[2])?.replace(/[.,;]+$/, ''))
    s = s.slice(0, doiMatch.index) + s.slice(doiMatch.index! + doiMatch[0].length)
  }

  const urlMatch = s.match(URL_RE)
  if (urlMatch) {
    fields.url = clean(urlMatch[0].replace(/[.,;)\]]+$/, ''))
    s = s.slice(0, urlMatch.index) + s.slice(urlMatch.index! + urlMatch[0].length)
  }

  const yearMatch = s.match(YEAR_PAREN_RE) ?? s.match(YEAR_BARE_RE)
  if (yearMatch) fields.year = yearMatch[1]

  const quoteMatch = s.match(DOUBLE_QUOTE_RE) ?? s.match(SINGLE_QUOTE_RE)

  // Where authors end and title/venue begin: whichever of "a quoted
  // title" or "a parenthesized/bare year" comes first in the string —
  // both mark that boundary, in different styles (MLA quotes the title
  // right after the author; APA puts the year there instead).
  const boundary = [quoteMatch?.index, yearMatch?.index].filter((i): i is number => i !== undefined).sort((a, b) => a - b)[0]

  if (boundary !== undefined && looksLikeAuthorList(s.slice(0, boundary))) {
    fields.author = splitAuthorList(s.slice(0, boundary))
  }

  if (quoteMatch) {
    fields.title = clean(quoteMatch[1])
    const rest = s.slice(quoteMatch.index! + quoteMatch[0].length)
    fields.journal = parseVenue(rest)
  } else if (yearMatch) {
    // Unquoted style (APA/Harvard): the year is immediately followed by
    // the title as its own sentence, then the venue as the sentence(s)
    // after that — "(2020). Title of the piece. Journal Name, 12(3), 45."
    const afterYear = s.slice(yearMatch.index! + yearMatch[0].length).replace(/^[.\s)]+/, '')
    const sentenceEnd = afterYear.search(/\.\s|\.$/)
    if (sentenceEnd === -1) {
      fields.title = clean(afterYear)
    } else {
      fields.title = clean(afterYear.slice(0, sentenceEnd))
      fields.journal = parseVenue(afterYear.slice(sentenceEnd + 1))
    }
  } else {
    // No quoted title and no recognizable year at all — not enough
    // structure to confidently split author from title, so the whole
    // (already doi/url-stripped) remainder becomes the title rather than
    // guessing wrong about where an author list might end. Still strictly
    // better than leaving every field blank.
    fields.title = clean(s)
  }

  return fields
}

/** Same parse, packaged as a throwaway `BibtexEntry` — for a caller (like
 * `AddSourceDialog`, if it ever wants a single BibTeX-shaped result rather
 * than individual fields to fold into its own manual-entry state) that
 * wants the same shape `parseBibtex` produces. */
export function parseCitationToBibtex(input: string): BibtexEntry | null {
  const fields = parseCitationFields(input)
  if (Object.keys(fields).length === 0) return null
  const key = (fields.author?.split(/,| and /)[0]?.trim().split(' ')[0] || 'source').toLowerCase().replace(/[^a-z0-9]/g, '') + (fields.year ?? '')
  const entry = emptyEntry(key)
  if (fields.title) entry.fields.title = fields.title
  if (fields.author) entry.fields.author = fields.author
  if (fields.year) entry.fields.year = fields.year
  if (fields.url) entry.fields.url = fields.url
  if (fields.doi) entry.fields.doi = fields.doi
  if (fields.journal) entry.fields.journal = fields.journal
  if (fields.note) entry.fields.note = fields.note
  return entry
}
