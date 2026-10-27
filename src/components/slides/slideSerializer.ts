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
 *
 * Slide boundaries aren't only explicit `slide_break`s: body text from two
 * different sections is never allowed onto the same slide (`walkNode`'s own
 * `acc.sectionId` check, below) — the first time a section's own content is
 * reached, a fresh slide starts automatically, exactly as if a `slide_break`
 * had been typed right there, even with no real divider in the document at
 * all.
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

/** `fragmentIndex`, here, is the *item's own* — same meaning as `BlockBodyEntry.fragmentIndex` below, just attached to one `<li>` instead of a whole top-level block, since mid-list fragmentation (`ListBodyEntry`'s own doc comment) means different items of the very same list can each belong to a different reveal step. `-1` (the default, used for every ordinary, non-top-level-list `<li>` — nothing below `renderBodyBlock`'s own generic `bullet_list`/`ordered_list` case ever passes anything else) renders a plain `<li>`, same as before this existed. */
function renderListItem(li: PMNode, sources: Map<string, Source>, fragmentIndex = -1): string {
  let inner = ''
  li.forEach((child) => (inner += renderBodyBlock(child, sources)))
  const cls = fragmentIndex === -1 ? '' : ` class="fragment" data-fragment-index="${fragmentIndex}"`
  return `<li${cls}>${inner}</li>`
}

/** One top-level block of body content plus which reveal-fragment step it belongs to — `-1` means "always visible," never wrapped in a `.fragment` div; `0, 1, 2, …` are grouped together by `renderBody` below. */
interface BlockBodyEntry {
  kind: 'block'
  block: PMNode
  fragmentIndex: number
}

/**
 * A top-level `bullet_list`/`ordered_list` — kept as its own `BodyEntry`
 * variant, rather than going through `BlockBodyEntry`/`renderBodyBlock`
 * like every other block, specifically so a `fragment_break` typed *inside*
 * the list (`pmSchema.ts`'s own content-expression allowance for this) can
 * split it into several reveal steps while it still renders as one single,
 * visually continuous `<ul>`/`<ol>` — never several separate list elements
 * stacked on top of each other, which is what treating each in-list
 * fragment group as its own ordinary `BlockBodyEntry` would produce.
 * `items` already carries each one's own resolved `fragmentIndex`
 * (`walkNode`'s own list-flattening below) — same `-1`-or-real-index
 * meaning as `BlockBodyEntry.fragmentIndex`, just per item instead of per
 * block, and advancing the very same shared counter, so an in-list
 * fragment group reveals in its correct place relative to whatever else
 * on the slide is also stepping through fragments.
 */
interface ListBodyEntry {
  kind: 'list'
  listType: 'bullet_list' | 'ordered_list'
  order: number
  items: { node: PMNode; fragmentIndex: number }[]
}

type BodyEntry = BlockBodyEntry | ListBodyEntry

function renderList(entry: ListBodyEntry, sources: Map<string, Source>): string {
  const tag = entry.listType === 'ordered_list' ? 'ol' : 'ul'
  const startAttr = entry.listType === 'ordered_list' && entry.order !== 1 ? ` start="${entry.order}"` : ''
  let items = ''
  for (const { node, fragmentIndex } of entry.items) items += renderListItem(node, sources, fragmentIndex)
  return `<${tag}${startAttr}>${items}</${tag}>`
}

/** A slide's own rendered body, split into the part that gets vertically centered (`html`) and a trailing citation-only paragraph, if any (`footer`) — kept separate so `renderSlide`/`renderBibliographySlide` can place `footer` as its own sibling, pinned to the slide's bottom by ordinary flow (nothing further above it reserves space for it) rather than inside the centered block itself, where it would get centered right along with everything else. */
interface RenderedBody {
  html: string
  footer: string
}

/** Renders a slide's own body — ordinary flow, except: a trailing citation-only paragraph (see above) is pulled out into `footer` instead of `html` (see `RenderedBody`'s own doc comment); a `ListBodyEntry` renders itself (`renderList`, above — already fragment-aware per item) rather than joining the grouping below; and consecutive `BlockBodyEntry` entries sharing the same (non–`-1`) `fragmentIndex` are grouped into one `.fragment` wrapper, so everything typed between two fragment breaks reveals together as a single step. */
function renderBody(entries: BodyEntry[], sources: Map<string, Source>): RenderedBody {
  let html = ''
  let footer = ''
  let i = 0
  while (i < entries.length) {
    const entry = entries[i]
    if (entry.kind === 'list') {
      html += renderList(entry, sources)
      i++
      continue
    }
    const { block, fragmentIndex } = entry
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
    let next: BodyEntry | undefined
    while (i < entries.length && (next = entries[i]).kind === 'block' && next.fragmentIndex === fragmentIndex) {
      group += renderBodyBlock(next.block, sources)
      i++
    }
    html += `<div class="fragment" data-fragment-index="${fragmentIndex}">${group}</div>`
  }
  return { html, footer }
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
      <div class="slide-body-wrap">
        <div class="slide-body bibliography-body">${entries || '<p class="muted">No sources cited in this deck yet.</p>'}</div>
      </div>
    </div>`,
    notes: '',
  }
}

/** One slide's worth of state accumulated while walking the document — flushed into a `SerializedSlide` by `renderSlide` whenever the next `slide_break` (or the end of the document) is reached. `title`/`eyebrow` are read once, at slide-start time, off whichever `section`(s) enclose it right then (see `serializeDeck`'s own `SectionContext`) — never typed directly. `sectionId` is the id of whichever `section` directly owns this slide's body content (the root section's own id for content sitting directly in it, not in any subsection) — `walkNode` compares this against each new block's own owning section to enforce that no two sections' body text ever land on the same slide, even with no explicit `slide_break` between them. */
interface SlideAccumulator {
  sectionId: string
  eyebrow: string
  title: string
  body: BodyEntry[]
}

function renderSlide(acc: SlideAccumulator, sources: Map<string, Source>): SerializedSlide {
  const body = renderBody(acc.body, sources)
  return {
    html: `<div class="slide-inner slide-layout-content">
      <div class="slide-eyebrow">${escapeHtml(acc.eyebrow)}</div>
      <h2 class="slide-title-display">${escapeHtml(acc.title)}</h2>
      <hr class="title-rule-thin" />
      <div class="slide-body-wrap">
        <div class="slide-body">${body.html}</div>
      </div>
      ${body.footer ? `<div class="slide-citation-footer">${body.footer}</div>` : ''}
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

  function startSlide(ctx: SectionContext | null, sectionId: string) {
    acc = { sectionId, eyebrow: ctx?.eyebrow ?? '', title: ctx?.title ?? '', body: [] }
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
    const ownerId: string = section.attrs.id
    section.forEach((child, _offset, index) => {
      if (index === 0) return // section_title itself, already consumed above
      walkNode(child, ctx, ownerId)
    })
  }

  function walkNode(node: PMNode, ctx: SectionContext | null, ownerId: string) {
    if (node.type.name === 'section') {
      walkSection(node, ctx, false)
      return
    }
    if (node.type.name === 'slide_break') {
      flush()
      startSlide(ctx, ownerId)
      return
    }
    // No explicit `slide_break` here, but this block belongs to a different
    // section than whatever the current slide's own body content belongs
    // to (including "no slide started yet at all") — per the "no two
    // sections' body text ever share a slide" rule, that's itself a slide
    // boundary, exactly as if a `slide_break` had been typed right here.
    if (!acc || acc.sectionId !== ownerId) {
      flush()
      startSlide(ctx, ownerId)
    }
    if (node.type.name === 'fragment_break') {
      fragmentIndex++
      return
    }
    if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
      // Flatten the list's own children here (rather than handing the whole
      // node to `renderBodyBlock`), advancing the very same shared
      // `fragmentIndex` for any `fragment_break` found *inside* it — see
      // `ListBodyEntry`'s own doc comment for why this is a distinct
      // `BodyEntry` variant rather than an ordinary block.
      const items: { node: PMNode; fragmentIndex: number }[] = []
      node.forEach((child) => {
        if (child.type.name === 'fragment_break') {
          fragmentIndex++
          return
        }
        items.push({ node: child, fragmentIndex })
      })
      acc!.body.push({ kind: 'list', listType: node.type.name as 'bullet_list' | 'ordered_list', order: (node.attrs.order as number) ?? 1, items })
      return
    }
    acc!.body.push({ kind: 'block', block: node, fragmentIndex })
  }

  // The document's own single root section (`pmSchema.ts`'s `doc: { content: 'section' }`) is just a wrapper, same as the essay editor's own convention — its own title never becomes any slide's title/eyebrow; its direct children are walked as top-level content, owned (for the "never share a slide" check above) by the root section's own id.
  walkSection(doc.firstChild!, null, true)
  flush()

  slides.push(renderBibliographySlide(citedIds, sources))
  return slides
}
