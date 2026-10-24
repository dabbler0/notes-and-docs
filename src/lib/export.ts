/**
 * Turns an essay's node tree into other formats for export: Markdown, a
 * printable HTML rendering of that same Markdown (for "export to PDF" via
 * the browser's own print dialog), and a LaTeX project. All three walk the
 * tree the same way SectionBlock renders it — parseSegments() on each
 * node's own draftContent, recursing into embedded children in document
 * order — so what's exported matches what's on screen, not some separate
 * frozen/versioned snapshot.
 */
import { getChildIds, parseSegments } from './childMarkers'
import { escapeHtml } from './html'
import { citationLabel, citationLabelAuthorTitle, formatBibtex, formatCitation, trailingCitationFields, type TrailingFieldsOptions } from './bibtex'
import { renderMathHtml } from './math'
import { isAbstractTitle } from './treeNumbering'
import { nodeFootnotes } from '../models/essaysRepo'
import type { BibtexEntry, Essay, EssayNode, Source } from '../models/types'

// ---- Markdown --------------------------------------------------------

/**
 * Which inline form a citation takes and what it says — `print/PDF` export
 * only (the plain .md download always keeps a citation's own already-baked
 * label text verbatim, same as before this existed). `'author-year'`/
 * `'author-title'` render right where the citation sits, the same way a
 * citation always has; `'numbered'` instead renders a bracketed index
 * (`[3]`) matching that source's position in the References list — see
 * `citedSources`, the one ordering both share.
 */
export type PrintCitationStyle = 'author-year' | 'author-title' | 'numbered'

/**
 * Where a citation's full information actually appears — right inline
 * (a short label, per `PrintCitationStyle`), or moved out to a footnote
 * (a plain, sequential superscript reference; the footnote body is always
 * a full `formatCitation()` rendering, regardless of `PrintCitationStyle`,
 * which has nothing to shorten *to* once the citation isn't sitting in
 * the middle of a sentence anymore).
 */
export type PrintCitationPlacement = 'inline' | 'footnote'

export interface PrintCitationOptions {
  sources: Map<string, Source>
  style: PrintCitationStyle
  placement: PrintCitationPlacement
  /** This essay's own cited sources, in the exact order the References list renders them — a numbered citation's bracket index is 1 + this array's index of its source, so the two always agree. */
  orderedSourceIds: string[]
  /** Which style a footnote-placed citation's own shortened author/title form follows — see `formatFootnoteCitation` — so a footnote reads consistently with the References entry it points at. Unused for `'inline'` placement, which has its own separate short forms (`citationLabel`/`citationLabelAuthorTitle`). Defaults to `'plain'`, same as `renderBibliographyEntry`'s own default. */
  bibliographyStyle?: BibliographyStyle
}

/** Threaded through a node's own conversion so a `sup.footnote-ref` marker can look up its footnote's content (`node.footnotes`, resolved by the caller) and mint a globally-unique `[^label]` — unique across the *whole* document, not just this node, since Markdown footnote labels are matched document-wide by any real Markdown processor regardless of which section "owns" them; reusing per-node-local numbers as labels would silently conflate two different essay's-worth of footnotes that both happened to be "footnote 1." `defs` collects each one's own `[^label]: content` line, in the order encountered, to append once at the very end. */
interface MarkdownFootnoteCtx {
  footnotesById: Map<string, string>
  defs: string[]
  counter: { next: number }
  /** Only set for the print/PDF export path — see `PrintCitationOptions`'s own doc comment. */
  citationOptions?: PrintCitationOptions
}

/**
 * Wraps a `mdEscapeText`-escaped inline string in a `<cite
 * class="print-citation">` passthrough tag — raw HTML embedded directly
 * in the Markdown stream, the same trick `inlineHtmlToMarkdown`'s own `u`
 * case already uses for underline (Markdown has no native syntax for
 * either). `inlineMarkdownToHtml` recognizes this exact tag and extracts
 * it into a placeholder before anything else can escape its angle
 * brackets or have a regex reach across it, same as that `<u>` case —
 * see its own doc comment. The wrapper exists purely so
 * `ensureCitationSpacing` (below) has a real, locatable DOM element to
 * check surrounding whitespace against for *every* inline-placed
 * citation — it's unwrapped back down to plain text once that pass is
 * done, so it never actually shows up in the final rendering.
 */
function printCitationSpan(escapedText: string): string {
  return `<cite class="print-citation">${escapedText}</cite>`
}

/** A `.citation` chip's print-export rendering — `PrintCitationOptions.style`/`.placement` applied fresh against `el`'s own `data-source-id`/`data-note`, rather than the chip's already-baked label text (which `inlineHtmlToMarkdown`'s own `default` case would otherwise just read verbatim, same as the plain .md export always does). Falls back to that same verbatim text when there's no source to re-render from — a deleted source, or a chip predating `data-source-id` entirely — since there's nothing to restyle it from. */
function renderPrintCitation(el: HTMLElement, fnCtx: MarkdownFootnoteCtx): string {
  const opts = fnCtx.citationOptions!
  const sourceId = el.getAttribute('data-source-id')
  const source = sourceId ? opts.sources.get(sourceId) : undefined
  if (!source) return printCitationSpan(mdEscapeText(el.textContent ?? ''))
  const note = el.getAttribute('data-note') ?? undefined
  if (opts.placement === 'footnote') {
    // Same "fn<N>" label shape (and the same shared counter) as a real
    // footnote — see MarkdownFootnoteCtx's own doc comment — so a
    // footnote-placed citation and the essay's own real footnotes read
    // as one continuous numbered sequence (the conventional "Notes"
    // citation style), and footnoteDisplayNumber() picks its visible
    // number back out the same way for either kind without needing to
    // know which one it is. No printCitationSpan() wrapper needed here —
    // `ensureCitationSpacing` already recognizes the `sup.print-footnote-ref`
    // markup this produces (shared with every real footnote) directly.
    const label = `fn${fnCtx.counter.next++}`
    const body = formatFootnoteCitation(source.bibtex, opts.bibliographyStyle ?? 'plain', note)
    fnCtx.defs.push(`[^${label}]: ${body}`)
    return `[^${label}]`
  }
  const refNumber = opts.orderedSourceIds.indexOf(sourceId!) + 1
  if (opts.style === 'numbered') return printCitationSpan(mdEscapeText(note ? `[${refNumber}, ${note}]` : `[${refNumber}]`))
  const rendered = opts.style === 'author-title' ? citationLabelAuthorTitle(source.bibtex, note) : citationLabel(source.bibtex, note)
  return printCitationSpan(mdEscapeText(rendered))
}

function inlineHtmlToMarkdown(node: Node, fnCtx: MarkdownFootnoteCtx): string {
  if (node.nodeType === Node.TEXT_NODE) return mdEscapeText(node.textContent || '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const inner = () => Array.from(el.childNodes).map((n) => inlineHtmlToMarkdown(n, fnCtx)).join('')
  if (fnCtx.citationOptions && el.classList.contains('citation')) {
    return renderPrintCitation(el, fnCtx)
  }
  if (tag === 'sup' && el.classList.contains('footnote-ref')) {
    return renderMarkdownFootnoteRef(el.getAttribute('data-footnote-id'), fnCtx)
  }
  if (tag === 'span' && el.classList.contains('math-inline')) {
    return `$${el.getAttribute('data-latex') ?? ''}$`
  }
  switch (tag) {
    case 'b':
    case 'strong':
    case 'i':
    case 'em': {
      // An empty `<b>`/`<strong>`/`<i>`/`<em>` — a stray leftover from
      // toggling a formatting button on, typing nothing (or typing then
      // deleting everything) while it's still active, and clicking away —
      // carries no visible content, so wrapping nothing in `**`/`*`
      // markers would just inject bare, meaningless punctuation into the
      // Markdown. Worse than simply pointless: `markdownToHtml`'s own
      // bold regex requires at least one character between its two `**`
      // pairs, so an empty bold's own `****` fails to match there and
      // falls through to the *italic* regex instead, which happily
      // matches three of the four as `<em>*</em>` and leaves the fourth
      // sitting right after it as a stray, literal character — this is
      // the actual mechanism behind a real reported bug (an empty bold
      // span landing right after the essay title rendering as two
      // orphaned asterisks in the print view). Dropping empty formatting
      // here, at the source, is simpler and more robust than trying to
      // patch around it in the Markdown parser.
      const content = inner()
      if (!content) return ''
      return tag === 'b' || tag === 'strong' ? `**${content}**` : `*${content}*`
    }
    case 'u':
      // Markdown has no native underline syntax — passed through as raw
      // inline HTML instead (which every Markdown flavor this app cares
      // about, and `inlineMarkdownToHtml` itself below, treats as literal
      // passthrough rather than something to escape), the same way a
      // hand-written .md file would mark up underlined text.
      return `<u>${inner()}</u>`
    case 'br':
      return '  \n'
    case 'a': {
      const href = el.getAttribute('href')
      return href ? `[${inner()}](${href})` : inner()
    }
    default:
      return inner()
  }
}

/** A footnote whose content is missing from `footnotesById` (its own node wasn't in the map passed in — shouldn't happen from essayToMarkdown itself, but keeps this safe for any other caller) is dropped silently rather than emitting a broken `[^label]` with nothing to define it. */
function renderMarkdownFootnoteRef(footnoteId: string | null, fnCtx: MarkdownFootnoteCtx): string {
  const contentHtml = footnoteId ? fnCtx.footnotesById.get(footnoteId) : undefined
  if (contentHtml == null) return ''
  const label = `fn${fnCtx.counter.next++}`
  const contentDoc = new DOMParser().parseFromString(contentHtml, 'text/html')
  const contentMd = Array.from(contentDoc.body.childNodes)
    .map((n) => inlineHtmlToMarkdown(n, fnCtx))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  fnCtx.defs.push(`[^${label}]: ${contentMd}`)
  return `[^${label}]`
}

function mdEscapeText(s: string): string {
  // Collapses any run of whitespace — including a literal newline — down
  // to a single space, the same way a browser already visually treats any
  // ordinary text node under the default `white-space: normal` (plain
  // prose, and a `<blockquote>` is no exception). A pasted/inserted quote
  // routinely *has* literal `\n` characters sitting in its text: pulling a
  // selection out of a PDF (`reflowTextItems`/`separatorForGap` in
  // lib/pdf.ts) deliberately turns each line-wrap in the original page
  // into a `\n`, specifically so the extracted text reads back with real
  // line/paragraph structure — exactly right for *that*, but those breaks
  // are never shown in the live editor (the browser collapses them,
  // same as this). Without this, they'd survive untouched into the
  // exported Markdown text, and `htmlToMarkdownBlocks`'s own blockquote
  // handling (which *does* split on real `\n`, to honor an actual `<br>`
  // a user inserted on purpose — see its own `case 'br'` just below)
  // would read every one of those as a deliberate hard break, visibly
  // splitting one flowing quote into several short lines the moment it
  // reached print — confirmed live: a quote with no visible line breaks
  // in the editor came out broken into several lines in the print
  // preview. A real `<br>` never reaches this function at all (it's its
  // own branch, converted to Markdown's own hard-break syntax, not
  // plain text) so this never touches an intentional one.
  //
  // Zero-width spaces (`​`) are stripped outright rather than
  // collapsed like other whitespace — they're never real content, only a
  // caret-landing placeholder editors plant next to an otherwise-empty
  // marker (a footnote ref, a note-less citation's own trailing text —
  // see `citationHtml` in lib/bibtex.ts) so there's always a valid
  // position to click or type into right where the marker visually
  // sits. Left in, one would render as an invisible, non-printable
  // character sitting in the exported text for no visible reason.
  return s
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([*_$[\]\\])/g, '\\$1')
}

/** Splits one node-content shard's HTML into a list of Markdown "blocks" (paragraphs, blockquotes) to join with blank lines. */
function htmlToMarkdownBlocks(html: string, fnCtx: MarkdownFootnoteCtx): string[] {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const blocks: string[] = []
  let current = ''
  const flush = () => {
    const t = current.trim()
    if (t) blocks.push(t)
    current = ''
  }
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += mdEscapeText(node.textContent || '')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'blockquote') {
      flush()
      const inner = Array.from(el.childNodes)
        .map((n) => inlineHtmlToMarkdown(n, fnCtx))
        .join('')
        .trim()
      blocks.push(
        inner
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
      )
      return
    }
    // A full-line equation is a `<span>` (see MathBody.tsx's own doc
    // comment on why neither kind of equation marker is ever a real block
    // element), so this has to be checked *before* the generic "walk a
    // div/p's own children" branch below would otherwise treat it as one —
    // emitted as its own standalone `$$...$$` block, same convention
    // Pandoc/GitHub/Obsidian all already use for Markdown display math.
    if (tag === 'span' && el.classList.contains('math-block')) {
      flush()
      blocks.push(`$$\n${el.getAttribute('data-latex') ?? ''}\n$$`)
      return
    }
    // The toolbar's own "Bulleted list"/"Numbered list" buttons (and the
    // `- `/`1. ` editor shortcuts in `autoListify`) both go through
    // `execCommand('insert(Un)orderedList')`, which produces real
    // `<ul>`/`<ol>`/`<li>` elements — checked before the div/p branch
    // below for the same reason the math-block one above is, so a list
    // never gets misread as a plain paragraph and has its items silently
    // run together with no bullets or numbers (confirmed: that's exactly
    // what happened before this check existed, since the generic `default`
    // case at the bottom just recurses into any unrecognized element's
    // inline content).
    if (tag === 'ul' || tag === 'ol') {
      flush()
      blocks.push(listToMarkdown(el, fnCtx, 0))
      return
    }
    if (tag === 'div' || tag === 'p') {
      flush()
      Array.from(el.childNodes).forEach(walk)
      flush()
      return
    }
    if (tag === 'br') {
      current += '\n'
      return
    }
    current += inlineHtmlToMarkdown(el, fnCtx)
  }
  Array.from(doc.body.childNodes).forEach(walk)
  flush()
  return blocks
}

/** `<ul>`/`<ol>` -> one `- `/`1. ` line per `<li>`, recursing into a nested list right under its own parent item at one deeper indent (CommonMark's own two-space-per-level convention) — the editor itself has no indent/outdent gesture to ever actually produce one, but pasted content can, and a nested list silently flattened into its parent's level reads as structurally wrong rather than just "not indented." */
function listToMarkdown(listEl: HTMLElement, fnCtx: MarkdownFootnoteCtx, depth: number): string {
  const ordered = listEl.tagName.toLowerCase() === 'ol'
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  let n = 1
  for (const li of Array.from(listEl.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue
    const nested: HTMLElement[] = []
    const inlineParts: string[] = []
    for (const child of Array.from(li.childNodes)) {
      const childTag = child.nodeType === Node.ELEMENT_NODE ? (child as HTMLElement).tagName.toLowerCase() : ''
      if (childTag === 'ul' || childTag === 'ol') nested.push(child as HTMLElement)
      else inlineParts.push(inlineHtmlToMarkdown(child, fnCtx))
    }
    const marker = ordered ? `${n++}.` : '-'
    lines.push(`${indent}${marker} ${inlineParts.join('').trim()}`)
    for (const nestedList of nested) lines.push(listToMarkdown(nestedList, fnCtx, depth + 1))
  }
  return lines.join('\n')
}

export function essayToMarkdown(essay: Essay, nodeMap: Map<string, EssayNode>, opts: { citationOptions?: PrintCitationOptions } = {}): string {
  const lines: string[] = [`# ${essay.title}`, '']
  const fnCtx: MarkdownFootnoteCtx = { footnotesById: new Map(), defs: [], counter: { next: 1 }, citationOptions: opts.citationOptions }
  function renderNode(node: EssayNode, depth: number) {
    if (depth > 0) {
      const level = '#'.repeat(Math.min(depth + 1, 6))
      lines.push(`${level} ${node.title || 'Untitled section'}`, '')
    }
    for (const footnote of nodeFootnotes(node)) fnCtx.footnotesById.set(footnote.id, footnote.content)
    for (const seg of parseSegments(node.draftContent)) {
      if (seg.kind === 'text') {
        for (const block of htmlToMarkdownBlocks(seg.html, fnCtx)) lines.push(block, '')
      } else if (seg.kind === 'child') {
        const child = nodeMap.get(seg.childId)
        if (child) renderNode(child, depth + 1)
      }
      // Comments (inline or margin) are commentary, not document text — never exported.
    }
  }
  const root = nodeMap.get(essay.rootNodeId)
  if (root) renderNode(root, 0)
  if (fnCtx.defs.length > 0) lines.push('---', '', ...fnCtx.defs.flatMap((d) => [d, '']))
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n'
}

// ---- Markdown -> printable HTML (for "export to PDF") ----------------

function inlineMarkdownToHtml(text: string): string {
  // `<u>...</u>` is inlineHtmlToMarkdown's own raw-HTML passthrough for
  // underline (Markdown has no native syntax for it) — pulled out and
  // recursively re-rendered (so bold/italic/etc. can still nest inside an
  // underlined run) into its own placeholder *first*, before anything else
  // below gets a chance to either escape its angle brackets into literal
  // text or have its own regexes reach across the tag boundary.
  const underlineSpans: string[] = []
  const withoutUnderline = text.replace(/<u>([\s\S]*?)<\/u>/g, (_, inner: string) => {
    underlineSpans.push(`<u>${inlineMarkdownToHtml(inner)}</u>`)
    return `\u0001${underlineSpans.length - 1}\u0001`
  })

  // Same passthrough trick, same reason, for `<cite class="print-citation">`
  // — see `printCitationSpan`'s own doc comment on why an inline-placed
  // citation needs a real, locatable element at all.
  const citationSpans: string[] = []
  const withoutCitations = withoutUnderline.replace(/<cite class="print-citation">([\s\S]*?)<\/cite>/g, (_, inner: string) => {
    citationSpans.push(`<cite class="print-citation">${inlineMarkdownToHtml(inner)}</cite>`)
    return `\u0003${citationSpans.length - 1}\u0003`
  })

  // mdEscapeText() backslash-escapes literal *, _, $, [, ], \ so a stray
  // character in ordinary typed text can't be mistaken for real markdown
  // syntax — but the naive bold/italic/link patterns below don't know
  // that, and would happily match a "*" they find sitting right after a
  // backslash. So pull every escaped character out into a placeholder
  // *before* running those patterns, and put the literal character back
  // afterward, once nothing can misread it. The placeholder itself is a
  // private-use control character (`\u0002`, never typed text, never
  // produced by escapeHtml below) wrapping the index — not plain digits
  // between spaces, which a real, adjacent number in the escaped text
  // (a numbered citation's own bracket index, a page number in its
  // note — "[1, p. 5]" escapes to "\[1, p. 5\]") can collide with: "
  // 5 " inside that text reads exactly like a placeholder of its own,
  // confirmed live as a real bug (a stray "undefined" in exactly that
  // citation's rendering) before this switched to an unambiguous
  // delimiter, the same one `mathSpans`/`underlineSpans` below already
  // use for the identical reason.
  const escaped: string[] = []
  const withPlaceholders = withoutCitations.replace(/\\([*_$[\]\\])/g, (_, ch: string) => {
    escaped.push(ch)
    return `\u0002${escaped.length - 1}\u0002`
  })

  // Same placeholder trick, for the exact same reason, one pass earlier:
  // an equation's own raw LaTeX source routinely contains *, _, [, ], or \
  // characters of its own that would otherwise be misread as real
  // Markdown syntax by the patterns below — rendered via KaTeX immediately
  // (real, final HTML — `renderMathHtml` never needs a second pass) and
  // substituted back in at the very end, after `escapeHtml` runs, so its
  // own `<span>` markup survives instead of becoming literal text.
  const mathSpans: string[] = []
  const withMathPlaceholders = withPlaceholders.replace(/\$([^$\n]+)\$/g, (_, latex: string) => {
    mathSpans.push(renderMathHtml(latex, false))
    return `\u0000${mathSpans.length - 1}\u0000`
  })

  return escapeHtml(withMathPlaceholders)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\^([^\]]+)\]/g, (_, label: string) => `<sup class="print-footnote-ref"><a href="#fn-${label}">${footnoteDisplayNumber(label)}</a></sup>`)
    .replace(/\u0002(\d+)\u0002/g, (_, i: string) => escaped[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => mathSpans[Number(i)])
    .replace(/\u0001(\d+)\u0001/g, (_, i: string) => underlineSpans[Number(i)])
    .replace(/\u0003(\d+)\u0003/g, (_, i: string) => citationSpans[Number(i)])
}

/** essayToMarkdown()'s own footnote labels are always `fn<n>` — pull the number back out for display so a footnote reads as a plain "1" rather than the internal label text; anything else (a hand-written .md file using its own label scheme) just shows the raw label instead of guessing. */
function footnoteDisplayNumber(label: string): string {
  const m = /^fn(\d+)$/.exec(label)
  return m ? m[1] : label
}

/** A small, deliberately narrow Markdown->HTML renderer — just enough to round-trip what essayToMarkdown() itself produces, for the "render the Markdown, then print it" PDF path. Not a general Markdown parser. */
export function markdownToHtml(md: string): string {
  const out: string[] = []
  const footnoteDefs: string[] = []
  let paragraph: string[] = []
  // Non-null while inside a `$$` ... `$$` display-math block — collects
  // its raw LaTeX lines until the closing `$$`, same two-states-per-line
  // shape the rest of this loop already uses for everything else.
  let mathBlockLines: string[] | null = null
  // Mirrors `listToMarkdown`'s own output on the way back: one entry per
  // currently-open `<ul>`/`<ol>`, indent-deepest last, so a line can close
  // exactly the levels it's stepping back out of (or none, to keep adding
  // to the list already open at its own depth) before anything new gets
  // pushed to `out`.
  let listStack: { tag: 'ul' | 'ol'; indent: number }[] = []
  const closeListsTo = (indent: number) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) out.push(`</${listStack.pop()!.tag}>`)
  }
  const flush = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineMarkdownToHtml(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  // Every other block type ends whatever list was open, same as a blank
  // line does in real Markdown — `flush()` alone only ever deals with an
  // in-progress paragraph, so every branch below but the list one itself
  // calls this instead.
  const endBlock = () => {
    flush()
    closeListsTo(-1)
  }
  for (const line of md.split('\n')) {
    if (mathBlockLines !== null) {
      if (line.trim() === '$$') {
        out.push(renderMathHtml(mathBlockLines.join('\n'), true))
        mathBlockLines = null
      } else {
        mathBlockLines.push(line)
      }
      continue
    }
    if (line.trim() === '$$') {
      endBlock()
      mathBlockLines = []
      continue
    }
    const footnoteDef = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/)
    if (footnoteDef) {
      endBlock()
      footnoteDefs.push(`<li id="fn-${footnoteDef[1]}">${inlineMarkdownToHtml(footnoteDef[2])}</li>`)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      endBlock()
      const level = heading[1].length
      out.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      endBlock()
      out.push(`<blockquote>${inlineMarkdownToHtml(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (line.trim() === '---') {
      // essayToMarkdown()'s own separator right before its footnote
      // definitions — meaningless as a paragraph on its own; the <hr>
      // below already marks that transition visually once footnoteDefs
      // actually has anything in it.
      endBlock()
      continue
    }
    // `listToMarkdown`'s own output, one line per `<li>` — `- ` for an
    // unordered list, `<number>. ` for an ordered one, indented two
    // spaces per nesting level. The list stays open (no `endBlock()`)
    // across consecutive list lines, even ones that step back out to a
    // shallower level, since that's still the *same* list picking back up
    // — only something that isn't a list line at all, or a blank line,
    // actually ends it.
    const listItem = line.match(/^(\s*)(-|\d+\.)\s+(.*)$/)
    if (listItem) {
      flush()
      const indent = Math.round(listItem[1].length / 2)
      const tag = listItem[2] === '-' ? 'ul' : 'ol'
      closeListsTo(indent)
      const top = listStack[listStack.length - 1]
      if (!top || top.indent < indent || top.tag !== tag) {
        if (top && top.indent === indent) out.push(`</${listStack.pop()!.tag}>`)
        out.push(`<${tag}>`)
        listStack.push({ tag, indent })
      }
      out.push(`<li>${inlineMarkdownToHtml(listItem[3])}</li>`)
      continue
    }
    if (line.trim() === '') {
      endBlock()
      continue
    }
    paragraph.push(line.trim())
  }
  // An unterminated `$$` block (shouldn't happen from essayToMarkdown's
  // own output, which always closes what it opens, but this is also the
  // path a hand-edited .md file could reach) still renders rather than
  // silently dropping whatever text it held.
  if (mathBlockLines !== null) out.push(renderMathHtml(mathBlockLines.join('\n'), true))
  endBlock()
  if (footnoteDefs.length > 0) out.push('<hr>', `<ol class="print-footnotes">${footnoteDefs.join('')}</ol>`)
  return out.join('\n')
}

/**
 * Post-processes `markdownToHtml`'s own output for the print/PDF export
 * view with the two bits of structure that don't survive the Markdown
 * round-trip: section numbering (the same N.M scheme the editor already
 * suggests for a brand-new section's placeholder title — see
 * `treeNumbering.ts`) and a horizontal rule under the title and under
 * each root-level section.
 *
 * Walks the rendered heading levels directly rather than the node tree
 * (no `nodeMap` needed here): `essayToMarkdown`'s own `renderNode` always
 * emits exactly one heading per node, one level deeper per level of
 * nesting, in document order — so `<h1>` is always the essay's own title,
 * `<h2>` always a root-level section, `<h3>` always a child of one, and so
 * on, the same correspondence `sectionCmd` below relies on for the LaTeX
 * export. A node's title is always plain text (see `EssayNode.title`),
 * never rich HTML, so prepending the number as a plain string is safe —
 * nothing here needs to parse or preserve inline markup.
 *
 * Both rules land the same way relative to their own heading — right
 * after it, same as the title's own — rather than the section one
 * sitting at the *bottom* of all that section's content (including its
 * own subsections): it reads as underlining the heading, the same role
 * the title's thick rule plays for the title above it, not as a divider
 * between one section's content and the next.
 *
 * An abstract (see `isAbstractTitle` in `treeNumbering.ts`) — always the
 * very first `<h2>`, if it's there at all, the same structural spot
 * `pathOf` already special-cases — gets no number and no rule of its
 * own; `renderAbstractSection` below folds it into a run-in "Abstract."
 * lead instead, the same exception `pathOf` makes for it when numbering
 * every *other* root-level section.
 */
export function addPrintChrome(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  const hr = (className: string) => {
    const el = doc.createElement('hr')
    el.className = className
    return el
  }
  const headings = Array.from(doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6'))
  const counters: number[] = []
  let seenH2 = false
  let abstractHeading: Element | null = null
  for (const heading of headings) {
    const level = Number(heading.tagName[1])
    if (level === 1) {
      heading.after(hr('print-title-rule'))
      continue
    }
    if (level === 2) {
      if (!seenH2 && isAbstractTitle(heading.textContent ?? undefined)) {
        seenH2 = true
        abstractHeading = heading
        continue
      }
      seenH2 = true
    }
    const depth = level - 1 // h2 -> root-level section (depth 1), h3 -> its child (depth 2), ...
    counters[depth - 1] = (counters[depth - 1] ?? 0) + 1
    counters.length = depth // drop any deeper counters left over from a previous sibling's own subsections
    heading.prepend(`${counters.join('.')} `)
    if (level === 2) heading.after(hr('print-section-rule'))
  }
  if (abstractHeading) renderAbstractSection(doc, abstractHeading)
  return doc.body.innerHTML
}

/**
 * Replaces `heading` and everything after it up to the next heading (its
 * own section's content) with a `.print-abstract`-wrapped block whose
 * lead is a bold "Abstract." run-in — folded into the start of the
 * section's own first paragraph when it has one, or standing alone if
 * the abstract has no body text yet — rather than `heading` itself,
 * which would otherwise render as a normal large `<h2>`. The wrapper
 * class is what `ExportDialog`'s own print CSS hooks the smaller
 * font/wider side margins onto.
 */
function renderAbstractSection(doc: Document, heading: Element): void {
  const content: Element[] = []
  for (let sib = heading.nextElementSibling; sib && !/^H[1-6]$/.test(sib.tagName); ) {
    const next = sib.nextElementSibling
    content.push(sib)
    sib = next
  }
  const firstPara = content.find((el) => el.tagName === 'P')
  const label = doc.createElement('strong')
  label.textContent = 'Abstract. '
  if (firstPara) {
    firstPara.prepend(label)
  } else {
    const p = doc.createElement('p')
    p.appendChild(label)
    content.unshift(p)
  }
  const wrapper = doc.createElement('div')
  wrapper.className = 'print-abstract'
  for (const el of content) wrapper.appendChild(el)
  heading.replaceWith(wrapper)
}

/**
 * "Mathlike" print mode's own subsection rendering (`ExportDialog`'s
 * `printMode === 'mathlike'`) — every `<h3>` or deeper (root-level
 * `<h2>`s are left alone; that's a pure-CSS treatment, centered
 * small-caps, see the print CSS itself) becomes a bold run-in lead
 * folded into its own first paragraph, numbering and all (run *after*
 * `addPrintChrome`, so `heading.textContent` already carries the "2.1 "
 * prefix it prepended), the same "Section N.M. " + no paragraph break
 * shape `amsart`'s own `\subsection` uses — rather than a separate block
 * heading sitting above a new paragraph. Must run after `addPrintChrome`
 * for the numbering to already be in place; doesn't touch the abstract
 * (never an `<h3>+`) or anything `addPrintChrome` already folded away.
 */
export function applyMathlikeHeadings(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  for (const heading of Array.from(doc.body.querySelectorAll('h3, h4, h5, h6'))) {
    const content: Element[] = []
    for (let sib = heading.nextElementSibling; sib && !/^H[1-6]$/.test(sib.tagName); ) {
      const next = sib.nextElementSibling
      content.push(sib)
      sib = next
    }
    const text = (heading.textContent ?? '').trim()
    const label = doc.createElement('strong')
    label.textContent = (text.endsWith('.') ? text : `${text}.`) + ' '
    const firstPara = content.find((el) => el.tagName === 'P')
    if (firstPara) {
      firstPara.prepend(label)
      heading.remove()
    } else {
      const p = doc.createElement('p')
      p.appendChild(label)
      heading.replaceWith(p)
    }
  }
  return doc.body.innerHTML
}

/**
 * Transforms `markdownToHtml()`'s own "collected at the end" footnote
 * shape — a `<sup class="print-footnote-ref">` marker inline plus a
 * trailing `<ol class="print-footnotes">` list — into Paged.js's
 * `float: footnote` shape instead: each footnote's body becomes an
 * inline `<span class="pagedjs-footnote" data-ref="…">` sitting right
 * where its marker used to be, which Paged.js's own Footnotes module
 * (wired up in `ExportDialog.tsx`'s print CSS) then floats down to the
 * bottom of whichever physical page it actually lands on, auto-numbering
 * its own marker/call via CSS counters — there's no number baked into
 * the HTML here at all, unlike the `<sup>` it replaces, since only
 * Paged.js's own layout pass can know which page a given footnote ends
 * up sharing with its neighbors, and so what its own page-local number
 * should read. `ExportDialog`'s `exportPdf` is the only caller — the
 * plain .md export's reference-style footnotes are untouched, since that
 * format has no real pages to float a footnote within.
 */
/**
 * Print/PDF export only (see `ExportDialog`'s own `exportPdf`) — must run
 * before `floatPrintFootnotes` below, which consumes every
 * `sup.print-footnote-ref` this looks for. Guarantees at least one
 * whitespace character immediately before and after every rendered
 * citation: both the inline parenthetical/bracket kind (marked up as
 * `<cite class="print-citation">` purely as a locatable scaffold for this
 * pass — see `printCitationSpan`'s own doc comment) and the footnote-placed
 * kind, which shares the exact same `sup.print-footnote-ref` markup real
 * footnotes use (so a real footnote sitting right against another one, or
 * against a footnote-placed citation, gets the same treatment — there's no
 * reason a bare footnote should be allowed to glue itself to its neighbor
 * any more than a citation should).
 *
 * Only inserts a space when the character immediately on that side is a
 * letter/digit, or when it's another citation/footnote marker sitting
 * right up against this one with nothing between — never next to
 * whitespace that's already there (nothing is duplicated), never next to
 * punctuation ("separate (Smith, 2020)." keeps its period, not a space
 * shoved in before it), and never at the very start or end of a
 * paragraph (nothing to separate it from). Deliberately only looks at
 * immediate siblings, not across a block/paragraph boundary — a citation
 * at the edge of its own paragraph needs no padding against the
 * paragraph next to it.
 *
 * Finishes by unwrapping every `<cite class="print-citation">` back down
 * to its own plain text — it was only ever a scaffold for this pass, so
 * the final HTML reads exactly as it always did, just with the spacing
 * fixed up.
 */
export function ensureCitationSpacing(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  const isMarker = (el: Element | null): boolean => !!el && (el.matches('cite.print-citation') || el.matches('sup.print-footnote-ref'))
  const WORD_CHAR = /[\p{L}\p{N}]/u

  function edgeChar(el: Element, direction: 'before' | 'after'): { char: string | null; marker: boolean } {
    let sib: ChildNode | null = direction === 'before' ? el.previousSibling : el.nextSibling
    while (sib) {
      if (sib.nodeType === Node.TEXT_NODE) {
        const text = sib.textContent ?? ''
        if (text.length > 0) return { char: direction === 'before' ? text[text.length - 1] : text[0], marker: false }
      } else if (sib.nodeType === Node.ELEMENT_NODE) {
        const sibEl = sib as Element
        if (isMarker(sibEl)) return { char: null, marker: true }
        const text = sibEl.textContent ?? ''
        if (text.length > 0) return { char: direction === 'before' ? text[text.length - 1] : text[0], marker: false }
      }
      sib = direction === 'before' ? sib.previousSibling : sib.nextSibling
    }
    return { char: null, marker: false }
  }

  const markers = Array.from(doc.body.querySelectorAll('cite.print-citation, sup.print-footnote-ref'))
  for (const marker of markers) {
    const before = edgeChar(marker, 'before')
    if (before.marker || (before.char !== null && WORD_CHAR.test(before.char))) marker.before(doc.createTextNode(' '))
    const after = edgeChar(marker, 'after')
    if (after.marker || (after.char !== null && WORD_CHAR.test(after.char))) marker.after(doc.createTextNode(' '))
  }

  for (const cite of Array.from(doc.body.querySelectorAll('cite.print-citation'))) {
    cite.replaceWith(doc.createTextNode(cite.textContent ?? ''))
  }
  return doc.body.innerHTML
}

export function floatPrintFootnotes(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  const list = doc.body.querySelector('ol.print-footnotes')
  if (!list) return bodyHtml
  const bodies = new Map<string, string>()
  for (const li of Array.from(list.children)) bodies.set(li.id.replace(/^fn-/, ''), li.innerHTML)
  const precedingHr = list.previousElementSibling
  if (precedingHr?.tagName === 'HR') precedingHr.remove()
  list.remove()
  for (const ref of Array.from(doc.body.querySelectorAll('sup.print-footnote-ref'))) {
    const href = ref.querySelector('a')?.getAttribute('href') ?? ''
    const id = href.replace(/^#fn-/, '')
    const span = doc.createElement('span')
    span.className = 'pagedjs-footnote'
    span.setAttribute('data-ref', id)
    span.innerHTML = bodies.get(id) ?? ''
    ref.replaceWith(span)
  }
  return doc.body.innerHTML
}

// ---- LaTeX -------------------------------------------------------------

const SECTION_CMDS = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']
function sectionCmd(depth: number): string {
  return SECTION_CMDS[Math.min(depth - 1, SECTION_CMDS.length - 1)]
}

function texEscape(s: string): string {
  // Same reasoning as mdEscapeText's own whitespace collapse (its own doc
  // comment has the fuller story): a run of whitespace, including a
  // literal `\n` a pasted/inserted quote often has sitting in its text,
  // reads in the live editor exactly like a single space (the browser
  // collapses it) — collapsed here the same way before anything else
  // touches it, so a `\n\n` from the original text doesn't compile as an
  // unintended LaTeX paragraph break, and the generated .tex source
  // doesn't carry a confusing mid-sentence line break either. Zero-width
  // spaces are stripped outright for the same reason mdEscapeText strips
  // them — see that function's own doc comment.
  return s
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([%$#_{}&])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

interface LatexCtx {
  sources: Map<string, Source>
  citeCmd: string
  /** This node's own footnotes, by id — refreshed per node in essayToLatex's renderNode, same reasoning as MarkdownFootnoteCtx's own footnotesById. */
  footnotesById: Map<string, string>
}

function inlineHtmlToLatex(node: Node, ctx: LatexCtx): string {
  if (node.nodeType === Node.TEXT_NODE) return texEscape(node.textContent || '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const inner = () => Array.from(el.childNodes).map((n) => inlineHtmlToLatex(n, ctx)).join('')
  const sourceId = el.getAttribute('data-source-id')
  if (el.classList.contains('citation') && sourceId) {
    const key = ctx.sources.get(sourceId)?.bibtex.key ?? sourceId
    // The freeform "page number or other note" field (lib/bibtex.ts's
    // `citationHtml`/`data-note`) maps directly onto natbib/biblatex's own
    // optional post-note argument — `\cite[p. 5]{key}` — both `\cite` and
    // `\footcite` support it. A legacy citation (no structured data at
    // all, migrated to plain text by essaysRepo.ts before this ever sees
    // it) never reaches here as a `.citation` element in the first place.
    const note = el.getAttribute('data-note')
    return note ? `${ctx.citeCmd}[${texEscape(note)}]{${key}}` : `${ctx.citeCmd}{${key}}`
  }
  if (tag === 'sup' && el.classList.contains('footnote-ref')) {
    // Unlike Markdown, LaTeX footnotes are inline and self-numbering —
    // \footnote{} needs no separate label or definition list, so this is
    // the one export format where a footnote-ref marker round-trips back
    // to exactly the LaTeX construct it most likely came from.
    const footnoteId = el.getAttribute('data-footnote-id')
    const contentHtml = footnoteId ? ctx.footnotesById.get(footnoteId) : undefined
    if (contentHtml == null) return ''
    const contentDoc = new DOMParser().parseFromString(contentHtml, 'text/html')
    const contentLatex = Array.from(contentDoc.body.childNodes)
      .map((n) => inlineHtmlToLatex(n, ctx))
      .join('')
      .trim()
    return `\\footnote{${contentLatex}}`
  }
  if (tag === 'span' && el.classList.contains('math-inline')) {
    // The one export format where an equation marker round-trips back to
    // exactly the syntax it most likely came from — its own raw LaTeX
    // source, never passed through texEscape (that's for literal prose
    // text, not already-valid LaTeX).
    return `$${el.getAttribute('data-latex') ?? ''}$`
  }
  switch (tag) {
    case 'b':
    case 'strong':
      return `\\textbf{${inner()}}`
    case 'i':
    case 'em':
      return `\\textit{${inner()}}`
    case 'u':
      return `\\underline{${inner()}}`
    case 'br':
      return '\\\\\n'
    case 'a': {
      const href = el.getAttribute('href')
      return href ? `\\href{${href}}{${inner()}}` : inner()
    }
    default:
      return inner()
  }
}

/** `<ul>`/`<ol>` -> `itemize`/`enumerate`, one `\item` per `<li>` — see `listToMarkdown`'s own doc comment for the nested-list caveat, which applies identically here. */
function listToLatex(listEl: HTMLElement, ctx: LatexCtx): string {
  const env = listEl.tagName.toLowerCase() === 'ol' ? 'enumerate' : 'itemize'
  const items: string[] = []
  for (const li of Array.from(listEl.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue
    const nested: HTMLElement[] = []
    const inlineParts: string[] = []
    for (const child of Array.from(li.childNodes)) {
      const childTag = child.nodeType === Node.ELEMENT_NODE ? (child as HTMLElement).tagName.toLowerCase() : ''
      if (childTag === 'ul' || childTag === 'ol') nested.push(child as HTMLElement)
      else inlineParts.push(inlineHtmlToLatex(child, ctx))
    }
    let item = `\\item ${inlineParts.join('').trim()}`
    for (const nestedList of nested) item += `\n${listToLatex(nestedList, ctx)}`
    items.push(item)
  }
  return `\\begin{${env}}\n${items.join('\n')}\n\\end{${env}}`
}

function htmlToLatexBlocks(html: string, ctx: LatexCtx): string[] {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const blocks: string[] = []
  let current = ''
  const flush = () => {
    const t = current.trim()
    if (t) blocks.push(t)
    current = ''
  }
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += texEscape(node.textContent || '')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'blockquote') {
      flush()
      const inner = Array.from(el.childNodes).map((n) => inlineHtmlToLatex(n, ctx)).join('').trim()
      blocks.push(`\\begin{quote}\n${inner}\n\\end{quote}`)
      return
    }
    // See htmlToMarkdownBlocks's own matching case — a full-line equation
    // is a `<span>`, checked before the generic div/p recursion would
    // otherwise treat it as one. `\[...\]` is the exact syntax the editor's
    // own `\[` shortcut uses to create one in the first place.
    if (tag === 'span' && el.classList.contains('math-block')) {
      flush()
      blocks.push(`\\[\n${el.getAttribute('data-latex') ?? ''}\n\\]`)
      return
    }
    // See htmlToMarkdownBlocks's own matching case for why this has to be
    // checked ahead of the generic div/p recursion below.
    if (tag === 'ul' || tag === 'ol') {
      flush()
      blocks.push(listToLatex(el, ctx))
      return
    }
    if (tag === 'div' || tag === 'p') {
      flush()
      Array.from(el.childNodes).forEach(walk)
      flush()
      return
    }
    if (tag === 'br') {
      current += '\\\\\n'
      return
    }
    current += inlineHtmlToLatex(el, ctx)
  }
  Array.from(doc.body.childNodes).forEach(walk)
  flush()
  return blocks
}

export function essayToLatex(essay: Essay, nodeMap: Map<string, EssayNode>, sources: Map<string, Source>, opts: { citeCommand?: '\\cite' | '\\footcite' } = {}): string {
  const citeCmd = opts.citeCommand ?? '\\cite'
  const ctx: LatexCtx = { sources, citeCmd, footnotesById: new Map() }
  const body: string[] = []
  const root = nodeMap.get(essay.rootNodeId)
  // See `addPrintChrome`'s own matching exception — the abstract (if
  // there is one) is always the root's own first child, so its id is
  // known up front rather than needing an insertIndex threaded through
  // every recursive call.
  const abstractId = root ? getChildIds(root.draftContent)[0] : undefined
  function renderNode(node: EssayNode, depth: number) {
    const isAbstract = depth === 1 && node.id === abstractId && isAbstractTitle(node.title)
    if (depth > 0 && !isAbstract) {
      body.push(`\\${sectionCmd(depth)}{${texEscape(node.title || 'Untitled section')}}`, '')
    }
    for (const footnote of nodeFootnotes(node)) ctx.footnotesById.set(footnote.id, footnote.content)
    if (isAbstract) {
      // `\abstract{}` takes its content as one macro argument — plain
      // text/inline markup, same as everywhere else in this file, but
      // not a place for the block-level `\section{}`/list/quote
      // structure a normal node's own child subsections could produce,
      // so only this node's own text segments go inside the braces; any
      // (unusual, but not disallowed) subsections of their own still
      // render normally, right after it, as real `\section{}`s.
      const ownBlocks: string[] = []
      for (const seg of parseSegments(node.draftContent)) {
        if (seg.kind === 'text') ownBlocks.push(...htmlToLatexBlocks(seg.html, ctx))
      }
      body.push(`\\abstract{${ownBlocks.join('\n\n')}}`, '')
      for (const seg of parseSegments(node.draftContent)) {
        if (seg.kind === 'child') {
          const child = nodeMap.get(seg.childId)
          if (child) renderNode(child, depth + 1)
        }
      }
      return
    }
    for (const seg of parseSegments(node.draftContent)) {
      if (seg.kind === 'text') {
        for (const block of htmlToLatexBlocks(seg.html, ctx)) body.push(block, '')
      } else if (seg.kind === 'child') {
        const child = nodeMap.get(seg.childId)
        if (child) renderNode(child, depth + 1)
      }
      // Comments (inline or margin) are commentary, not document text — never exported.
    }
  }
  if (root) renderNode(root, 0)

  const usesBiblatex = citeCmd === '\\footcite'
  return (
    [
      '\\documentclass{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{hyperref}',
      usesBiblatex ? '\\usepackage{biblatex}' : '\\usepackage{natbib}',
      usesBiblatex ? '\\addbibresource{references.bib}' : '',
      `\\title{${texEscape(essay.title)}}`,
      '\\begin{document}',
      '\\maketitle',
      '',
      ...body,
      usesBiblatex ? '\\printbibliography' : '\\bibliographystyle{plain}\n\\bibliography{references}',
      '\\end{document}',
      '',
    ]
      .filter((l) => l !== '')
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
  )
}

// ---- Shared: which sources does this essay actually cite? -------------

export function collectUsedSourceIds(nodeMap: Map<string, EssayNode>): Set<string> {
  const ids = new Set<string>()
  for (const node of nodeMap.values()) {
    const doc = new DOMParser().parseFromString(node.draftContent || '', 'text/html')
    doc.querySelectorAll('[data-source-id]').forEach((el) => ids.add(el.getAttribute('data-source-id')!))
  }
  return ids
}

export function sourcesToBibtex(sources: Source[]): string {
  return sources.map((s) => formatBibtex(s.bibtex)).join('\n\n') + '\n'
}

// ---- References / bibliography -----------------------------------------

/**
 * Which bibliography style a References entry is rendered in — `'plain'`
 * (author/year/title/venue, one sentence-per-field — see `formatCitation`
 * in lib/bibtex.ts, already used the same way for a source's own
 * "formatted citation" display), or one of the three real styles below.
 * Adding a style is still just a new case in `renderBibliographyEntry`
 * and a new option in `ExportDialog`'s own selector, never a data
 * migration or a second code path through the rest of export.ts.
 */
export type BibliographyStyle = 'plain' | 'apa' | 'mla' | 'chicago'

interface ParsedAuthor {
  last: string
  /** Empty when the stored name had no comma to invert on (an institutional author, or one typed "First Last" instead of the usual "Last, First") — every formatter below falls back to using `last` alone whenever this is empty, rather than guessing which part of an uninverted name is the surname. */
  first: string
}

/** Splits a stored author field — `"Last, First and Last2, First2"`, the convention `AddSourceDialog`'s own field hint establishes — into individual authors, in citation order (first listed = first author). */
function parseAuthorList(raw: string | undefined): ParsedAuthor[] {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return []
  return trimmed
    .split(/\s+and\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const commaIdx = part.indexOf(',')
      if (commaIdx === -1) return { last: part, first: '' }
      return { last: part.slice(0, commaIdx).trim(), first: part.slice(commaIdx + 1).trim() }
    })
}

/** "Jane Marie" -> "J. M." — one initial per space-separated given name, for APA's own reference-list author style. */
function initials(first: string): string {
  return first
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}.`)
    .join(' ')
}

function authorFull(a: ParsedAuthor, invert: boolean): string {
  if (!a.first) return a.last
  return invert ? `${a.last}, ${a.first}` : `${a.first} ${a.last}`
}

/** APA 7-style reference-list author list: every author inverted to Last, Initials, comma-separated, with an ampersand before the last one. No "et al." truncation past 20 authors — not worth the complexity for a personal bibliography. */
function formatAuthorsApa(authors: ParsedAuthor[]): string {
  const names = authors.map((a) => (a.first ? `${a.last}, ${initials(a.first)}` : a.last))
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
}

/** MLA/Chicago-style author list: the first author inverted (Last, First), every other author in natural order — simplified to "et al." at 3+ authors for both styles (MLA 9 and Chicago 17 actually differ slightly on the exact thresholds/cutoffs; this is close enough for a personal bibliography rather than a submission-ready one). */
function formatAuthorsNameOrder(authors: ParsedAuthor[]): string {
  if (authors.length === 0) return ''
  if (authors.length === 1) return authorFull(authors[0], true)
  if (authors.length === 2) return `${authorFull(authors[0], true)}, and ${authorFull(authors[1], false)}`
  return `${authorFull(authors[0], true)}, et al.`
}

/**
 * APA 7th-edition reference-list entry: `Author, I. (Year). Title. *Venue*,
 * vol(no), pages.` for a journal article (no publisher — a journal article
 * never lists one in APA); `Author, I. (Year). Chapter title. In Editor
 * (Ed.), *Book Title* (pp. P). Publisher.` for a chapter in an edited book
 * (`booktitle` set, no `journal`) — unlike a journal article, a book
 * chapter's own entry *does* need the publisher, just like a standalone
 * book does; `Author, I. (Year). *Title*. Edited by Editor. Publisher.`
 * for a standalone book with its own separate editor (an edited
 * collection with no single "author" of its own, or an edited edition of
 * an authored work — either way, shown as its own sentence, not folded
 * into the "In Editor (Ed.), *Book*" phrasing a book-chapter entry uses,
 * since there's no containing work here for that phrasing to introduce).
 * A translated work's own title gets a trailing "(T. Translator, Trans.)"
 * in every case. `editor`/`translator`, and the trailing ISBN/DOI/URL/
 * note fields (`trailingCitationFields`, lib/bibtex.ts), are simply
 * omitted when absent — otherwise degrading the same way as fields go
 * missing, down to just the (italicized, as APA treats a standalone work)
 * title when there's nothing else at all. Titles are kept exactly as
 * entered — APA's own sentence-case title rule isn't applied, since
 * reliably sentence-casing an arbitrary user-entered title isn't
 * something this can get right automatically.
 */
function formatApaEntry(entry: BibtexEntry, opts: TrailingFieldsOptions = {}): string {
  const f = entry.fields
  const authors = formatAuthorsApa(parseAuthorList(f.author))
  const year = f.year ? `(${mdEscapeText(f.year)})` : ''
  const title = mdEscapeText(f.title || entry.key)
  const translatorSuffix = f.translator ? ` (${mdEscapeText(f.translator)}, Trans.)` : ''
  const sentences: string[] = []
  if (authors || year) sentences.push([authors, year].filter(Boolean).join(' '))
  if (f.journal) {
    sentences.push(`${title}${translatorSuffix}`)
    const venueBits = [`*${mdEscapeText(f.journal)}*`, f.volume ? (f.number ? `${mdEscapeText(f.volume)}(${mdEscapeText(f.number)})` : mdEscapeText(f.volume)) : '', f.pages ? mdEscapeText(f.pages) : ''].filter(Boolean)
    sentences.push(venueBits.join(', '))
  } else if (f.booktitle) {
    sentences.push(`${title}${translatorSuffix}`)
    const editorPart = f.editor ? `${mdEscapeText(f.editor)} (Ed.), ` : ''
    sentences.push(`In ${editorPart}*${mdEscapeText(f.booktitle)}*${f.pages ? ` (pp. ${mdEscapeText(f.pages)})` : ''}`)
    if (f.publisher) sentences.push(mdEscapeText(f.publisher))
  } else if (f.publisher) {
    sentences.push(`*${title}*${translatorSuffix}`)
    if (f.editor) sentences.push(`Edited by ${mdEscapeText(f.editor)}`)
    sentences.push(mdEscapeText(f.publisher))
  } else {
    sentences.push(`*${title}*${translatorSuffix}`)
    if (f.editor) sentences.push(`Edited by ${mdEscapeText(f.editor)}`)
  }
  sentences.push(...trailingCitationFields(f, mdEscapeText, opts))
  return sentences.join('. ') + '.'
}

/**
 * MLA 9th-edition Works-Cited entry: `Last, First. "Title." *Venue*,
 * translated by Translator, vol. V, no. N, Year, pp. P-P.` for a journal
 * article (no publisher — a journal issue doesn't get one in MLA); `Last,
 * First. "Chapter Title." *Book Title*, edited by Editor, translated by
 * Translator, Publisher, Year, pp. P-P.` for a chapter in an edited book
 * (`booktitle` set, no `journal`) — unlike a journal article, MLA *does*
 * want the publisher for a book chapter, the same as for a standalone
 * book; `Last, First. *Title*. Edited by Editor. Publisher, Year.` for a
 * standalone book with its own separate editor — shown as its own
 * sentence here (an independent work's own title is what gets italicized
 * instead of quoted, with nothing to quote, same as every other
 * standalone-book shape below). `editor`/`translator`, and the trailing
 * ISBN/DOI/URL/note fields (`trailingCitationFields`, lib/bibtex.ts), are
 * simply omitted when absent. Degrades the same way `formatApaEntry`
 * does otherwise.
 */
function formatMlaEntry(entry: BibtexEntry, opts: TrailingFieldsOptions = {}): string {
  const f = entry.fields
  const authors = formatAuthorsNameOrder(parseAuthorList(f.author))
  const title = mdEscapeText(f.title || entry.key)
  const translatedBy = f.translator ? `translated by ${mdEscapeText(f.translator)}` : ''
  const editedBy = f.editor ? `edited by ${mdEscapeText(f.editor)}` : ''
  // Each sentence below carries its own trailing period already (joined
  // with a plain space, not '. ' + a final period) — MLA's own
  // period-inside-the-closing-quote convention ("Title.") means the
  // period can't just be tacked on after the whole sentence is already
  // assembled, the way formatApaEntry's own unquoted titles can.
  const sentences: string[] = []
  if (authors) sentences.push(`${authors}.`)
  if (f.journal) {
    sentences.push(`"${title}."`)
    const venueBits = [`*${mdEscapeText(f.journal)}*`, translatedBy, f.volume ? `vol. ${mdEscapeText(f.volume)}` : '', f.number ? `no. ${mdEscapeText(f.number)}` : '', f.year ? mdEscapeText(f.year) : '', f.pages ? `pp. ${mdEscapeText(f.pages)}` : '']
      .filter(Boolean)
    sentences.push(`${venueBits.join(', ')}.`)
  } else if (f.booktitle) {
    sentences.push(`"${title}."`)
    const venueBits = [`*${mdEscapeText(f.booktitle)}*`, editedBy, translatedBy, f.publisher ? mdEscapeText(f.publisher) : '', f.year ? mdEscapeText(f.year) : '', f.pages ? `pp. ${mdEscapeText(f.pages)}` : ''].filter(Boolean)
    sentences.push(`${venueBits.join(', ')}.`)
  } else if (f.publisher) {
    sentences.push(`*${title}*.`)
    if (editedBy) sentences.push(`${editedBy.charAt(0).toUpperCase()}${editedBy.slice(1)}.`)
    sentences.push(`${[translatedBy, mdEscapeText(f.publisher), f.year ? mdEscapeText(f.year) : ''].filter(Boolean).join(', ')}.`)
  } else {
    sentences.push(f.year ? `*${title}*, ${mdEscapeText(f.year)}.` : `*${title}*.`)
    if (editedBy) sentences.push(`${editedBy.charAt(0).toUpperCase()}${editedBy.slice(1)}.`)
  }
  sentences.push(...trailingCitationFields(f, mdEscapeText, opts).map((s) => `${s}.`))
  return sentences.join(' ')
}

/**
 * Chicago 17th-edition (notes-bibliography) entry: `Last, First. "Title."
 * Translated by Translator. *Venue* vol, no. N (Year): pages.` for a
 * journal article (no publisher — a journal article doesn't get one in
 * Chicago either); `Last, First. "Chapter Title." Translated by
 * Translator. In *Book Title*, edited by Editor, pages. Publisher,
 * Year.` for a chapter in an edited book (`booktitle` set, no `journal`)
 * — unlike a journal article, Chicago *does* want the publisher (and
 * year) for a book chapter, same as for a standalone book; `Last, First.
 * *Title*. Edited by Editor. Translated by Translator. Publisher, Year.`
 * for a standalone book with its own separate editor — shown as its own
 * sentence here, same as `formatMlaEntry` does. `editor`/`translator`,
 * and the trailing ISBN/DOI/URL/note fields (`trailingCitationFields`,
 * lib/bibtex.ts), are simply omitted when absent. No place-of-publication
 * for either book form — Chicago's full convention wants one, but this
 * app doesn't store one, so it's left out rather than guessed at, the
 * same degrade-gracefully-as-fields-go-missing approach `formatCitation`
 * already takes.
 */
function formatChicagoEntry(entry: BibtexEntry, opts: TrailingFieldsOptions = {}): string {
  const f = entry.fields
  const authors = formatAuthorsNameOrder(parseAuthorList(f.author))
  const title = mdEscapeText(f.title || entry.key)
  const translatedBy = f.translator ? `Translated by ${mdEscapeText(f.translator)}.` : ''
  const editedByOwnSentence = f.editor ? `Edited by ${mdEscapeText(f.editor)}.` : ''
  // See formatMlaEntry's own comment — same period-inside-the-quote
  // reasoning applies here too.
  const sentences: string[] = []
  if (authors) sentences.push(`${authors}.`)
  if (f.journal) {
    sentences.push(`"${title}."`)
    if (translatedBy) sentences.push(translatedBy)
    const volNo = [f.volume ? mdEscapeText(f.volume) : '', f.number ? `no. ${mdEscapeText(f.number)}` : ''].filter(Boolean).join(', ')
    const yearPart = f.year ? ` (${mdEscapeText(f.year)})` : ''
    const pagesPart = f.pages ? `: ${mdEscapeText(f.pages)}` : ''
    sentences.push(`*${mdEscapeText(f.journal)}*${volNo ? ' ' + volNo : ''}${yearPart}${pagesPart}.`)
  } else if (f.booktitle) {
    sentences.push(`"${title}."`)
    if (translatedBy) sentences.push(translatedBy)
    const editedBy = f.editor ? `, edited by ${mdEscapeText(f.editor)}` : ''
    sentences.push(`In *${mdEscapeText(f.booktitle)}*${editedBy}${f.pages ? `, ${mdEscapeText(f.pages)}` : ''}.`)
    const pubYear = [f.publisher ? mdEscapeText(f.publisher) : '', f.year ? mdEscapeText(f.year) : ''].filter(Boolean).join(', ')
    if (pubYear) sentences.push(`${pubYear}.`)
  } else if (f.publisher) {
    sentences.push(`*${title}*.`)
    if (editedByOwnSentence) sentences.push(editedByOwnSentence)
    if (translatedBy) sentences.push(translatedBy)
    sentences.push(`${[mdEscapeText(f.publisher), f.year ? mdEscapeText(f.year) : ''].filter(Boolean).join(', ')}.`)
  } else {
    sentences.push(f.year ? `*${title}*, ${mdEscapeText(f.year)}.` : `*${title}*.`)
    if (editedByOwnSentence) sentences.push(editedByOwnSentence)
  }
  sentences.push(...trailingCitationFields(f, mdEscapeText, opts).map((s) => `${s}.`))
  return sentences.join(' ')
}

/**
 * A footnote-placed citation's own body — just the first author's own
 * surname ("et al." once there's more than one), the title, and the
 * citation's own page-number/note if any — rather than a full
 * `formatCitation()`/`renderBibliographyEntry()` rendering of every field.
 * No journal name, no publisher, no ISBN/DOI/URL/bibtex-note — that fuller
 * information already lives in the References list the same source is
 * also sorted into, so a footnote only needs to identify *what* is being
 * cited. The one exception is a chapter-in-a-book entry (`booktitle`
 * set — the @inbook/@incollection case): its containing book's own title
 * is included too ("in *Book Title*"), since a chapter citation is
 * otherwise meaningless without it — a plain journal article's own venue
 * is never shown this way, only a book's.
 *
 * The title (and, for a chapter, the book title) takes the chosen
 * bibliography style's own markup convention for an article/chapter title
 * (`journal`/`booktitle` set) vs. a standalone work's title — quoted in
 * MLA/Chicago, italicized for a book in every non-plain style (including
 * APA, which otherwise never quotes an article title at all — only its
 * venue is italicized there), bare throughout for `'plain'`. Degrades the
 * same way every other formatter here does: a missing author just leaves
 * the title (and book title) on their own.
 */
function formatFootnoteCitation(entry: BibtexEntry, style: BibliographyStyle, note?: string): string {
  const f = entry.fields
  const escapedTitle = mdEscapeText(f.title || entry.key)
  const authors = parseAuthorList(f.author)
  const authorPart = authors.length === 0 ? '' : authors.length === 1 ? mdEscapeText(authors[0].last) : `${mdEscapeText(authors[0].last)} et al.`
  const isPartOfLargerWork = !!(f.journal || f.booktitle)
  const hasVenue = !!f.booktitle
  const quoteTitle = style !== 'plain' && style !== 'apa' && isPartOfLargerWork
  const italicizeTitle = style !== 'plain' && !isPartOfLargerWork
  let titlePiece: string
  if (quoteTitle) {
    titlePiece = hasVenue ? `"${escapedTitle},"` : `"${escapedTitle}."`
  } else {
    titlePiece = italicizeTitle ? `*${escapedTitle}*` : escapedTitle
    if (!hasVenue) titlePiece += '.'
  }
  let body = [authorPart, titlePiece].filter(Boolean).join(', ')
  if (hasVenue) {
    const venueText = style === 'plain' ? mdEscapeText(f.booktitle!) : `*${mdEscapeText(f.booktitle!)}*`
    body += quoteTitle ? ` in ${venueText}.` : `, in ${venueText}.`
  }
  return note ? `${body} (${mdEscapeText(note)})` : body
}

/**
 * One formatted References entry — the single function a bibliography-
 * style setting extends, mirroring `renderCitationLabel` in bibtex.ts for
 * the inline form. Always returns ready-to-use Markdown text with its own
 * escaping already done (individual field values pass through
 * `mdEscapeText` before assembly, same as `formatCitation` itself,
 * `renderPrintCitation`, et al.) — callers use the result directly
 * (`referencesMarkdown`) or run it through `inlineMarkdownToHtml`
 * (`referencesHtml`) to resolve its `*italic*` markers into real `<em>`
 * tags; neither should escape it a second time.
 */
export function renderBibliographyEntry(entry: BibtexEntry, style: BibliographyStyle = 'plain', opts: TrailingFieldsOptions = {}): string {
  switch (style) {
    case 'apa':
      return formatApaEntry(entry, opts)
    case 'mla':
      return formatMlaEntry(entry, opts)
    case 'chicago':
      return formatChicagoEntry(entry, opts)
    default:
      return formatCitation(entry, mdEscapeText, opts)
  }
}

/** Every source this essay actually cites, resolved against `sources` (silently dropping a cited id with no matching source — deleted since, or never synced) and sorted by first author/title for a stable, conventional reading order — not by insertion order, which would read as arbitrary. Exported so `ExportDialog` can derive the same `orderedSourceIds` a `'numbered'` `PrintCitationStyle` needs — both it and the References list have to agree on one order, so there's exactly one function that decides it. */
export function citedSources(nodeMap: Map<string, EssayNode>, sources: Map<string, Source>): Source[] {
  const ids = collectUsedSourceIds(nodeMap)
  return Array.from(ids)
    .map((id) => sources.get(id))
    .filter((s): s is Source => !!s)
    .sort((a, b) => (a.bibtex.fields.author || a.bibtex.fields.title || a.bibtex.key).localeCompare(b.bibtex.fields.author || b.bibtex.fields.title || b.bibtex.key))
}

/** A "## References" section — one list item per cited source — appended to `essayToMarkdown`'s own output for the plain .md export. Empty string (nothing appended at all) when the essay cites no sources. `renderBibliographyEntry`'s own result is already safe, escaped Markdown — not re-escaped here, which would double-escape a style's own `*italic*` markers into literal asterisks. */
export function referencesMarkdown(nodeMap: Map<string, EssayNode>, sources: Map<string, Source>, style: BibliographyStyle = 'plain', opts: TrailingFieldsOptions = {}): string {
  const cited = citedSources(nodeMap, sources)
  if (cited.length === 0) return ''
  const items = cited.map((s) => `- ${renderBibliographyEntry(s.bibtex, style, opts)}`)
  return `\n\n## References\n\n${items.join('\n')}\n`
}

/**
 * The print/PDF export's own References section — built and appended
 * separately from the numbered, ruled main body (`addPrintChrome`'s own
 * job), rather than flowing "## References" through that same pipeline:
 * a references list conventionally isn't numbered as "N. References"
 * alongside the essay's real sections, and isn't underlined with the
 * same per-section rule either, so it deliberately sits outside what
 * that function ever sees. Empty string when the essay cites no sources.
 *
 * `numbered` — pass `true` exactly when citations are using the
 * `'numbered'` `PrintCitationStyle`, so each entry's own list number is
 * the same `[N]` an inline citation to it points back at (a real `<ol>`,
 * not just visually numbered text, so it still renumbers correctly if a
 * citation the list would otherwise have included turns out to have no
 * matching source). Plain author-year/author-title citations have no
 * number to match, so the list stays an unordered one for those.
 *
 * Each entry goes through `inlineMarkdownToHtml` rather than a plain
 * `escapeHtml` — `renderBibliographyEntry`'s own `*italic*` markers (APA/
 * MLA/Chicago all italicize a venue or standalone title) need resolving
 * into real `<em>` tags; `inlineMarkdownToHtml` does that *and* escapes
 * everything else exactly the way `escapeHtml` alone used to.
 */
export function referencesHtml(nodeMap: Map<string, EssayNode>, sources: Map<string, Source>, style: BibliographyStyle = 'plain', numbered: boolean = false, opts: TrailingFieldsOptions = {}): string {
  const cited = citedSources(nodeMap, sources)
  if (cited.length === 0) return ''
  const items = cited.map((s) => `<li>${inlineMarkdownToHtml(renderBibliographyEntry(s.bibtex, style, opts))}</li>`)
  const tag = numbered ? 'ol' : 'ul'
  return `<h2 class="print-references-heading">References</h2><${tag} class="print-references-list">${items.join('')}</${tag}>`
}
