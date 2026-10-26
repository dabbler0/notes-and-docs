/**
 * Turns an essay (now one ProseMirror document — see `schema.ts`'s own
 * doc comment) into Markdown and a printable HTML rendering of that same
 * Markdown. Split cleanly into two halves, deliberately:
 *
 * - The **document-model-dependent half** (`pmEssayToMarkdown` and
 *   everything under "Markdown (PM doc -> text)" below) is genuinely new
 *   — it walks the PM doc tree directly instead of parsing HTML strings
 *   via `DOMParser`. This is the actual porting work.
 * - The **pure string/HTML half** (everything under "Markdown -> printable
 *   HTML" and "References / bibliography" below) is copied over from the
 *   real app's `lib/export.ts` **unmodified** — every one of those
 *   functions takes a Markdown string (or an HTML string already derived
 *   from one) and knows nothing about where that string came from. Since
 *   `pmEssayToMarkdown` below is written to produce the exact same
 *   Markdown shape the old `essayToMarkdown` did (same heading levels,
 *   same `[^fn<n>]`/`[^fnc<n>]` footnote-label convention, same
 *   `sup.print-footnote-ref`/`print-citation-footnote-ref` markup), the
 *   entire back half of the real export pipeline — citation styling,
 *   bibliography formatting, the period-movement pass, author
 *   attribution, Paged.js footnote floating, all of it — ports over with
 *   zero changes. That's the real payoff of keeping a Markdown
 *   intermediate representation rather than going straight from the PM
 *   doc to print HTML.
 *
 * LaTeX export isn't ported yet — same shape of work as `pmEssayToMarkdown`
 * below (a second, LaTeX-flavored walk of the PM doc), deliberately
 * deferred to keep this checkpoint focused on Markdown + print HTML.
 */
import type { Node as PMNode } from 'prosemirror-model'
import { escapeHtml } from './html'
import { citationLabel, citationLabelAuthorTitle, formatBibtex, formatCitation, trailingCitationFields, type TrailingFieldsOptions } from './bibtex'
import { renderMathHtml } from './math'
import type { BibtexEntry, Source } from './types'

// ---- Markdown (PM doc -> text) — the new, document-model-dependent half ----

export type PrintCitationStyle = 'author-year' | 'author-title' | 'numbered'
export type PrintCitationPlacement = 'inline' | 'footnote'

export interface PrintCitationOptions {
  style: PrintCitationStyle
  placement: PrintCitationPlacement
  orderedSourceIds: string[]
  bibliographyStyle?: BibliographyStyle
}

interface MarkdownFootnoteCtx {
  defs: string[]
  counter: { next: number }
  sources: Map<string, Source>
  citationOptions?: PrintCitationOptions
}

/** See `printCitationSpan`'s own doc comment in the real app — unchanged. */
function printCitationSpan(escapedText: string): string {
  return `<cite class="print-citation">${escapedText}</cite>`
}

function mdEscapeText(s: string): string {
  return s
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([*_$[\]\\])/g, '\\$1')
}

/** A citation node's own print-export rendering — `PrintCitationOptions.style`/`.placement` applied fresh against `node.attrs`, the PM-doc equivalent of the real app's `renderPrintCitation` (which read the same two values off a DOM element's `data-*` attributes instead). */
function renderPrintCitation(node: PMNode, source: Source, fnCtx: MarkdownFootnoteCtx): string {
  const opts = fnCtx.citationOptions!
  const note: string | undefined = node.attrs.note ?? undefined
  if (opts.placement === 'footnote') {
    const label = `fnc${fnCtx.counter.next++}`
    const body = formatFootnoteCitation(source.bibtex, opts.bibliographyStyle ?? 'plain', note)
    fnCtx.defs.push(`[^${label}]: ${body}`)
    return `[^${label}]`
  }
  const refNumber = opts.orderedSourceIds.indexOf(source.id) + 1
  if (opts.style === 'numbered') return printCitationSpan(mdEscapeText(note ? `[${refNumber}, ${note}]` : `[${refNumber}]`))
  const rendered = opts.style === 'author-title' ? citationLabelAuthorTitle(source.bibtex, note) : citationLabel(source.bibtex, note)
  return printCitationSpan(mdEscapeText(rendered))
}

/**
 * A `citation` node's markdown — fresh from `fnCtx.sources` every time,
 * never a cached label (see `schema.ts`'s own doc comment on `citation`).
 * When there's no `citationOptions` at all (the plain .md export path),
 * this is also where that freshness pays off over the old model: the old
 * app's plain .md export fell back to whatever label text happened to be
 * baked into the chip at insert time; there's no such text to fall back
 * to here, so it *always* renders a fresh, plain "(Author, Year)" label
 * instead — a deliberate, understood behavior change, not an oversight.
 *
 * `printCitationSpan`'s `<cite class="print-citation">` wrapper is a
 * print-pipeline-only scaffold (`ensureCitationSpacing` unwraps it again
 * later) — used *only* inside the `citationOptions` branch below, never
 * for the plain .md path, which has no such pipeline stage to ever strip
 * it back out again; wrapping it unconditionally was a real bug caught
 * live in this prototype's own Export panel (the raw `<cite ...>` tag
 * showing up as literal text in the plain Markdown output).
 */
function citationMarkdown(node: PMNode, fnCtx: MarkdownFootnoteCtx): string {
  const source = fnCtx.sources.get(node.attrs.sourceId)
  if (!fnCtx.citationOptions) {
    return source ? mdEscapeText(citationLabel(source.bibtex, node.attrs.note ?? undefined)) : mdEscapeText(`(unknown source: ${node.attrs.sourceId})`)
  }
  if (!source) return printCitationSpan(mdEscapeText(`(unknown source: ${node.attrs.sourceId})`))
  return renderPrintCitation(node, source, fnCtx)
}

/**
 * A `footnote` node's markdown — its own content is real, already-parsed
 * PM inline content (see `schema.ts`'s own doc comment), so unlike the old
 * app's `renderMarkdownFootnoteRef` there's no separate `footnotesById`
 * lookup or `DOMParser` re-parse needed at all: just walk it the same way
 * any other inline content gets walked.
 */
function footnoteMarkdown(node: PMNode, fnCtx: MarkdownFootnoteCtx): string {
  const label = `fn${fnCtx.counter.next++}`
  const contentMd = inlineContentToMarkdown(node, fnCtx).replace(/\s+/g, ' ').trim()
  fnCtx.defs.push(`[^${label}]: ${contentMd}`)
  return `[^${label}]`
}

/** One inline leaf's own markdown — a text run (escaped, with its marks applied) or one of the inline atom/content node types. Marks not yet given a markdown form (`quote_inline`, `source_link`) render as plain text for now — a real, deliberate scope cut for this checkpoint (see this file's own doc comment), not a silent gap: neither is wired to any toolbar command yet either. */
function inlineLeafToMarkdown(node: PMNode, fnCtx: MarkdownFootnoteCtx): string {
  if (node.isText) {
    let text = mdEscapeText(node.text ?? '')
    const linkMark = node.marks.find((m) => m.type.name === 'link')
    if (node.marks.some((m) => m.type.name === 'underline')) text = `<u>${text}</u>`
    if (node.marks.some((m) => m.type.name === 'em')) text = `*${text}*`
    if (node.marks.some((m) => m.type.name === 'strong')) text = `**${text}**`
    if (linkMark) text = `[${text}](${linkMark.attrs.href})`
    return text
  }
  switch (node.type.name) {
    case 'citation':
      return citationMarkdown(node, fnCtx)
    case 'footnote':
      return footnoteMarkdown(node, fnCtx)
    case 'math_inline':
      return `$${node.attrs.latex}$`
    default:
      return ''
  }
}

function inlineContentToMarkdown(parent: PMNode, fnCtx: MarkdownFootnoteCtx): string {
  let out = ''
  parent.forEach((child) => {
    out += inlineLeafToMarkdown(child, fnCtx)
  })
  return out
}

/** `bullet_list`/`ordered_list` -> one `- `/`N. ` line per `list_item`, recursing into a nested list right under its own parent item at one deeper indent — same convention (and same reasoning) as the real app's `listToMarkdown`. */
function listToMarkdown(listNode: PMNode, fnCtx: MarkdownFootnoteCtx, depth: number): string {
  const ordered = listNode.type.name === 'ordered_list'
  const indent = '  '.repeat(depth)
  const lines: string[] = []
  let n = 1
  listNode.forEach((listItem) => {
    const nested: PMNode[] = []
    const inlineParts: string[] = []
    listItem.forEach((child) => {
      if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') nested.push(child)
      else inlineParts.push(blockToMarkdown(child, fnCtx))
    })
    const marker = ordered ? `${n++}.` : '-'
    lines.push(`${indent}${marker} ${inlineParts.join(' ').trim()}`)
    for (const nestedList of nested) lines.push(listToMarkdown(nestedList, fnCtx, depth + 1))
  })
  return lines.join('\n')
}

/** One block node's own markdown — a paragraph, blockquote, list, or display-math block. Returns `''` for a node type with nothing to render as its own block (shouldn't happen for a well-formed doc, but degrades harmlessly). */
function blockToMarkdown(node: PMNode, fnCtx: MarkdownFootnoteCtx): string {
  switch (node.type.name) {
    case 'paragraph':
      return inlineContentToMarkdown(node, fnCtx)
    case 'blockquote': {
      const lines: string[] = []
      node.forEach((para) => lines.push(inlineContentToMarkdown(para, fnCtx)))
      return lines.map((l) => `> ${l}`).join('\n> \n')
    }
    case 'bullet_list':
    case 'ordered_list':
      return listToMarkdown(node, fnCtx, 0)
    case 'math_block':
      return `$$\n${node.attrs.latex}\n$$`
    default:
      return ''
  }
}

/**
 * The PM-doc equivalent of the real app's `essayToMarkdown` — same output
 * shape exactly (see this file's own doc comment), so the whole back half
 * of the pipeline below needs no changes at all. `title` is `Essay.title`
 * (kept as separate, lightweight essay metadata — the real app's own
 * lazy-loading reasons for keeping it off the document body still apply
 * unchanged under the "maximal" single-document model); `doc`'s own root
 * `section` is walked at depth 0 (its own `section_title` text is never
 * rendered — same as the old root `EssayNode.title` never was), with
 * every nested `section` one level deeper, same numbering correspondence
 * `addPrintChrome` below already expects.
 */
export function pmEssayToMarkdown(title: string, doc: PMNode, sources: Map<string, Source>, opts: { citationOptions?: PrintCitationOptions } = {}): string {
  const lines: string[] = [`# ${title}`, '']
  const fnCtx: MarkdownFootnoteCtx = { defs: [], counter: { next: 1 }, sources, citationOptions: opts.citationOptions }
  function renderSection(section: PMNode, depth: number) {
    if (depth > 0) {
      const level = '#'.repeat(Math.min(depth + 1, 6))
      lines.push(`${level} ${section.firstChild?.textContent || 'Untitled section'}`, '')
    }
    section.forEach((child, _offset, index) => {
      if (index === 0) return // section_title — handled above, or (depth 0) deliberately not rendered at all
      if (child.type.name === 'section') {
        renderSection(child, depth + 1)
      } else {
        const block = blockToMarkdown(child, fnCtx)
        if (block) lines.push(block, '')
      }
    })
  }
  renderSection(doc.firstChild!, 0)
  if (fnCtx.defs.length > 0) lines.push('---', '', ...fnCtx.defs.flatMap((d) => [d, '']))
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  )
}

/** Every source this essay actually cites — the PM-doc equivalent of the real app's `citedSources`/`collectUsedSourceIds`, which walked `EssayNode.draftContent` HTML strings via `DOMParser`; `doc.descendants()` does the same job directly against the real document model. Same sort (by first author/title) for the same stable, conventional reading order. */
export function pmCitedSources(doc: PMNode, sources: Map<string, Source>): Source[] {
  const ids = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name === 'citation') ids.add(node.attrs.sourceId)
  })
  return Array.from(ids)
    .map((id) => sources.get(id))
    .filter((s): s is Source => !!s)
    .sort((a, b) => (a.bibtex.fields.author || a.bibtex.fields.title || a.bibtex.key).localeCompare(b.bibtex.fields.author || b.bibtex.fields.title || b.bibtex.key))
}

export function sourcesToBibtex(sources: Source[]): string {
  return sources.map((s) => formatBibtex(s.bibtex)).join('\n\n') + '\n'
}

// ============================================================================
// Everything below this line is copied from the real app's `lib/export.ts`
// UNCHANGED — pure string/HTML transforms with no dependency on the
// document model (EssayNode tree *or* PM doc). See this file's own doc
// comment for why. Comments trimmed of cross-references to real-app-only
// files (ExportDialog.tsx, AuthorNoteDialog.tsx) that don't exist in this
// standalone prototype; the logic itself is untouched.
// ============================================================================

// ---- Markdown -> printable HTML ----------------------------------------

export function inlineMarkdownToHtml(text: string): string {
  const underlineSpans: string[] = []
  const withoutUnderline = text.replace(/<u>([\s\S]*?)<\/u>/g, (_, inner: string) => {
    underlineSpans.push(`<u>${inlineMarkdownToHtml(inner)}</u>`)
    return `\u0001${underlineSpans.length - 1}\u0001`
  })

  const citationSpans: string[] = []
  const withoutCitations = withoutUnderline.replace(/<cite class="print-citation">([\s\S]*?)<\/cite>/g, (_, inner: string) => {
    citationSpans.push(`<cite class="print-citation">${inlineMarkdownToHtml(inner)}</cite>`)
    return `\u0003${citationSpans.length - 1}\u0003`
  })

  const escaped: string[] = []
  const withPlaceholders = withoutCitations.replace(/\\([*_$[\]\\])/g, (_, ch: string) => {
    escaped.push(ch)
    return `\u0002${escaped.length - 1}\u0002`
  })

  const mathSpans: string[] = []
  const withMathPlaceholders = withPlaceholders.replace(/\$([^$\n]+)\$/g, (_, latex: string) => {
    mathSpans.push(renderMathHtml(latex, false))
    return `\u0000${mathSpans.length - 1}\u0000`
  })

  return escapeHtml(withMathPlaceholders)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\^([^\]]+)\]/g, (_, label: string) => {
      const citationClass = /^fnc\d+$/.test(label) ? ' print-citation-footnote-ref' : ''
      return `<sup class="print-footnote-ref${citationClass}"><a href="#fn-${label}">${footnoteDisplayNumber(label)}</a></sup>`
    })
    .replace(/\u0002(\d+)\u0002/g, (_, i: string) => escaped[Number(i)])
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => mathSpans[Number(i)])
    .replace(/\u0001(\d+)\u0001/g, (_, i: string) => underlineSpans[Number(i)])
    .replace(/\u0003(\d+)\u0003/g, (_, i: string) => citationSpans[Number(i)])
}

function footnoteDisplayNumber(label: string): string {
  const m = /^fnc?(\d+)$/.exec(label)
  return m ? m[1] : label
}

export function markdownToHtml(md: string): string {
  const out: string[] = []
  const footnoteDefs: string[] = []
  let paragraph: string[] = []
  let mathBlockLines: string[] | null = null
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
      endBlock()
      continue
    }
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
  if (mathBlockLines !== null) out.push(renderMathHtml(mathBlockLines.join('\n'), true))
  endBlock()
  if (footnoteDefs.length > 0) out.push('<hr>', `<ol class="print-footnotes">${footnoteDefs.join('')}</ol>`)
  return out.join('\n')
}

function isAbstractTitle(title: string | undefined): boolean {
  return (title ?? '').trim() === 'Abstract'
}

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
    const depth = level - 1
    counters[depth - 1] = (counters[depth - 1] ?? 0) + 1
    counters.length = depth
    heading.prepend(`${counters.join('.')} `)
    if (level === 2) heading.after(hr('print-section-rule'))
  }
  if (abstractHeading) renderAbstractSection(doc, abstractHeading)
  return doc.body.innerHTML
}

export function addAuthorAttribution(bodyHtml: string, authorName: string, authorNote?: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  const h1 = doc.body.querySelector('h1')
  if (!h1) return bodyHtml
  const p = doc.createElement('p')
  p.className = 'print-author'
  p.appendChild(doc.createTextNode(authorName))
  const note = authorNote?.trim()
  if (note) {
    const sup = doc.createElement('sup')
    sup.className = 'print-footnote-ref'
    const a = doc.createElement('a')
    a.setAttribute('href', '#fn-authornote')
    a.textContent = '*'
    sup.appendChild(a)
    p.appendChild(sup)
    let list = doc.body.querySelector('ol.print-footnotes')
    if (!list) {
      doc.body.appendChild(doc.createElement('hr'))
      list = doc.createElement('ol')
      list.className = 'print-footnotes'
      doc.body.appendChild(list)
    }
    const li = doc.createElement('li')
    li.id = 'fn-authornote'
    li.innerHTML = note
      .split('\n')
      .map((line) => inlineMarkdownToHtml(line))
      .join('<br>')
    list.insertBefore(li, list.firstChild)
  }
  h1.after(p)
  return doc.body.innerHTML
}

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

export function moveFootnoteCitationsPastPeriod(bodyHtml: string): string {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html')
  const isCitationMarker = (n: ChildNode | null): n is Element => !!n && n.nodeType === Node.ELEMENT_NODE && (n as Element).matches('sup.print-citation-footnote-ref')
  const markers = Array.from(doc.body.querySelectorAll('sup.print-citation-footnote-ref'))
  for (const marker of markers) {
    if (isCitationMarker(marker.previousSibling)) continue
    const run: Element[] = [marker]
    let cursor: ChildNode | null = marker.nextSibling
    while (isCitationMarker(cursor)) {
      run.push(cursor)
      cursor = cursor.nextSibling
    }
    if (!cursor || cursor.nodeType !== Node.TEXT_NODE) continue
    const text = cursor.textContent ?? ''
    const m = /^\s*\.(\s|$)/.exec(text)
    if (!m) continue
    run[0].before(doc.createTextNode('.'))
    cursor.textContent = text.slice(m[0].length - m[1].length)
  }
  return doc.body.innerHTML
}

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

// ---- References / bibliography -----------------------------------------

export type BibliographyStyle = 'plain' | 'apa' | 'mla' | 'chicago'

interface ParsedAuthor {
  last: string
  first: string
}

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

function formatAuthorsApa(authors: ParsedAuthor[]): string {
  const names = authors.map((a) => (a.first ? `${a.last}, ${initials(a.first)}` : a.last))
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`
}

function formatAuthorsNameOrder(authors: ParsedAuthor[]): string {
  if (authors.length === 0) return ''
  if (authors.length === 1) return authorFull(authors[0], true)
  if (authors.length === 2) return `${authorFull(authors[0], true)}, and ${authorFull(authors[1], false)}`
  return `${authorFull(authors[0], true)}, et al.`
}

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

function formatMlaEntry(entry: BibtexEntry, opts: TrailingFieldsOptions = {}): string {
  const f = entry.fields
  const authors = formatAuthorsNameOrder(parseAuthorList(f.author))
  const title = mdEscapeText(f.title || entry.key)
  const translatedBy = f.translator ? `translated by ${mdEscapeText(f.translator)}` : ''
  const editedBy = f.editor ? `edited by ${mdEscapeText(f.editor)}` : ''
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

function formatChicagoEntry(entry: BibtexEntry, opts: TrailingFieldsOptions = {}): string {
  const f = entry.fields
  const authors = formatAuthorsNameOrder(parseAuthorList(f.author))
  const title = mdEscapeText(f.title || entry.key)
  const translatedBy = f.translator ? `Translated by ${mdEscapeText(f.translator)}.` : ''
  const editedByOwnSentence = f.editor ? `Edited by ${mdEscapeText(f.editor)}.` : ''
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

export function referencesMarkdown(cited: Source[], style: BibliographyStyle = 'plain', opts: TrailingFieldsOptions = {}): string {
  if (cited.length === 0) return ''
  const items = cited.map((s) => `- ${renderBibliographyEntry(s.bibtex, style, opts)}`)
  return `\n\n## References\n\n${items.join('\n')}\n`
}

export function referencesHtml(cited: Source[], style: BibliographyStyle = 'plain', numbered: boolean = false, opts: TrailingFieldsOptions = {}): string {
  if (cited.length === 0) return ''
  const items = cited.map((s) => `<li>${inlineMarkdownToHtml(renderBibliographyEntry(s.bibtex, style, opts))}</li>`)
  const tag = numbered ? 'ol' : 'ul'
  return `<h2 class="print-references-heading">References</h2><${tag} class="print-references-list">${items.join('')}</${tag}>`
}
