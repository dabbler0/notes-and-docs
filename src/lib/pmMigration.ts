/**
 * One-way, read-only conversion from the old per-node HTML model
 * (`EssayNode`/`Essay.rootNodeId`) into the new "maximal" single-ProseMirror-
 * document model (`lib/pmSchema.ts`). Ported from the standalone prototype
 * (`pm-editor/src/migrate.ts` on this same branch), already proven there
 * against real backup data — every bug found and fixed while building it
 * (whitespace/paragraph-break fidelity, essay-title-vs-root-node-title, a
 * blockquote nested inside a wrapping `<div>`, graveyard fragments) carries
 * over unchanged here, just against the real `Essay`/`EssayNode`/`Comment`/
 * `Source`/`GraveyardFragment` types and the real, already-existing
 * `getChildIds`/`parseSegments` (`childMarkers.ts`) and
 * `extractLegacyCitationNote` (`bibtex.ts`) instead of the prototype's own
 * trimmed stand-ins.
 *
 * This is the single most consequential piece of the whole migration —
 * every essay the real app ever produced has to survive it with nothing
 * lost that the new schema can actually represent, and an honest, visible
 * warning for anything it can't.
 *
 * Nothing in this file runs automatically yet — see `migrateEssayHistory`'s
 * own doc comment for why wiring either this or that into
 * `storage/migrationRegistry.ts`/`sync/remoteMigrationRegistry.ts` is
 * deliberately deferred to the later phase that actually swaps the UI over
 * to read `Essay.doc`.
 *
 * Structure mirrors `export.ts`'s own Markdown walk closely on purpose
 * (same segment-by-segment, text-vs-child handling, same inline-mark
 * recognition) — reading that file first makes this one easier to follow,
 * since both are solving "walk this HTML and reinterpret it structurally,"
 * just in opposite directions.
 */
import { getChildIds, parseSegments } from './childMarkers'
import { extractLegacyCitationNote } from './bibtex'
import { id } from './id'
import { diffSnapshots, reconstructSnapshot } from './essayHistory'
import type { Comment, Essay, EssayCommitEntry, EssayNode, EssaySnapshot, GraveyardFragment, Source } from '../models/types'

/** Loose on purpose — this file only ever builds plain JSON objects matching `pmSchema.ts`'s own shape, checked for real by round-tripping through `Node.fromJSON(essaySchema, ...)` in tests, not by a parallel hand-maintained TypeScript type here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PMJson = any

export interface MigratedEssay {
  title: string
  /** A `doc` node's own JSON — `Node.fromJSON(essaySchema, doc)` once this is actually loaded into an editor. */
  doc: PMJson
  /** Every comment this essay's nodes carried, flattened into one array — see `Comment`'s own doc comment in `models/types.ts` for why `sectionId` exists. */
  comments: Comment[]
  /** Human-readable, non-fatal notes about anything degraded or dropped along the way (a missing source, a cycle, block structure a footnote can't hold, …) — never thrown; a migration always produces *something*, with every compromise it made written down instead of hidden. */
  warnings: string[]
}

/** Walks from `essay.rootNodeId` the same way the real app's own `loadNodeMap` (`essaysRepo.ts`) does — skipping a missing or `deleted` node (and everything only reachable through it) entirely, same as live use already does. */
export function buildLegacyNodeMap(essay: Pick<Essay, 'rootNodeId'>, nodes: EssayNode[]): Map<string, EssayNode> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const map = new Map<string, EssayNode>()
  const stack = [essay.rootNodeId]
  while (stack.length) {
    const nid = stack.pop()!
    if (map.has(nid)) continue
    const node = byId.get(nid)
    if (!node || node.deleted) continue
    map.set(nid, node)
    stack.push(...getChildIds(node.draftContent))
  }
  return map
}

interface MigrateCtx {
  nodeMap: Map<string, EssayNode>
  sources: Map<string, Source>
  warnings: string[]
  comments: Comment[]
  /** Nodes currently being converted, root-to-here — a real cycle (a child marker pointing back at one of its own ancestors, which should never happen from the live editor but is cheap to guard against in data this migration doesn't otherwise control) stops recursing into itself rather than hanging. */
  seenNodeIds: Set<string>
  /** Whichever node is currently being walked — footnote refs resolve against *this* node's own `footnotes` array (never any other node's, matching the real app's own per-node footnote scoping), kept here rather than threaded as a parameter through every inline-walking function. */
  currentNode: EssayNode
}

export function migrateEssay(essay: Pick<Essay, 'title' | 'rootNodeId'>, allNodes: EssayNode[], sources: Map<string, Source>): MigratedEssay {
  const nodeMap = buildLegacyNodeMap(essay, allNodes)
  const warnings: string[] = []
  const comments: Comment[] = []
  const root = nodeMap.get(essay.rootNodeId)
  if (!root) {
    warnings.push(`This essay's own root section (${essay.rootNodeId}) is missing or was deleted — produced an empty document instead of losing the essay entirely.`)
    return { title: essay.title, doc: { type: 'doc', content: [emptySection(id(), essay.title)] }, comments, warnings }
  }
  const ctx: MigrateCtx = { nodeMap, sources, warnings, comments, seenNodeIds: new Set(), currentNode: root }
  const rootSection = convertNode(root, ctx)
  // The document's own top-level title is the *essay's* own title, never
  // the root node's own `.title` — `convertNode` (shared with every
  // subsection) fills it with `node.title` by default, which is right for
  // a subsection but wrong here: the real app's own title-rename flow
  // (`EssayWorkspace.tsx`'s `saveEssayTitle`) only ever writes
  // `essay.title`, never the root `EssayNode`'s own `title` field, which
  // stays frozen at whatever it was when `createEssay` first seeded it
  // equal to the essay's *original* title — any essay renamed since
  // creation has the two diverge. `essayToMarkdown`/`essayToLatex` already
  // get this right (`` `# ${essay.title}` ``/`` `\title{${essay.title}}` ``,
  // never `node.title`) — overriding it here after the fact, rather than
  // threading an essay-title override through `convertNode` itself, keeps
  // that function identical for every other (non-root) call site.
  rootSection.content[0] = sectionTitleJson(essay.title)
  return { title: essay.title, doc: { type: 'doc', content: [rootSection] }, comments, warnings }
}

function emptySection(sectionId: string, title = ''): PMJson {
  return { type: 'section', attrs: { id: sectionId }, content: [sectionTitleJson(title), { type: 'paragraph' }] }
}

/**
 * A graveyard fragment isn't a node in any essay's live tree — just a
 * cut-out shard of one's own content, kept for recovery — so it gets its
 * own standalone one-section `MigratedEssay` instead of going through
 * `convertNode`: reuses `htmlToBlocks` (the exact same text-segment
 * conversion a live node's own content goes through) directly on
 * `fragment.html`. Footnote references inside the cut selection still
 * resolve against `originNode`'s own `footnotes` array — the same node the
 * fragment was cut from, found by `nodeId` in the full node list the way
 * `buildLegacyNodeMap` finds everything else — falling back to an honest
 * warning (not a crash) when that node's gone too. A child-embed marker
 * caught inside the cut selection (the selection spanned clean across a
 * whole subsection chip) has no subtree to recover here — the fragment's
 * own `html` never carried that child's content, only the marker div
 * pointing at an id — so it's dropped with its own warning rather than
 * silently vanishing.
 */
export function migrateGraveyardFragment(fragment: GraveyardFragment, allNodes: EssayNode[], sources: Map<string, Source>): MigratedEssay {
  const warnings: string[] = []
  const originNode = allNodes.find((n) => n.id === fragment.nodeId)
  if (!originNode) {
    warnings.push(`This fragment's original section (${fragment.nodeId}) no longer exists — any footnote references inside it couldn't be resolved.`)
  }
  const childIds = getChildIds(fragment.html)
  if (childIds.length > 0) {
    warnings.push(`This fragment includes ${childIds.length} subsection marker(s) whose own content isn't part of the cut fragment itself — dropped.`)
  }
  const ctx: MigrateCtx = {
    nodeMap: new Map(),
    sources,
    warnings,
    comments: [],
    seenNodeIds: new Set(),
    currentNode: originNode ?? ({ id: fragment.nodeId, essayId: fragment.essayId, title: fragment.nodeTitle, draftContent: '' } as EssayNode),
  }
  const blocks = htmlToBlocks(fragment.html, ctx)
  const content: PMJson[] = [sectionTitleJson(fragment.nodeTitle), ...(blocks.length ? blocks : [{ type: 'paragraph' }])]
  const title = fragment.nodeTitle || 'Untitled section'
  return { title, doc: { type: 'doc', content: [{ type: 'section', attrs: { id: fragment.id }, content }] }, comments: [], warnings }
}

/** Exported for `essaysRepo.ts`'s own `createEssay` — a brand-new essay created after this phase ships needs the exact same `section_title` shape a migrated one gets, with no `EssayNode` tree to migrate at all. */
export function sectionTitleJson(title: string): PMJson {
  const text = title.trim()
  return text ? { type: 'section_title', content: [{ type: 'text', text }] } : { type: 'section_title' }
}

/**
 * One `EssayNode` -> one `section` node. Walks its own `parseSegments()`
 * output in order — text segment, child segment, text segment, … —
 * converting each in place (see `pmSchema.ts`'s own doc comment on why
 * `section`'s content expression allows exactly this interleaving, not
 * just "all text then all children"). A node with no real content at all
 * still gets one empty paragraph appended (`section` requires `block+`
 * after its title — never zero blocks).
 */
function convertNode(node: EssayNode, ctx: MigrateCtx): PMJson {
  if (ctx.seenNodeIds.has(node.id)) {
    ctx.warnings.push(`A cycle was found at "${node.title || 'Untitled section'}" (${node.id}) — a subsection pointed back at one of its own ancestors. Stopped recursing there rather than looping forever.`)
    return emptySection(node.id)
  }
  ctx.seenNodeIds.add(node.id)
  ctx.currentNode = node
  for (const c of node.comments ?? []) ctx.comments.push(migrateComment(c, node.id))

  const content: PMJson[] = [sectionTitleJson(node.title)]
  for (const seg of parseSegments(node.draftContent)) {
    if (seg.kind === 'text') {
      content.push(...htmlToBlocks(seg.html, ctx))
    } else {
      const child = ctx.nodeMap.get(seg.childId)
      if (child) {
        content.push(convertNode(child, ctx))
        ctx.currentNode = node // restore — the recursive call above just overwrote this for its own footnote lookups
      } else {
        ctx.warnings.push(`"${node.title || 'Untitled section'}" references a subsection (${seg.childId}) that's missing or was deleted — skipped.`)
      }
    }
  }
  if (content.length === 1) content.push({ type: 'paragraph' })
  return { type: 'section', attrs: { id: node.id }, content }
}

/**
 * A comment's own metadata, copied over field-for-field — `body` stays
 * exactly as it was, a plain rich-HTML string, never converted into PM
 * content: a comment's body was never part of the document tree even in
 * the old model (it's edited through its own small, separate
 * contentEditable surface, same as a footnote's body used to be *before*
 * `pmSchema.ts` promoted footnotes into real document content) and there's
 * no reason the migration needs to change that now. `sectionId` is the one
 * genuinely new field — see `Comment`'s own doc comment in `models/types.ts`.
 */
function migrateComment(c: Comment, sectionId: string): Comment {
  return {
    id: c.id,
    parentId: c.parentId,
    sectionId: c.parentId === null ? sectionId : null,
    anchorKind: c.anchorKind,
    anchorText: c.anchorText,
    body: c.body,
    displayMode: c.displayMode,
    resolved: c.resolved,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}

/**
 * Splits one text segment's HTML into PM block nodes — the structural
 * mirror of `export.ts`'s own `htmlToMarkdownBlocks`, genuinely recursive
 * the same way that function is (`div`/`p` both `flush()`, walk every
 * child — including a further-nested `div`/`p`, `blockquote`, list, or
 * math block — then `flush()` again), not just a single flat pass over
 * `doc.body`'s own direct children. A plain top-level-only pass misreads
 * two real structural cases the old app's own contentEditable HTML
 * routinely produces: a `<blockquote>` (or list, or math block) sitting
 * nested a level or two down inside a wrapping `<div>` — seen live in
 * older stored content — silently flattens to plain inline text instead of
 * becoming its own block (nothing in `walkInline`'s own default case
 * understands any of those tags, by design — they're never meant to
 * appear inline); and any paragraph break nested below the top level is
 * simply never seen at all.
 */
function htmlToBlocks(html: string, ctx: MigrateCtx): PMJson[] {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const blocks: PMJson[] = []
  let current: PMJson[] = []
  // Drops a block that amounts to nothing (see `isMeaningfulInline`) —
  // mirrors `htmlToMarkdownBlocks`'s own `if (t) blocks.push(t)` after
  // `.trim()`ing — rather than keeping it as a spurious extra blank
  // paragraph. The most common real source: a whitespace-only text node
  // (indentation, a line-wrap) sitting directly between two sibling
  // `<div>`s in pretty-printed or pasted-in HTML, which a browser's own
  // ordinary text flow would never have rendered as a paragraph break on
  // its own either.
  const flush = () => {
    if (current.some(isMeaningfulInline)) blocks.push({ type: 'paragraph', content: trimHardBreaks(current) })
    current = []
  }
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      walkInline(node, [], ctx, current)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'blockquote') {
      flush()
      blocks.push(blockquoteToPM(el, ctx))
      return
    }
    if (tag === 'span' && el.classList.contains('math-block')) {
      flush()
      blocks.push({ type: 'math_block', attrs: { latex: el.getAttribute('data-latex') ?? '' } })
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      flush()
      blocks.push(listToPM(el, ctx))
      return
    }
    if (tag === 'div' || tag === 'p') {
      flush()
      for (const child of Array.from(el.childNodes)) walk(child)
      flush()
      return
    }
    if (tag === 'br') {
      current.push({ type: 'hard_break' })
      return
    }
    walkInline(el, [], ctx, current)
  }
  for (const node of Array.from(doc.body.childNodes)) walk(node)
  flush()
  return blocks
}

/**
 * A blockquote's own content — real, separate `paragraph`s when the old
 * HTML actually had `<p>` children (an improvement in fidelity over the
 * old app's own Markdown export, which flattened a multi-paragraph
 * blockquote's text together with no separator at all — nothing stops the
 * new schema's `blockquote: { content: "paragraph+" }` from keeping them
 * genuinely separate, so this does), or one paragraph of plain inline
 * content for the much more common single-paragraph case.
 */
function blockquoteToPM(el: HTMLElement, ctx: MigrateCtx): PMJson {
  const paraEls = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'p')
  if (paraEls.length > 0) {
    const paragraphs = paraEls.map((p) => {
      const inline: PMJson[] = []
      for (const child of Array.from(p.childNodes)) walkInline(child, [], ctx, inline)
      return { type: 'paragraph', content: inline.length ? inline : undefined }
    })
    return { type: 'blockquote', content: paragraphs }
  }
  const inline: PMJson[] = []
  for (const child of Array.from(el.childNodes)) walkInline(child, [], ctx, inline)
  return { type: 'blockquote', content: [{ type: 'paragraph', content: inline.length ? inline : undefined }] }
}

/** `<ul>`/`<ol>` -> `bullet_list`/`ordered_list` — same nested-list handling as `export.ts`'s own `listToMarkdown`: a `list_item`'s own text becomes its leading paragraph, any nested `<ul>`/`<ol>` becomes a further block right after it. */
function listToPM(listEl: HTMLElement, ctx: MigrateCtx): PMJson {
  const ordered = listEl.tagName.toLowerCase() === 'ol'
  const items: PMJson[] = []
  for (const li of Array.from(listEl.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue
    const nested: Element[] = []
    const inline: PMJson[] = []
    for (const child of Array.from(li.childNodes)) {
      const childTag = child.nodeType === Node.ELEMENT_NODE ? (child as HTMLElement).tagName.toLowerCase() : ''
      if (childTag === 'ul' || childTag === 'ol') nested.push(child as Element)
      else walkInline(child, [], ctx, inline)
    }
    const content: PMJson[] = [{ type: 'paragraph', content: inline.length ? inline : undefined }]
    for (const n of nested) content.push(listToPM(n as HTMLElement, ctx))
    items.push({ type: 'list_item', content })
  }
  return { type: ordered ? 'ordered_list' : 'bullet_list', content: items }
}

function addMark(marks: PMJson[], mark: PMJson): PMJson[] {
  return [...marks, mark]
}

/**
 * Collapses any run of whitespace — including a literal newline — down to
 * a single space, the same way a browser already visually renders an
 * ordinary text node under the default `white-space: normal` the old
 * editor's own contentEditable surfaces always used. The new PM editor's
 * own CSS deliberately uses `white-space: pre-wrap` instead (fixes a
 * ProseMirror whitespace-collapsing console warning), so raw whitespace
 * baked into old stored HTML — a literal `\n` is common in pasted text or
 * PDF-extracted quotes (`reflowTextItems` in `lib/pdf.ts` deliberately
 * writes one per line-wrap) — renders as a real, visible line break there
 * unless it's collapsed explicitly first, instead of getting the
 * collapsing for free from the browser the way the old view did. Mirrors
 * `lib/export.ts`'s own `mdEscapeText` exactly, and for the exact same
 * reason (see its own doc comment there).
 */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/** A node contributes real, visible content to a paragraph — not a hard break (never alone enough to justify keeping an otherwise-empty paragraph; see `htmlToBlocks`'s own `flush`) and not a whitespace-only, mark-less text node (the common case for a run of indentation/line-wrap whitespace sitting between sibling block elements in pretty-printed or pasted-in HTML — a browser's own normal text flow would never have rendered that as a paragraph of its own, so this migration doesn't either). A whitespace-only text node that *does* carry a mark is kept regardless — see `walkInline`'s own empty-comment-anchor handling, which plants exactly this (a zero-width space marking an anchor with nothing selected) on purpose. */
function isMeaningfulInline(n: PMJson): boolean {
  if (n.type === 'hard_break') return false
  if (n.type === 'text') {
    if (n.marks && n.marks.length > 0) return true
    return (n.text as string).trim().length > 0
  }
  return true
}

/** Drops a purely cosmetic leading/trailing `<br>` — the DOM equivalent of the trailing-newline a browser's own contentEditable routinely leaves at the end of a paragraph `<div>` just to keep it from collapsing, never a break the author actually meant to see. An internal one (between two runs of real text) is left alone; only the ends are trimmed, mirroring `htmlToMarkdownBlocks`'s own `current.trim()` in `lib/export.ts`, which silently drops exactly the same leading/trailing `\n` a `<br>` there produces. */
function trimHardBreaks(nodes: PMJson[]): PMJson[] {
  let start = 0
  let end = nodes.length
  while (start < end && nodes[start].type === 'hard_break') start++
  while (end > start && nodes[end - 1].type === 'hard_break') end--
  return nodes.slice(start, end)
}

/**
 * Walks one DOM node (and everything inside it) into PM inline JSON,
 * appending to `out` — the structural mirror of `export.ts`'s own
 * `inlineHtmlToMarkdown`, just building typed nodes/marks instead of
 * Markdown syntax. `marks` is whichever marks are already active from an
 * ancestor (`<strong>`, a comment anchor, …); a new mark-producing element
 * adds to that list for its own children, never replaces it, so nested
 * marks (bold *and* italic, a citation inside a comment highlight) combine
 * correctly.
 */
function walkInline(node: Node, marks: PMJson[], ctx: MigrateCtx, out: PMJson[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = collapseWhitespace(node.textContent ?? '')
    if (text) out.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text })
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()

  if (el.classList.contains('citation')) {
    const converted = convertCitation(el, marks, ctx)
    if (converted) out.push(converted)
    return
  }
  if (tag === 'sup' && el.classList.contains('footnote-ref')) {
    const converted = convertFootnoteRef(el, marks, ctx)
    if (converted) out.push(converted)
    return
  }
  if (tag === 'span' && el.classList.contains('math-inline')) {
    out.push(withMarks({ type: 'math_inline', attrs: { latex: el.getAttribute('data-latex') ?? '' } }, marks))
    return
  }
  if (tag === 'br') {
    out.push({ type: 'hard_break' })
    return
  }
  // Always empty in stored HTML (its rendered content is a live, portal-mounted component, not real document data — see the real app's own `inlineCommentMarkerHtml` doc comment) — nothing to convert; the comment it's a placeholder for is already migrated via `migrateComment` regardless of whether this marker is present.
  if (tag === 'span' && el.classList.contains('inline-comment-marker')) return

  let childMarks = marks
  if (tag === 'b' || tag === 'strong') childMarks = addMark(childMarks, { type: 'strong' })
  else if (tag === 'i' || tag === 'em') childMarks = addMark(childMarks, { type: 'em' })
  else if (tag === 'u') childMarks = addMark(childMarks, { type: 'underline' })
  else if (tag === 'a') {
    const sourceId = el.getAttribute('data-source-id')
    const href = el.getAttribute('href')
    if (sourceId) childMarks = addMark(childMarks, { type: 'source_link', attrs: { sourceId } })
    else if (href) childMarks = addMark(childMarks, { type: 'link', attrs: { href } })
  } else if (tag === 'mark' && el.classList.contains('comment-anchor')) {
    const commentId = el.getAttribute('data-comment-id')
    if (commentId) {
      const withAnchor = addMark(childMarks, { type: 'comment_anchor', attrs: { commentId } })
      if (!el.textContent) {
        // An empty anchor (nothing selected when the comment was made) —
        // a mark can't exist on zero content, so a single zero-width
        // space stands in as the real, minimal "anchor point" character
        // to carry it, the same trick a caret-landing placeholder
        // elsewhere in the old app already used for the same reason.
        out.push({ type: 'text', text: '​', marks: withAnchor })
        return
      }
      childMarks = withAnchor
    }
  } else if (tag === 'span' && el.classList.contains('quote-inline')) {
    const sourceId = el.getAttribute('data-source-id')
    const page = el.getAttribute('data-page')
    if (sourceId) childMarks = addMark(childMarks, { type: 'quote_inline', attrs: { sourceId, page: page ? Number(page) : null } })
  }
  for (const child of Array.from(el.childNodes)) walkInline(child, childMarks, ctx, out)
}

function withMarks(node: PMJson, marks: PMJson[]): PMJson {
  return marks.length ? { ...node, marks } : node
}

/**
 * A citation chip -> a `citation` atom — `sourceId`/`note` only (see
 * `pmSchema.ts`'s own doc comment: no cached label ever stored). A legacy
 * chip (no `data-cite-v` — see the real app's own `syncCitations` doc
 * comment) has its page/note recovered from its own old label text via
 * `extractLegacyCitationNote`, same as a live-edited node already gets
 * the first time it's opened; one with no real source to rebuild from at
 * all (deleted since, or never structured in the first place) degrades
 * to its own plain visible text, the same fallback the real app's export
 * pipeline already uses for exactly this case.
 */
function convertCitation(el: HTMLElement, marks: PMJson[], ctx: MigrateCtx): PMJson | null {
  const sourceId = el.getAttribute('data-source-id')
  const source = sourceId ? ctx.sources.get(sourceId) : undefined
  if (!source) {
    if (sourceId) ctx.warnings.push(`A citation to a missing source (${sourceId}) in "${ctx.currentNode.title || 'Untitled section'}" was flattened to plain text.`)
    const text = el.textContent || '[citation]'
    return withMarks({ type: 'text', text }, marks)
  }
  const hasCiteV = el.hasAttribute('data-cite-v')
  const note = hasCiteV ? el.getAttribute('data-note') : extractLegacyCitationNote(el.textContent ?? '', source.bibtex.fields.year) || null
  return withMarks({ type: 'citation', attrs: { sourceId, note: note || null } }, marks)
}

/**
 * A footnote-ref marker -> a real `footnote` node, its own body converted
 * and embedded directly as that node's content — see `pmSchema.ts`'s own
 * doc comment on why a footnote's content is real document content now,
 * not a side record. `footnoteBodyToInline` below handles the one real
 * fidelity gap this creates: a footnote's own content can only be
 * *inline* in the new model (never block-level), where the old model's
 * footnote body was ordinary, unconstrained editable HTML.
 */
function convertFootnoteRef(el: HTMLElement, marks: PMJson[], ctx: MigrateCtx): PMJson | null {
  const footnoteId = el.getAttribute('data-footnote-id')
  const footnote = (ctx.currentNode.footnotes ?? []).find((f) => f.id === footnoteId)
  if (!footnote) {
    ctx.warnings.push(`A footnote reference in "${ctx.currentNode.title || 'Untitled section'}" has no matching footnote body — dropped.`)
    return null
  }
  const content = footnoteBodyToInline(footnote.content, ctx)
  return withMarks({ type: 'footnote', content: content.length ? content : undefined }, marks)
}

/**
 * Flattens a footnote body's own HTML into pure inline content — real
 * paragraph breaks become a `hard_break` (no visual loss for the common
 * case, a footnote that's just one or two sentences, possibly split
 * across a couple of short paragraphs); a list or blockquote inside a
 * footnote degrades to its own plain text, one item/line per
 * `hard_break`-separated run, with a prefix (`"1. "`/`"• "`) standing in
 * for real list markup; a display-math block becomes inline math (`$...$`
 * instead of its own standalone line). Rare in practice (a footnote
 * holding a whole blockquote or list is unusual), but every one of these
 * degradations gets a warning rather than happening silently.
 */
function footnoteBodyToInline(html: string, ctx: MigrateCtx): PMJson[] {
  const doc = new DOMParser().parseFromString(html || '', 'text/html')
  const out: PMJson[] = []
  let sawComplexStructure = false
  const appendBreakIfNeeded = () => {
    if (out.length > 0) out.push({ type: 'hard_break' })
  }
  for (const node of Array.from(doc.body.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      walkInline(node, [], ctx, out)
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'p' || tag === 'div') {
      appendBreakIfNeeded()
      for (const child of Array.from(el.childNodes)) walkInline(child, [], ctx, out)
      continue
    }
    if (tag === 'blockquote') {
      sawComplexStructure = true
      appendBreakIfNeeded()
      for (const child of Array.from(el.childNodes)) walkInline(child, [], ctx, out)
      continue
    }
    if (tag === 'ul' || tag === 'ol') {
      sawComplexStructure = true
      let n = 1
      for (const li of Array.from(el.children)) {
        if (li.tagName.toLowerCase() !== 'li') continue
        appendBreakIfNeeded()
        out.push({ type: 'text', text: tag === 'ol' ? `${n++}. ` : '• ' })
        for (const child of Array.from(li.childNodes)) walkInline(child, [], ctx, out)
      }
      continue
    }
    if (tag === 'span' && el.classList.contains('math-block')) {
      sawComplexStructure = true
      appendBreakIfNeeded()
      out.push({ type: 'math_inline', attrs: { latex: el.getAttribute('data-latex') ?? '' } })
      continue
    }
    walkInline(el, [], ctx, out)
  }
  if (sawComplexStructure) {
    ctx.warnings.push(`A footnote in "${ctx.currentNode.title || 'Untitled section'}" had block-level structure (a list, blockquote, or display equation) that a footnote can't hold in the new model — flattened to plain inline text.`)
  }
  return out
}

/**
 * Converts a *whole existing commit history* from the old per-node tree
 * format to the new PM-doc format — not just an essay's current content.
 * Per explicit direction: migrating an essay shouldn't leave its history
 * stuck on the far side of a format wall the new doc-based UI can't read;
 * reverting into a commit from before migration should land on something
 * just as real and editable as reverting to one made after.
 *
 * For each commit in `oldCommits` (any order — sorted by `seq` first),
 * reconstructs that point in history (`reconstructSnapshot`, reused as-is
 * from `lib/essayHistory.ts` — a `LegacyEssaySnapshot`) and converts it via
 * the exact same `migrateEssay` logic the live doc goes through: a
 * snapshot's own `nodes` array already carries exactly the fields
 * (`id`/`title`/`draftContent`/`footnotes`/`comments`) `migrateEssay`
 * needs, so no new conversion logic is needed here, just an adapter from
 * "reconstructed snapshot" to the `{essay, allNodes}` shape it already
 * takes. Each converted snapshot is diffed against the *previous converted*
 * snapshot's text (never the original tree-format text — the whole point
 * is a clean, self-consistent doc-format chain) to build a fresh `patch`.
 *
 * Returned commits reuse each original's own `id`/`seq`/`kind`/`label`/
 * `createdAt` — same slot in the timeline, converted content — so applying
 * the result is an in-place field update to each existing `essayHistory`
 * row (`patch` changes, nothing about the commit's own identity does),
 * never a delete-and-reinsert.
 *
 * Deliberately not wired into `storage/migrationRegistry.ts`/
 * `sync/remoteMigrationRegistry.ts` yet, same as `migrateEssay`/
 * `migrateGraveyardFragment` above — running this (or the live-doc
 * migration) automatically now, before the UI that actually reads
 * `Essay.doc` exists, would write a doc/history chain that the
 * still-unswapped old UI then keeps editing around (via `draftContent`/
 * `nodes`) without ever touching, silently making it stale from the
 * moment it's written. The real, one-time conversion — live doc and
 * history both — is deferred to land in the same change as the UI swap
 * that actually depends on it, so it's never computed from data that's
 * already gone stale by the time anything reads it.
 */
export function migrateEssayHistory(essayTitle: string, oldCommits: EssayCommitEntry[], sources: Map<string, Source>): { commits: EssayCommitEntry[]; warnings: string[] } {
  const warnings: string[] = []
  const sorted = [...oldCommits].sort((a, b) => a.seq - b.seq)
  const newCommits: EssayCommitEntry[] = []
  let prevDocText = ''
  for (const commit of sorted) {
    const legacySnapshot = reconstructSnapshot(sorted, commit.seq)
    const pseudoEssay = { title: legacySnapshot.title || essayTitle, rootNodeId: legacySnapshot.rootNodeId }
    const pseudoNodes: EssayNode[] = legacySnapshot.nodes.map((n) => ({
      id: n.id,
      essayId: '',
      title: n.title,
      versions: [],
      headVersionId: '',
      draftContent: n.draftContent,
      footnotes: n.footnotes,
      comments: n.comments,
      createdAt: 0,
      updatedAt: 0,
    }))
    const migrated = migrateEssay(pseudoEssay, pseudoNodes, sources)
    warnings.push(...migrated.warnings)
    const docText = pmSnapshotText({ title: migrated.title, doc: migrated.doc, comments: migrated.comments })
    newCommits.push({ ...commit, patch: diffSnapshots(prevDocText, docText) })
    prevDocText = docText
  }
  return { commits: newCommits, warnings }
}

/** The new-format counterpart to `lib/essayHistory.ts`'s own `snapshotText` — same stable, deterministic serialization, just for `EssaySnapshot` (the PM-doc-based shape) rather than `LegacyEssaySnapshot` (the tree-based one that module stays on — see `models/types.ts`'s own doc comments on why the two are separate types). Exported for `essayHistoryRepo.ts`'s own doc-based `commitPmEssay`/`revertPmEssayTo`/`mergePmEssays` (Stage B5), which need the exact same serialization `migrateEssayHistory` above already uses so a migrated essay's pre-existing commit chain and any commit made after migration both describe the same snapshot shape. */
export function pmSnapshotText(snapshot: EssaySnapshot): string {
  return JSON.stringify(snapshot, null, 2)
}
