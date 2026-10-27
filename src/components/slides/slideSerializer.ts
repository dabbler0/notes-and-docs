import type { Node as PMNode } from 'prosemirror-model'
import { citationLabel, formatCitation } from '../../lib/bibtex'
import type { Source } from '../../models/types'

/**
 * Turns an `essaySchema`-shaped PM document (`pmSchema.ts`) — a slideshow's
 * doc is a strict superset of the essay format, just one that also uses
 * `slide_break`/`fragment_break` dividers — into an array of reveal.js
 * `<section>` inner-HTML strings, one per slide, in order, for
 * `SlidePresenter.tsx` to drop straight into `.reveal > .slides`.
 *
 * Per explicit scope: special formatting only for `blockquote` and
 * `citation`; everything else in the essay vocabulary (marks, lists,
 * footnotes, math, links) gets a generic, reasonable passthrough rather
 * than its own bespoke slide treatment. Not `DOMSerializer.fromSchema` for
 * the same reason `pmCommands.ts`'s own `sliceToHtml` doesn't try to reuse
 * one for a `citation` node either — a citation's schema-level `toDOM` is
 * just its bare attrs; the real, human-readable label only exists by
 * resolving `sourceId` against the live `sources` map.
 *
 * Each slide's own title comes from "the immediate section header" — the
 * innermost `section` enclosing its `slide_break` — never from a
 * slide-specific title field, since this schema has none.
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(node: PMNode, sources: Map<string, Source>): string {
  let out = ''
  node.forEach((child) => {
    if (child.isText) {
      let text = escapeHtml(child.text ?? '')
      for (const mark of child.marks) {
        if (mark.type.name === 'strong') text = `<strong>${text}</strong>`
        else if (mark.type.name === 'em') text = `<em>${text}</em>`
        else if (mark.type.name === 'underline') text = `<u>${text}</u>`
        else if (mark.type.name === 'quote_inline') text = `<q>${text}</q>`
        else if (mark.type.name === 'link' || mark.type.name === 'source_link') text = `<a href="${escapeHtml(mark.attrs.href ?? '#')}">${text}</a>`
      }
      out += text
    } else if (child.type.name === 'citation') {
      out += renderCitationLabel(child, sources)
    } else if (child.type.name === 'hard_break') {
      out += '<br/>'
    } else if (child.type.name === 'footnote') {
      out += `<sup class="slide-footnote-marker">${renderInline(child, sources)}</sup>`
    } else if (child.type.name === 'math_inline') {
      out += `<span class="slide-math">${escapeHtml(child.attrs.latex ?? '')}</span>`
    }
  })
  return out
}

function renderCitationLabel(citation: PMNode, sources: Map<string, Source>): string {
  const source = sources.get(citation.attrs.sourceId)
  if (!source) return `<span class="slide-citation-missing">(unknown source)</span>`
  return `<span class="slide-citation-label">${escapeHtml(citationLabel(source.bibtex, citation.attrs.note ?? undefined))}</span>`
}

/** A paragraph whose only real content is a single `citation` node — any surrounding text has to be whitespace-only, since `pmCommands.ts`'s own `insertCitation` always leaves a trailing space after one for normal mid-sentence typing to continue into — rendered as the slide's own bottom-aligned attribution line rather than as ordinary body text. */
function citationOnlyParagraph(node: PMNode): PMNode | null {
  if (node.type.name !== 'paragraph') return null
  let found: PMNode | null = null
  let ok = true
  node.forEach((child) => {
    if (child.type.name === 'citation' && !found) found = child
    else if (!(child.isText && !(child.text ?? '').trim())) ok = false
  })
  return ok ? found : null
}

/** Generic passthrough rendering for everything except blockquote/citation — paragraphs, lists, math blocks. Nested `section`s shouldn't normally appear inside a slide's own body (a section boundary is where the enclosing title/eyebrow comes from — see `walkSection` below), but render their content plainly rather than silently dropping it if one ever does. */
function renderBodyBlock(node: PMNode, sources: Map<string, Source>): string {
  switch (node.type.name) {
    case 'paragraph':
      return `<p>${renderInline(node, sources)}</p>`
    case 'blockquote': {
      let inner = ''
      node.forEach((p) => (inner += renderBodyBlock(p, sources)))
      return `<blockquote>${inner}</blockquote>`
    }
    case 'bullet_list': {
      let items = ''
      node.forEach((li) => (items += renderListItem(li, sources)))
      return `<ul>${items}</ul>`
    }
    case 'ordered_list': {
      let items = ''
      node.forEach((li) => (items += renderListItem(li, sources)))
      const start = node.attrs.order && node.attrs.order !== 1 ? ` start="${node.attrs.order}"` : ''
      return `<ol${start}>${items}</ol>`
    }
    case 'math_block':
      return `<div class="slide-math slide-math-block">${escapeHtml(node.attrs.latex ?? '')}</div>`
    case 'section': {
      let inner = ''
      node.forEach((child, _o, index) => {
        if (index === 0) return
        inner += renderBodyBlock(child, sources)
      })
      return inner
    }
    default:
      return ''
  }
}

function renderListItem(li: PMNode, sources: Map<string, Source>): string {
  let inner = ''
  li.forEach((child) => (inner += renderBodyBlock(child, sources)))
  return `<li>${inner}</li>`
}

/** One block of body content plus which reveal-fragment step it belongs to — `-1` means "always visible," never wrapped in a `.fragment` div; `0, 1, 2, …` are grouped together by `renderBody` below. */
interface BodyEntry {
  block: PMNode
  fragmentIndex: number
}

/** Renders a slide's own body — ordinary flow, except: a trailing citation-only paragraph (see above) renders separately as `.slide-citation-footer` so the theme CSS can pin it to the slide's bottom regardless of how much content sits above it; and consecutive entries sharing the same (non–`-1`) `fragmentIndex` are grouped into one `.fragment` wrapper, so everything typed between two fragment breaks reveals together as a single step. */
function renderBody(entries: BodyEntry[], sources: Map<string, Source>): string {
  let html = ''
  let footer = ''
  let i = 0
  while (i < entries.length) {
    const { block, fragmentIndex } = entries[i]
    const citation = citationOnlyParagraph(block)
    if (citation && fragmentIndex === -1) {
      footer += renderCitationLabel(citation, sources)
      i++
      continue
    }
    if (fragmentIndex === -1) {
      html += renderBodyBlock(block, sources)
      i++
      continue
    }
    // Group every consecutive entry sharing this same fragment index into one wrapper.
    let group = ''
    while (i < entries.length && entries[i].fragmentIndex === fragmentIndex) {
      group += renderBodyBlock(entries[i].block, sources)
      i++
    }
    html += `<div class="fragment" data-fragment-index="${fragmentIndex}">${group}</div>`
  }
  if (footer) html += `<div class="slide-citation-footer">${footer}</div>`
  return html
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  let out = ''
  let rest = n
  for (const [value, symbol] of table) {
    while (rest >= value) {
      out += symbol
      rest -= value
    }
  }
  return out || String(n)
}

/** Every `citation` node's `sourceId` anywhere in the whole deck, in first-appearance order (deduped) — what the auto-generated bibliography slide's own body is built from. */
function collectCitedSourceIds(doc: PMNode): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  doc.descendants((node) => {
    if (node.type.name === 'citation' && !seen.has(node.attrs.sourceId)) {
      seen.add(node.attrs.sourceId)
      ids.push(node.attrs.sourceId)
    }
  })
  return ids
}

export interface SerializedSlide {
  html: string
  notes: string
}

/** The deck's own fixed opening slide — generated fresh every time from `Slideshow.title` and the globally configured author name (`lib/authorPreference.ts`), never stored as real document content. */
function renderTitleSlide(deckTitle: string, authorName: string): SerializedSlide {
  return {
    html: `<div class="slide-inner slide-layout-title">
      <div class="title-rule"></div>
      <h1 class="deck-title">${escapeHtml(deckTitle)}</h1>
      <div class="title-rule"></div>
      ${authorName ? `<div class="deck-authors">${escapeHtml(authorName)}</div>` : ''}
    </div>`,
    notes: '',
  }
}

/** The deck's own fixed closing slide — generated fresh every time from every citation used anywhere in the deck (`collectCitedSourceIds`), never stored as real document content. */
function renderBibliographySlide(citedIds: string[], sources: Map<string, Source>): SerializedSlide {
  const entries = citedIds
    .map((sid) => sources.get(sid))
    .filter((s): s is Source => !!s)
    .map((s) => `<p class="bibliography-entry">${escapeHtml(formatCitation(s.bibtex))}</p>`)
    .join('')
  return {
    html: `<div class="slide-inner slide-layout-content">
      <div class="slide-eyebrow"></div>
      <h2 class="slide-title-display">References</h2>
      <hr class="title-rule-thin" />
      <div class="slide-body bibliography-body">${entries || '<p class="muted">No sources cited in this deck yet.</p>'}</div>
    </div>`,
    notes: '',
  }
}

/** One slide's worth of state accumulated while walking the document — flushed into a `SerializedSlide` by `renderSlide` whenever the next `slide_break` (or the end of the document) is reached. `title`/`eyebrow` are read once, at `slide_break` time, off whichever `section`(s) enclose it right then (see `serializeDeck`'s own `SectionContext`) — never typed directly. */
interface SlideAccumulator {
  eyebrow: string
  title: string
  body: BodyEntry[]
}

function renderSlide(acc: SlideAccumulator, sources: Map<string, Source>): SerializedSlide {
  return {
    html: `<div class="slide-inner slide-layout-content">
      <div class="slide-eyebrow">${escapeHtml(acc.eyebrow)}</div>
      <h2 class="slide-title-display">${escapeHtml(acc.title)}</h2>
      <hr class="title-rule-thin" />
      <div class="slide-body">${renderBody(acc.body, sources)}</div>
    </div>`,
    notes: '',
  }
}

/** What a `slide_break` reads its own title/eyebrow off of — the *immediate* enclosing section's own title is the slide's title; the *outermost* enclosing section under the document's own single root — the root itself is just a wrapper, same convention as the essay editor's own un-numbered root — gets a numbered "eyebrow" shown on every slide inside it. Both empty for a slide_break sitting directly in the root with no other section around it. */
interface SectionContext {
  title: string
  eyebrow: string
}

export function serializeDeck(doc: PMNode, sources: Map<string, Source>, deckTitle: string, authorName: string): SerializedSlide[] {
  const citedIds = collectCitedSourceIds(doc)
  const slides: SerializedSlide[] = [renderTitleSlide(deckTitle, authorName)]

  let acc: SlideAccumulator | null = null
  let fragmentIndex = -1
  let topSectionCount = 0

  function flush() {
    if (!acc) return
    slides.push(renderSlide(acc, sources))
  }

  function startSlide(ctx: SectionContext | null) {
    acc = { eyebrow: ctx?.eyebrow ?? '', title: ctx?.title ?? '', body: [] }
    fragmentIndex = -1
  }

  /** `isTopLevel`: true for the document's own single root section (unnumbered, title discarded — just a wrapper, same convention `SectionView`'s own number-path logic already uses for it), false for every section nested inside it (gets a title; its own *direct* children of the root additionally start a new numbered eyebrow). */
  function walkSection(section: PMNode, parentCtx: SectionContext | null, isRoot: boolean) {
    const title = section.firstChild?.textContent ?? ''
    let ctx: SectionContext | null
    if (isRoot) {
      ctx = null
    } else if (!parentCtx) {
      topSectionCount++
      ctx = { title, eyebrow: `${toRoman(topSectionCount)}. ${title.toUpperCase()}` }
    } else {
      ctx = { title, eyebrow: parentCtx.eyebrow }
    }
    section.forEach((child, _offset, index) => {
      if (index === 0) return // section_title itself, already consumed above
      walkNode(child, ctx)
    })
  }

  function walkNode(node: PMNode, ctx: SectionContext | null) {
    if (node.type.name === 'section') {
      walkSection(node, ctx, false)
      return
    }
    if (node.type.name === 'slide_break') {
      flush()
      startSlide(ctx)
      return
    }
    if (!acc) startSlide(ctx) // defensive: content before any slide_break at all
    if (node.type.name === 'fragment_break') {
      fragmentIndex++
      return
    }
    acc!.body.push({ block: node, fragmentIndex })
  }

  // The document's own single root section (`pmSchema.ts`'s `doc: { content: 'section' }`) is just a wrapper, same as the essay editor's own convention — its own title never becomes any slide's title/eyebrow; its direct children are walked as top-level content.
  walkSection(doc.firstChild!, null, true)
  flush()

  slides.push(renderBibliographySlide(citedIds, sources))
  return slides
}
