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
  switch (tag) {
    case 'b':
    case 'strong':
      return `**${inner()}**`
    case 'i':
    case 'em':
      return `*${inner()}*`
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
  return s.replace(/([*_[\]\\])/g, '\\$1')
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
  // mdEscapeText() backslash-escapes literal *, _, [, ], \ so a stray
  // character in ordinary typed text can't be mistaken for real markdown
  // syntax — but the naive bold/italic/link patterns below don't know
  // that, and would happily match a "*" they find sitting right after a
  // backslash. So pull every escaped character out into a placeholder
  // *before* running those patterns, and put the literal character back
  // afterward, once nothing can misread it.
  const escaped: string[] = []
  const withPlaceholders = text.replace(/\\([*_[\]\\])/g, (_, ch: string) => {
    escaped.push(ch)
    return ` ${escaped.length - 1} `
  })
  return escapeHtml(withPlaceholders)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\^([^\]]+)\]/g, (_, label: string) => `<sup class="print-footnote-ref"><a href="#fn-${label}">${footnoteDisplayNumber(label)}</a></sup>`)
    .replace(/ (\d+) /g, (_, i: string) => escaped[Number(i)])
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
  const flush = () => {
    if (paragraph.length) {
      out.push(`<p>${inlineMarkdownToHtml(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  for (const line of md.split('\n')) {
    const footnoteDef = line.match(/^\[\^([^\]]+)\]:\s*(.*)$/)
    if (footnoteDef) {
      flush()
      footnoteDefs.push(`<li id="fn-${footnoteDef[1]}">${inlineMarkdownToHtml(footnoteDef[2])}</li>`)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flush()
      const level = heading[1].length
      out.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      flush()
      out.push(`<blockquote>${inlineMarkdownToHtml(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (line.trim() === '---') {
      // essayToMarkdown()'s own separator right before its footnote
      // definitions — meaningless as a paragraph on its own; the <hr>
      // below already marks that transition visually once footnoteDefs
      // actually has anything in it.
      flush()
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
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
  switch (tag) {
    case 'b':
    case 'strong':
      return `\\textbf{${inner()}}`
    case 'i':
    case 'em':
      return `\\textit{${inner()}}`
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
