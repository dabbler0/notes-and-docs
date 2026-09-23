/**
 * Turns a zipped LaTeX project into the same section-tree shape the editor
 * already works with — the mirror image of `export.ts`'s `essayToLatex()`,
 * but necessarily far less exact: real LaTeX is a full macro language, and
 * this only ever has to make sense of what a typical single-author paper's
 * `.tex` file actually contains (structure, basic emphasis, block quotes,
 * citations, footnotes), not the whole language. Anything this doesn't
 * recognize degrades to plain text rather than being silently dropped,
 * with a note added to `warnings` when that happens somewhere worth
 * flagging.
 *
 * Deliberately pure and DB-free (no `backend`/`essaysRepo`/`sourcesRepo`
 * imports here) so it's straightforward to unit test — `sourceByKey` is
 * passed in already resolved (real `Source` objects with real ids) rather
 * than resolved from bibtex keys internally, since minting those ids is
 * the one part of this that has to touch the database; see
 * `models/latexImportRepo.ts` for the impure orchestration (unzip, create
 * sources, call this, persist the result) built on top of this module.
 */
import { citationHtml } from './bibtex'
import { markerHtml } from './childMarkers'
import { escapeHtml } from './html'
import { id } from './id'
import type { Footnote, Source } from '../models/types'

export interface ParsedLatexNode {
  id: string
  title: string
  /** draftContent-shaped HTML — already includes `markerHtml(child.id)` for each of `children`, in position. */
  html: string
  footnotes: Footnote[]
  children: ParsedLatexNode[]
}

export interface LatexParseResult {
  title: string
  root: ParsedLatexNode
  stats: { footnotesConverted: number; footnotesKept: number }
  warnings: string[]
}

export interface ProjectFile {
  path: string
  content: string
}

// ---- Picking the right files out of the zip ----------------------------

/**
 * Prefers whichever `.tex` file actually opens a document — a project
 * commonly has other `.tex` files included via `\input`/`\include` that
 * don't stand alone — then the shallowest path, then a conventional name,
 * then sheer size, in that order, each only breaking ties left by the one
 * before it.
 */
export function pickMainTexFile(files: ProjectFile[]): ProjectFile | null {
  const texFiles = files.filter((f) => /\.tex$/i.test(f.path))
  if (texFiles.length === 0) return null
  const withDoc = texFiles.filter((f) => /\\begin\{document\}/.test(f.content))
  const pool = withDoc.length > 0 ? withDoc : texFiles
  const depth = (p: string) => p.split('/').length
  const conventional = /(^|\/)(main|paper|article|manuscript)\.tex$/i
  const score = (f: ProjectFile): [number, number, number] => [depth(f.path), conventional.test(f.path) ? 0 : 1, -f.content.length]
  return pool.slice().sort((a, b) => {
    const [da, ca, sa] = score(a)
    const [db, cb, sb] = score(b)
    return da - db || ca - cb || sa - sb
  })[0]
}

export function extractBibSource(files: ProjectFile[]): string {
  return files
    .filter((f) => /\.bib$/i.test(f.path))
    .map((f) => f.content)
    .join('\n\n')
}

// ---- Brace/argument scanning --------------------------------------------

/** Index of the `}` matching the `{` at `openIndex`, skipping escaped braces (`\{`, `\}`); -1 if unbalanced. */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      i++ // skip whatever's escaped, including a literal \{ or \}
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Reads a `{...}` argument starting at/after `fromIndex`, skipping whitespace and one optional `[...]` argument first (e.g. `\section[short]{Long title}`). Returns null if there's no brace argument to find. */
function readBraceArg(text: string, fromIndex: number): { arg: string; end: number } | null {
  let i = fromIndex
  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  skipWs()
  if (text[i] === '[') {
    const close = text.indexOf(']', i)
    if (close !== -1) i = close + 1
  }
  skipWs()
  if (text[i] !== '{') return null
  const end = findMatchingBrace(text, i)
  if (end === -1) return null
  return { arg: text.slice(i + 1, end), end: end + 1 }
}

/** Finds `\begin{name}...\end{name}` (first occurrence, not nesting the same name) and returns its inner content plus the index just past `\end{name}`. */
function findEnvironment(text: string, name: string, from = 0): { inner: string; start: number; end: number } | null {
  const beginTag = `\\begin{${name}}`
  const endTag = `\\end{${name}}`
  const start = text.indexOf(beginTag, from)
  if (start === -1) return null
  const contentStart = start + beginTag.length
  const end = text.indexOf(endTag, contentStart)
  if (end === -1) return null
  return { inner: text.slice(contentStart, end), start, end: end + endTag.length }
}

// ---- Footnote -> citation heuristic --------------------------------------

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'for', 'to', 'is', 'are', 'this', 'that'])

function authorLastNames(author: string): string[] {
  return author
    .split(/ and /i)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => (a.includes(',') ? a.split(',')[0] : a.split(/\s+/).pop() || a))
    .map((n) => n.trim())
    .filter(Boolean)
}

function titleKeywords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, 6)
}

/** A page reference in any of the forms a manually-typed citation actually uses: "p. 45", "p45", "pp. 12-15", "pp 12–15". Used both to strip a trailing page reference off a shorthand citation and as a (weak, on its own) signal in the free-text scorer below. */
const PAGE_RE = /,?\s+pp?\.?\s*(\d+(?:\s*[-–—]\s*\d+)?)\.?$/i

interface ShorthandCitation {
  /** "Smith" or "John Smith" — never validated against real names beyond its *shape*; resolveShorthandCitation is what actually keeps this safe (a name-shaped footnote that doesn't resolve to a real, sufficiently unique author is simply not a match). */
  name: string
  title?: string
  page?: string
}

/**
 * Recognizes a footnote that's really nothing but a compact, manually-typed
 * citation — "Smith, p. 45", "John Smith, The Long Title, pp. 12–15",
 * "Smith, “A Title,” p. 9" — rather than an ordinary sentence. Anchored to
 * the *whole* trimmed footnote text, not just a prefix: that's what "no
 * extraneous text" actually means in practice — a real sentence that
 * happens to mention someone's name simply won't match this shape at all,
 * and falls through to the looser free-text scoring in
 * matchFootnoteToSource instead, which still requires a year or a title
 * overlap on top of the name.
 */
function parseShorthandCitation(text: string): ShorthandCitation | null {
  let rest = text.trim()
  let page: string | undefined
  const pageMatch = PAGE_RE.exec(rest)
  if (pageMatch) {
    rest = rest.slice(0, pageMatch.index).trim()
    page = pageMatch[1].replace(/\s+/g, '').replace(/[–—]/g, '-')
  }
  rest = rest.replace(/\.$/, '').trim()
  if (!rest) return null
  const commaIdx = rest.indexOf(',')
  const namePart = (commaIdx === -1 ? rest : rest.slice(0, commaIdx)).trim()
  const titlePart = commaIdx === -1 ? undefined : rest.slice(commaIdx + 1).trim().replace(/^[“"'‘]+|[”"'’]+$/g, '').trim()
  if (!isNameLike(namePart)) return null
  return { name: namePart, title: titlePart || undefined, page }
}

/** "Smith", "John Smith", "J. Smith" — one to three capitalized tokens and nothing else. Deliberately strict: this (plus resolveShorthandCitation actually finding a matching author afterward) is what keeps an ordinary sentence from being mistaken for a bare citation. */
function isNameLike(s: string): boolean {
  return /^[A-Z][A-Za-z'’.-]*(\s+[A-Z][A-Za-z'’.-]*){0,2}$/.test(s)
}

/**
 * Resolves a parsed shorthand citation against the known sources — by last
 * name first (optionally narrowed by a given first name), then, if that's
 * still ambiguous, by title-keyword overlap. Returns null rather than
 * guessing whenever more than one source remains plausible: per the
 * feature's own design, "just an author" is only ever accepted when it
 * points at a *unique* entry, and "author + title" only when the title
 * actually discriminates between same-surname authors.
 */
function resolveShorthandCitation(shorthand: ShorthandCitation, sourceByKey: Map<string, Source>): Source | null {
  const nameTokens = shorthand.name.split(/\s+/)
  const lastName = nameTokens[nameTokens.length - 1].toLowerCase()
  const firstName = nameTokens.length > 1 ? nameTokens[0].toLowerCase() : null

  let candidates = [...sourceByKey.values()].filter((source) => {
    const authors = source.bibtex.fields.author
    return !!authors && authorLastNames(authors).some((ln) => ln.toLowerCase() === lastName)
  })
  if (candidates.length === 0) return null

  if (firstName && candidates.length > 1) {
    const narrowed = candidates.filter((source) => source.bibtex.fields.author!.toLowerCase().includes(firstName))
    if (narrowed.length > 0) candidates = narrowed
  }

  if (candidates.length === 1) return candidates[0]

  if (shorthand.title) {
    const keywords = titleKeywords(shorthand.title)
    const scored = candidates
      .map((source) => ({ source, hits: keywords.filter((w) => (source.bibtex.fields.title ?? '').toLowerCase().includes(w)).length }))
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits)
    if (scored.length === 1 || (scored.length > 1 && scored[0].hits > scored[1].hits)) return scored[0].source
  }

  return null // still ambiguous — several same-surname sources, nothing left to tell them apart with
}

/**
 * Scores every known source against a footnote's plain text and returns the
 * best match, if any clears the bar. Tries the strict "this footnote is
 * basically just a citation" shape first (see parseShorthandCitation) —
 * that's the only path a bare author name, or author + title with no year,
 * can ever succeed through, and only when it resolves unambiguously.
 * Anything else falls through to free-text scoring, which still requires
 * a year and/or a title overlap on top of the author match: a generic
 * explanatory aside essentially never combines those, so requiring one of
 * them (plus enough total signal) keeps this from firing on a footnote
 * that just happens to share a word with someone's paper title.
 */
export function matchFootnoteToSource(plainText: string, sourceByKey: Map<string, Source>): Source | null {
  const shorthand = parseShorthandCitation(plainText)
  if (shorthand) {
    const resolved = resolveShorthandCitation(shorthand, sourceByKey)
    if (resolved) return resolved
  }

  const lower = plainText.toLowerCase()
  const hasPageRef = /\bpp?\.?\s*\d+(?:\s*[-–—]\s*\d+)?\b/i.test(plainText)
  // Collect every source that clears the bar, not just the first/highest —
  // two sources sharing a surname (or, coincidentally, a mentioned year)
  // can each reach the same score, and picking whichever happened to be
  // first in iteration order would be exactly the kind of unjustified
  // guess this function otherwise goes out of its way to avoid (see
  // resolveShorthandCitation's own identical reasoning above). Only a
  // *unique* top score is ever returned.
  const qualifying: { source: Source; score: number }[] = []
  for (const source of sourceByKey.values()) {
    const fields = source.bibtex.fields
    let score = 0
    let hasStrongSignal = false
    if (fields.year && new RegExp(`\\b${fields.year}\\b`).test(plainText)) {
      score += 2
      hasStrongSignal = true
    }
    if (fields.author) {
      for (const last of authorLastNames(fields.author)) {
        if (last.length > 1 && new RegExp(`\\b${escapeRegExp(last.toLowerCase())}\\b`).test(lower)) {
          score += 2
          hasStrongSignal = true
          break
        }
      }
    }
    if (fields.title) {
      const hits = titleKeywords(fields.title).filter((w) => lower.includes(w)).length
      score += hits
    }
    if (hasStrongSignal && hasPageRef) score += 1
    if (hasStrongSignal && score >= 3) qualifying.push({ source, score })
  }
  if (qualifying.length === 0) return null
  qualifying.sort((a, b) => b.score - a.score)
  if (qualifying.length > 1 && qualifying[0].score === qualifying[1].score) return null
  return qualifying[0].source
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---- LaTeX inline/body -> HTML -------------------------------------------

interface ConvertCtx {
  sourceByKey: Map<string, Source>
  footnotes: Footnote[]
  stats: { footnotesConverted: number; footnotesKept: number }
  warnings: string[]
}

const CITE_COMMANDS = new Set(['cite', 'citep', 'citet', 'parencite', 'textcite', 'footcite', 'autocite'])

/** A handful of common escaped-character/typographic sequences LaTeX authors actually type; not remotely a full LaTeX macro set, just enough that ordinary prose round-trips as ordinary prose instead of literal backslashes. */
function unescapeLiteral(s: string): string {
  return s
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\\$/g, '$')
    .replace(/\\#/g, '#')
    .replace(/\\_/g, '_')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/~/g, ' ')
}

/**
 * Converts one run of LaTeX body text (already comment-stripped, no
 * surrounding `\section{}`/environment markers) into inline HTML — walking
 * left to right, copying ordinary text through `unescapeLiteral` +
 * `escapeHtml`, and handling recognized commands as it finds them.
 * Recursive on each command's own argument, so e.g. `\textbf{\emph{x}}`
 * nests correctly.
 */
function convertInline(text: string, ctx: ConvertCtx): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      // \\  (LaTeX's own line break) vs. \command
      if (text[i + 1] === '\\') {
        out += '<br>'
        i += 2
        continue
      }
      const cmdMatch = /^[A-Za-z]+/.exec(text.slice(i + 1))
      if (!cmdMatch) {
        // A backslash escaping a single punctuation character (\&, \%, ...)
        // — handled in bulk by unescapeLiteral on the two-character slice.
        out += escapeHtml(unescapeLiteral(text.slice(i, i + 2)))
        i += 2
        continue
      }
      const cmd = cmdMatch[0]
      const afterCmd = i + 1 + cmd.length
      if (cmd === 'label') {
        const arg = readBraceArg(text, afterCmd)
        i = arg ? arg.end : afterCmd
        continue
      }
      if (cmd === 'ref' || cmd === 'autoref' || cmd === 'eqref' || cmd === 'pageref') {
        const arg = readBraceArg(text, afterCmd)
        out += arg ? `[${escapeHtml(arg.arg.trim())}]` : ''
        i = arg ? arg.end : afterCmd
        continue
      }
      if (cmd === 'footnote') {
        const arg = readBraceArg(text, afterCmd)
        if (!arg) {
          i = afterCmd
          continue
        }
        const innerHtml = convertInline(arg.arg, ctx)
        const plain = stripHtml(innerHtml)
        const matched = matchFootnoteToSource(plain, ctx.sourceByKey)
        if (matched) {
          out += `${citationHtml(matched)}&nbsp;`
          ctx.stats.footnotesConverted++
        } else {
          const fid = id()
          ctx.footnotes.push({ id: fid, content: `<p>${innerHtml}</p>` })
          // The trailing zero-width space is load-bearing, not decorative
          // — see `insertFootnote`'s own doc comment in
          // `EssayWorkspace.tsx` for why a genuinely empty marker breaks
          // caret placement right after it, and why the zero-width space
          // has to sit *outside* the `<sup>` rather than inside it.
          out += `<sup class="footnote-ref" data-footnote-id="${fid}"></sup>​`
          ctx.stats.footnotesKept++
        }
        i = arg.end
        continue
      }
      if (CITE_COMMANDS.has(cmd)) {
        const arg = readBraceArg(text, afterCmd)
        if (!arg) {
          i = afterCmd
          continue
        }
        const keys = arg.arg.split(',').map((k) => k.trim()).filter(Boolean)
        const chips: string[] = []
        for (const key of keys) {
          const source = ctx.sourceByKey.get(key)
          if (source) {
            chips.push(citationHtml(source))
          } else {
            chips.push(escapeHtml(`[${key}]`))
            ctx.warnings.push(`Citation key "${key}" (from \\${cmd}) wasn't found in any attached .bib file.`)
          }
        }
        out += chips.join(' ') + '&nbsp;'
        i = arg.end
        continue
      }
      const WRAP: Record<string, string> = { textbf: 'b', bf: 'b', textit: 'i', it: 'i', emph: 'i', underline: 'u', texttt: 'code' }
      if (cmd in WRAP) {
        const arg = readBraceArg(text, afterCmd)
        if (!arg) {
          i = afterCmd
          continue
        }
        const tag = WRAP[cmd]
        out += `<${tag}>${convertInline(arg.arg, ctx)}</${tag}>`
        i = arg.end
        continue
      }
      // Unknown command: best-effort degrade. One with a brace argument
      // just inlines that argument's own (converted) content — losing the
      // command's specific effect but keeping the text it wrapped; one
      // with no brace argument (\noindent, \clearpage, \par, ...) is
      // dropped silently, since there's nothing textual to preserve.
      const arg = readBraceArg(text, afterCmd)
      if (arg) {
        out += convertInline(arg.arg, ctx)
        i = arg.end
      } else {
        i = afterCmd
      }
      continue
    }
    if (c === '{' || c === '}') {
      // A bare grouping brace with no command in front of it — just scope,
      // no visible effect.
      i++
      continue
    }
    // Ordinary text: copy through to the next backslash/brace one character
    // (well, one Unicode-safe run) at a time is wasteful; grab the whole
    // run instead.
    let j = i
    while (j < text.length && text[j] !== '\\' && text[j] !== '{' && text[j] !== '}') j++
    out += escapeHtml(unescapeLiteral(text.slice(i, j)))
    i = j
  }
  return out
}

function stripHtml(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || ''
}

/** Splits on blank lines into `<p>` blocks, pulling out `quote` environments as their own `<blockquote>` blocks first (so a blank line *inside* one doesn't fragment it). */
function convertBody(bodyText: string, ctx: ConvertCtx): string {
  const blocks: string[] = []
  let rest = bodyText
  for (;;) {
    const env = findEnvironment(rest, 'quote')
    if (!env) break
    const before = rest.slice(0, env.start)
    for (const p of splitParagraphs(before)) blocks.push(`<p>${convertInline(p, ctx)}</p>`)
    blocks.push(`<blockquote class="quote">${convertInline(env.inner.trim(), ctx)}</blockquote>`)
    rest = rest.slice(env.end)
  }
  for (const p of splitParagraphs(rest)) blocks.push(`<p>${convertInline(p, ctx)}</p>`)
  return blocks.join('')
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
}

// ---- Section tree --------------------------------------------------------

const SECTION_LEVELS: Record<string, number> = { section: 1, subsection: 2, subsubsection: 3 }
const SECTION_CMD_RE = /\\(section|subsection|subsubsection)\*?\s*/g

interface SectionMarker {
  level: number
  titleRaw: string
  /** Index of the `\` that starts the section command itself — this marker's own body text ends wherever the *next* marker's `start` is (or end of document, for the last one). */
  start: number
  /** Index just past the title's closing `}` — this marker's own body text begins here. */
  contentStart: number
}

function findSectionMarkers(body: string): SectionMarker[] {
  const markers: SectionMarker[] = []
  SECTION_CMD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SECTION_CMD_RE.exec(body))) {
    const arg = readBraceArg(body, m.index + m[0].length)
    if (!arg) continue
    markers.push({ level: SECTION_LEVELS[m[1]], titleRaw: arg.arg, start: m.index, contentStart: arg.end })
    SECTION_CMD_RE.lastIndex = arg.end
  }
  return markers
}

function makeNode(titleHtml: string, ctx: ConvertCtx, bodyText: string): ParsedLatexNode {
  const footnotes: Footnote[] = []
  const nodeCtx: ConvertCtx = { ...ctx, footnotes }
  const html = convertBody(bodyText, nodeCtx)
  return { id: id(), title: stripHtml(titleHtml).trim() || 'Untitled section', html, footnotes, children: [] }
}

export function parseLatexDocument(texSource: string, sourceByKey: Map<string, Source>, fallbackTitle: string): LatexParseResult {
  const warnings: string[] = []
  const stats = { footnotesConverted: 0, footnotesKept: 0 }
  const sharedCtx: ConvertCtx = { sourceByKey, footnotes: [], stats, warnings }

  // Comments: an unescaped % through end of line.
  const noComments = texSource.replace(/(^|[^\\])%.*$/gm, '$1')

  let title = fallbackTitle
  const titleCmd = /\\title\s*[{[]/.exec(noComments)
  if (titleCmd) {
    const cmdEnd = titleCmd.index + '\\title'.length
    const arg = readBraceArg(noComments, cmdEnd)
    if (arg) {
      const plain = stripHtml(convertInline(arg.arg, sharedCtx)).trim()
      if (plain) title = plain
    }
  }

  const docEnv = findEnvironment(noComments, 'document')
  let body = docEnv ? docEnv.inner : noComments

  // Abstract becomes its own leading child section, pulled out of the body
  // before section-scanning so it isn't also counted as the root's own text.
  let abstractNode: ParsedLatexNode | null = null
  const abstractEnv = findEnvironment(body, 'abstract')
  if (abstractEnv) {
    abstractNode = makeNode('Abstract', sharedCtx, abstractEnv.inner)
    body = body.slice(0, abstractEnv.start) + body.slice(abstractEnv.end)
  }

  body = body.replace(/\\maketitle/g, '').replace(/\\tableofcontents/g, '')

  const markers = findSectionMarkers(body)
  const rootStart = markers.length > 0 ? markers[0].start : body.length
  const root = makeNode(title, sharedCtx, body.slice(0, rootStart))
  if (abstractNode) root.children.push(abstractNode)

  // Stitch the flat marker list into a tree by level, same idea as
  // EssayWorkspace's own split-then-renumber flow: a stack of "current
  // ancestor at each depth," popped back to the right length whenever a
  // marker's level is shallower than or equal to what's currently open.
  // Each marker's own body text runs from its title to wherever the next
  // marker (at any level) starts, or to the end of the document.
  const stack: ParsedLatexNode[] = [root]
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]
    const contentEnd = i + 1 < markers.length ? markers[i + 1].start : body.length
    const bodyText = body.slice(marker.contentStart, contentEnd)
    const titleHtml = convertInline(marker.titleRaw, sharedCtx)
    const node = makeNode(titleHtml, sharedCtx, bodyText)
    while (stack.length > marker.level) stack.pop()
    // A level skip (e.g. a \subsubsection with no enclosing \subsection)
    // just nests it under the nearest real ancestor instead — duplicating
    // the top of the stack rather than fabricating a placeholder section —
    // and self-corrects the next time a normal-depth marker pops it back.
    while (stack.length < marker.level) stack.push(stack[stack.length - 1])
    stack[stack.length - 1].children.push(node)
    stack.push(node)
  }

  // Embed each node's own children as markers in its html, in the order
  // they were parsed — mirroring how the live editor's own
  // reconstructContent() builds a node's content string.
  function embedMarkers(node: ParsedLatexNode) {
    for (const child of node.children) embedMarkers(child)
    if (node.children.length > 0) {
      node.html += node.children.map((c) => markerHtml(c.id)).join('')
    }
  }
  embedMarkers(root)

  return { title, root, stats, warnings }
}
