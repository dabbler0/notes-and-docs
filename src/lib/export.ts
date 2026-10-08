/**
 * Turns an essay's node tree into other formats for export: Markdown, a
 * printable HTML rendering of that same Markdown (for "export to PDF" via
 * the browser's own print dialog), and a LaTeX project. All three walk the
 * tree the same way SectionBlock renders it — parseSegments() on each
 * node's own draftContent, recursing into embedded children in document
 * order — so what's exported matches what's on screen, not some separate
 * frozen/versioned snapshot.
 */
import { parseSegments } from './childMarkers'
import { escapeHtml } from './html'
import { formatBibtex } from './bibtex'
import { renderMathHtml } from './math'
import { nodeFootnotes } from '../models/essaysRepo'
import type { Essay, EssayNode, Source } from '../models/types'

// ---- Markdown --------------------------------------------------------

/** Threaded through a node's own conversion so a `sup.footnote-ref` marker can look up its footnote's content (`node.footnotes`, resolved by the caller) and mint a globally-unique `[^label]` — unique across the *whole* document, not just this node, since Markdown footnote labels are matched document-wide by any real Markdown processor regardless of which section "owns" them; reusing per-node-local numbers as labels would silently conflate two different essay's-worth of footnotes that both happened to be "footnote 1." `defs` collects each one's own `[^label]: content` line, in the order encountered, to append once at the very end. */
interface MarkdownFootnoteCtx {
  footnotesById: Map<string, string>
  defs: string[]
  counter: { next: number }
}

function inlineHtmlToMarkdown(node: Node, fnCtx: MarkdownFootnoteCtx): string {
  if (node.nodeType === Node.TEXT_NODE) return mdEscapeText(node.textContent || '')
  if (node.nodeType !== Node.ELEMENT_NODE) return ''
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const inner = () => Array.from(el.childNodes).map((n) => inlineHtmlToMarkdown(n, fnCtx)).join('')
  if (tag === 'sup' && el.classList.contains('footnote-ref')) {
    return renderMarkdownFootnoteRef(el.getAttribute('data-footnote-id'), fnCtx)
  }
  if (tag === 'span' && el.classList.contains('math-inline')) {
    return `$${el.getAttribute('data-latex') ?? ''}$`
  }
  switch (tag) {
    case 'b':
    case 'strong':
      return `**${inner()}**`
    case 'i':
    case 'em':
      return `*${inner()}*`
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
  // `$` is escaped here too, alongside the usual Markdown-significant
  // characters — essayToMarkdown's own equation markers use bare `$...$`/
  // `$$...$$` (see inlineHtmlToMarkdown/htmlToMarkdownBlocks), so an
  // ordinary dollar amount typed as plain prose ("it costs $5") has to be
  // escaped the same way a literal `*` or `_` already is, or it would read
  // back as unintended inline math the moment markdownToHtml parses it
  // again for the PDF export path.
  return s.replace(/([*_$[\]\\])/g, '\\$1')
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

export function essayToMarkdown(essay: Essay, nodeMap: Map<string, EssayNode>): string {
  const lines: string[] = [`# ${essay.title}`, '']
  const fnCtx: MarkdownFootnoteCtx = { footnotesById: new Map(), defs: [], counter: { next: 1 } }
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

  // mdEscapeText() backslash-escapes literal *, _, $, [, ], \ so a stray
  // character in ordinary typed text can't be mistaken for real markdown
  // syntax — but the naive bold/italic/link patterns below don't know
  // that, and would happily match a "*" they find sitting right after a
  // backslash. So pull every escaped character out into a placeholder
  // *before* running those patterns, and put the literal character back
  // afterward, once nothing can misread it.
  const escaped: string[] = []
  const withPlaceholders = withoutUnderline.replace(/\\([*_$[\]\\])/g, (_, ch: string) => {
    escaped.push(ch)
    return ` ${escaped.length - 1} `
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
    .replace(/ (\d+) /g, (_, i: string) => escaped[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => mathSpans[Number(i)])
    .replace(/\u0001(\d+)\u0001/g, (_, i: string) => underlineSpans[Number(i)])
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

// ---- LaTeX -------------------------------------------------------------

const SECTION_CMDS = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph']
function sectionCmd(depth: number): string {
  return SECTION_CMDS[Math.min(depth - 1, SECTION_CMDS.length - 1)]
}

function texEscape(s: string): string {
  return s
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
    return `${ctx.citeCmd}{${key}}`
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
  function renderNode(node: EssayNode, depth: number) {
    if (depth > 0) {
      body.push(`\\${sectionCmd(depth)}{${texEscape(node.title || 'Untitled section')}}`, '')
    }
    for (const footnote of nodeFootnotes(node)) ctx.footnotesById.set(footnote.id, footnote.content)
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
  const root = nodeMap.get(essay.rootNodeId)
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
