import type { Node as PMNode } from 'prosemirror-model'
import { citationLabel, formatCitation } from '../../lib/bibtex'
import type { Source } from '../../models/types'

/**
 * Turns a `slideSchema`-shaped PM document into an array of reveal.js
 * `<section>` inner-HTML strings — one per slide, in order — for
 * `SlidePresenter.tsx` to drop straight into `.reveal > .slides`. This is
 * deliberately a bespoke small walker, not `DOMSerializer.fromSchema` (the
 * way `pmCommands.ts`'s own `sliceToHtml` uses it for essays): a
 * `citation` node's schema-level `toDOM` is just its bare attrs (see
 * `slideSchema.ts`) — the real, human-readable label only exists by
 * resolving `sourceId` against the live `sources` map, exactly the same
 * "always re-derived, never baked in" rule `pmNodeViews.ts`'s `CitationView`
 * already follows for the live editor — so every citation has to be
 * resolved here too, which a generic schema-driven serializer has no way
 * to do on its own.
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
      }
      out += text
    } else if (child.type.name === 'citation') {
      out += renderCitationLabel(child, sources)
    }
  })
  return out
}

function renderCitationLabel(citation: PMNode, sources: Map<string, Source>): string {
  const source = sources.get(citation.attrs.sourceId)
  if (!source) return `<span class="slide-citation-missing">(unknown source)</span>`
  return `<span class="slide-citation-label">${escapeHtml(citationLabel(source.bibtex, citation.attrs.note ?? undefined))}</span>`
}

/** A paragraph whose only real content is a single `citation` node — any surrounding text has to be whitespace-only, since `slideCommands.ts`'s own `insertCitation` always leaves a trailing space after one for normal mid-sentence typing to continue into — rendered as the slide's own bottom-aligned attribution line (see `renderBody`) rather than as ordinary body text, the same visual role the attached Beamer deck's own small citation lines under a quote play. */
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

function renderBodyBlock(node: PMNode, sources: Map<string, Source>): string {
  switch (node.type.name) {
    case 'paragraph':
      return `<p>${renderInline(node, sources)}</p>`
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
    default:
      return ''
  }
}

function renderListItem(li: PMNode, sources: Map<string, Source>): string {
  let inner = ''
  li.forEach((child) => (inner += renderBodyBlock(child, sources)))
  return `<li>${inner}</li>`
}

/** Renders a `content`/`quote`-shaped slide's own body blocks — ordinary flow, except a trailing citation-only paragraph (see above), which renders separately as `.slide-citation-footer` so the theme CSS can pin it to the bottom of the slide regardless of how much body content sits above it. */
function renderBody(blocks: PMNode[], sources: Map<string, Source>): string {
  let html = ''
  let footer = ''
  for (const block of blocks) {
    const citation = citationOnlyParagraph(block)
    if (citation) {
      footer += renderCitationLabel(citation, sources)
      continue
    }
    html += renderBodyBlock(block, sources)
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

/** Every `citation` node's `sourceId` anywhere in the whole deck, in first-appearance order (deduped) — what a `bibliography`-layout slide's own body is generated from, regardless of what (if anything) is actually sitting in its content. */
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
  /** Reveal.js's own speaker-notes convention (`<aside class="notes">`) has no counterpart in this schema yet — reserved for later, left empty for now rather than omitting the field and having every call site guess. */
  notes: string
}

export function serializeDeck(doc: PMNode, sources: Map<string, Source>): SerializedSlide[] {
  const citedIds = collectCitedSourceIds(doc)
  const slides: SerializedSlide[] = []
  let eyebrow = ''
  let sectionCount = 0

  doc.forEach((slide) => {
    const layout = (slide.attrs.layout as string) || 'content'
    const title = slide.firstChild?.type.name === 'slide_title' ? (slide.firstChild.textContent ?? '') : ''
    const bodyBlocks: PMNode[] = []
    slide.forEach((child, _offset, index) => {
      if (index === 0 && child.type.name === 'slide_title') return
      bodyBlocks.push(child)
    })

    if (layout === 'section') {
      sectionCount++
      eyebrow = `${toRoman(sectionCount)}. ${title.toUpperCase()}`
      slides.push({ html: `<div class="slide-inner slide-layout-section"><h1 class="section-title-display">${escapeHtml(title)}</h1></div>`, notes: '' })
      return
    }

    if (layout === 'title') {
      const subtitlePara = bodyBlocks[0]
      const authorParas = bodyBlocks.slice(1)
      const subtitle = subtitlePara ? renderInline(subtitlePara, sources) : ''
      const authors = authorParas.map((p) => renderInline(p, sources)).join('<br>')
      slides.push({
        html: `<div class="slide-inner slide-layout-title">
          <div class="title-rule"></div>
          <h1 class="deck-title">${escapeHtml(title)}</h1>
          ${subtitle ? `<div class="deck-subtitle">${subtitle}</div>` : ''}
          <div class="title-rule"></div>
          ${authors ? `<div class="deck-authors">${authors}</div>` : ''}
        </div>`,
        notes: '',
      })
      return
    }

    if (layout === 'bibliography') {
      const entries = citedIds
        .map((sid) => sources.get(sid))
        .filter((s): s is Source => !!s)
        .map((s) => `<p class="bibliography-entry">${escapeHtml(formatCitation(s.bibtex))}</p>`)
        .join('')
      slides.push({
        html: `<div class="slide-inner slide-layout-content">
          <div class="slide-eyebrow">${escapeHtml(eyebrow)}</div>
          <h2 class="slide-title-display">${escapeHtml(title || 'References')}</h2>
          <hr class="title-rule-thin" />
          <div class="slide-body bibliography-body">${entries || '<p class="muted">No sources cited in this deck yet.</p>'}</div>
        </div>`,
        notes: '',
      })
      return
    }

    // 'content' (default) and anything unrecognized falls back to it.
    slides.push({
      html: `<div class="slide-inner slide-layout-content">
        <div class="slide-eyebrow">${escapeHtml(eyebrow)}</div>
        <h2 class="slide-title-display">${escapeHtml(title)}</h2>
        <hr class="title-rule-thin" />
        <div class="slide-body">${renderBody(bodyBlocks, sources)}</div>
      </div>`,
      notes: '',
    })
  })

  return slides
}
