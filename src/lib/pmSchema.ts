import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model'

/**
 * Ported verbatim from the standalone prototype (`pm-editor/src/schema.ts`
 * on this same branch), already proven there against real backup data. Used
 * today only to validate `lib/pmMigration.ts`'s own output in tests
 * (`Node.fromJSON(essaySchema, doc)`) — nothing in the live app renders or
 * edits against this schema yet; that's the later UI-swap phase.
 *
 * The "maximal" migration's whole point: an essay is ONE real,
 * schema-validated ProseMirror document — not a tree of separate
 * `EssayNode` records stitched together with `<div class="child-embed">`
 * HTML markers (see the old app's `lib/childMarkers.ts`). A `section` node
 * here *is* the structural unit markers used to fake: it nests recursively,
 * it owns its own title as real node content (not a separate string field
 * next to opaque HTML), and "what are this section's children, in what
 * order" is just "its own child `section` nodes," not something recovered
 * by parsing HTML looking for marker divs.
 *
 * Two deliberate departures from the old per-node model, both existing
 * complex features promoted to first-class schema citizens instead of
 * side-channel data glued on by an id:
 *
 * - A footnote's own body used to be a flat array entry on whichever
 *   `EssayNode` it belonged to (`Footnote.content`, plain HTML), referenced
 *   by a `<sup data-footnote-id>` marker having nothing to do with the
 *   document's own tree structure. Here, `footnote` is a real *content*
 *   node (`content: "paragraph+"`) sitting inline exactly where its own
 *   reference mark used to be an opaque pointer — its body is genuinely
 *   part of the document, editable with the same transactions as
 *   everything else, shown/hidden via a NodeView (see `nodeViews.ts`)
 *   rather than by being a separate record at all.
 * - A citation chip stays a true atom (`citation`, no content of its own)
 *   — unlike a footnote, there's nothing to edit *inside* one; its whole
 *   job is to point at a source id and re-render fresh from that source's
 *   current bibliographic data (exactly what today's `renderPrintCitation`
 *   already does for export; this schema makes that the *only* way a
 *   citation is ever rendered, live editing included — no more "stale
 *   baked-in label text" distinct from the export-time re-render).
 *
 * `comment_anchor` stays a *mark*, not a node — a comment's own metadata
 * (thread, resolved flag, timestamps) doesn't belong in the document tree
 * at all (same as today: `Comment` lives in a flat side array, not inside
 * `draftContent`); only the range it's anchored to needs to be part of the
 * document, which a mark is exactly suited for.
 */

const pDOM = ['p', 0] as const

const nodes: Record<string, NodeSpec> = {
  /**
   * Exactly one top-level `section` — not `"section+"` — matching the old
   * model's single root (`Essay.rootNodeId`/its one `EssayNode`): a
   * second top-level section would be structurally ambiguous (is it a
   * second root-level numbered section, or a sibling "root"?), so there
   * is deliberately no shape for that to mean. `commands.ts`'s own
   * `insertSiblingSection` is written to respect this — from inside the
   * root section's own body text, "new section" adds a *child* of the
   * root (a new numbered top-level section), never a doc-level sibling.
   */
  doc: {
    content: 'section',
  },

  /**
   * The recursive structural unit — see this file's own doc comment. Every
   * section carries a stable `id` (generated once, kept across edits —
   * `sectionId()`/history/comments/footnotes all need a durable handle
   * that survives a section being moved or its title rephrased, same
   * reason `EssayNode.id` was durable before).
   *
   * `content: "section_title block+"` — not `"section_title block+
   * section*"` — is deliberate, not a simplification: `section` itself
   * already declares `group: "block"` below, so a plain `block+` content
   * expression *already* allows any number of nested `section`s, freely
   * interleaved with ordinary paragraphs/lists/etc. in any order, with no
   * second `section*` clause needed. This matters for fidelity, not just
   * economy of expression: the old app's own `childMarkers.ts` let a
   * node's content be an arbitrary (text, child, text, child, …, text)
   * sequence — prose *before* a subsection, a transition paragraph
   * *between* two subsections, closing remarks *after* the last one, all
   * genuinely supported — and an earlier, stricter version of this schema
   * (blocks-only, then sections-only) couldn't represent any of that
   * without reordering or merging real user content during migration.
   * `migrate.ts` relies on this directly, converting each of a node's own
   * `parseSegments()` segments (text or child) into this section's content
   * in the exact order they already appear.
   */
  section: {
    content: 'section_title block+',
    group: 'block',
    defining: true,
    // `collapsed` is UI-only state (the in-document fold toggle and the
    // outline sidebar read/write this same attr, via `pmCommands.ts`'s
    // `toggleSectionCollapsed` — see `pmNodeViews.ts`'s `SectionView`) —
    // a real node attr rather than component-local state so the sidebar
    // and in-document chevrons can never disagree about which sections
    // are open, without a second state-sync channel alongside the
    // document itself. Deliberately *session* state though, same as
    // scroll position or cursor placement: `PMEssayEditor.tsx`'s own
    // `stripCollapsedAttrs` resets every `collapsed` to `false` on the
    // way into persisted storage, so it's live within one mounted
    // editor but never outlives a reload (or syncs to another device).
    attrs: { id: { default: null }, collapsed: { default: false } },
    parseDOM: [{ tag: 'section', getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-section-id') }) }],
    toDOM(node) {
      return ['section', { 'data-section-id': node.attrs.id }, 0]
    },
  },

  /** A section's own title — plain text only (no marks), same constraint `EssayNode.title` already had as a plain string. Always the first child of a `section`, enforced by the parent's own content expression rather than by convention. */
  section_title: {
    content: 'text*',
    marks: '',
    parseDOM: [{ tag: 'h1, h2, h3, h4, h5, h6' }],
    toDOM() {
      return ['h2', { class: 'section-title' }, 0]
    },
  },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM() {
      return pDOM
    },
  },

  blockquote: {
    content: 'paragraph+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote' }],
    toDOM() {
      return ['blockquote', 0]
    },
  },

  bullet_list: {
    // `fragment_break` interleaved with `list_item` — a slideshow-only
    // allowance (see its own doc comment below), harmless for an essay
    // that never puts one there — is what lets "fragmented reveal" land
    // *between* two bullets of the very same list, rather than only ever
    // after the list as a whole (the only option before this): without
    // it, the list itself is the smallest "block" `pmCommands.ts`'s own
    // divider-insertion logic has a position for, same as any other block.
    content: '(list_item | fragment_break)+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM() {
      return ['ul', 0]
    },
  },

  ordered_list: {
    content: '(list_item | fragment_break)+',
    group: 'block',
    attrs: { order: { default: 1 } },
    parseDOM: [
      {
        tag: 'ol',
        getAttrs(dom) {
          const start = (dom as HTMLElement).getAttribute('start')
          return { order: start ? Number(start) : 1 }
        },
      },
    ],
    toDOM(node) {
      return node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0]
    },
  },

  list_item: {
    content: 'paragraph block*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM() {
      return ['li', 0]
    },
  },

  text: { group: 'inline' },

  /** A literal line break mid-paragraph — the standard ProseMirror node for what the old app's own `<br>` meant in both its inline (`inlineHtmlToMarkdown`'s own `  \n`) and same-segment block-separator (`htmlToMarkdownBlocks`'s own bare `\n`) uses; added specifically for `migrate.ts` to have something to convert either one into, since neither reading represents a real ProseMirror node-level break. */
  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    parseDOM: [{ tag: 'br' }],
    toDOM() {
      return ['br']
    },
  },

  /**
   * A footnote's own body as real document content — see this file's own
   * doc comment. `content: "inline*"`, not `"paragraph+"` — a block node
   * (a `<p>`) nested inside an `inline: true` node is exactly the kind of
   * structural mismatch ProseMirror's own DOM reconciliation doesn't
   * round-trip cleanly, and reliably made a real bug (see `nodeViews.ts`'s
   * own `FootnoteView` doc comment) harder to diagnose while first
   * building this prototype. A real footnote body that genuinely needs
   * multiple paragraphs is a real, separate design question for the
   * actual migration, not something to silently reach for here.
   *
   * Deliberately *not* `atom: true`, unlike the official ProseMirror
   * footnote example — that example's own tooltip editor is a second,
   * fully detached `EditorView` nested inside the NodeView (synced back
   * into the main document only on blur), which sidesteps ever placing a
   * real cursor inside an atom's `contentDOM` at all. This prototype's
   * `FootnoteView` takes the simpler route of exposing `contentDOM`
   * directly to the *same* outer editor instead, which is only reliable
   * for a non-atom node — clicking into an atom's own `contentDOM` to
   * place a cursor there isn't a case ProseMirror's default click
   * handling actually supports.
   */
  footnote: {
    inline: true,
    group: 'inline',
    content: 'inline*',
    defining: true,
    parseDOM: [{ tag: 'footnote' }],
    toDOM() {
      return ['footnote', 0]
    },
  },

  /**
   * A citation chip — a true atom, no content of its own. `sourceId` is
   * the only thing that actually matters; `note` is the citation's own
   * freeform page-number/note text (see the old app's `citationHtml`).
   * Deliberately carries no cached display label at all (unlike the old
   * app's chip, whose visible text was baked in at insert time and only
   * ever re-derived fresh for *export* — see `renderPrintCitation`'s own
   * doc comment there) — a `citation` node's NodeView always renders
   * fresh from the current `Source` record, live editing included, so
   * there is no "stale baked-in text" state to ever fall out of sync.
   */
  citation: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { sourceId: {}, note: { default: null } },
    parseDOM: [
      {
        tag: 'citation',
        getAttrs(dom) {
          const el = dom as HTMLElement
          return { sourceId: el.getAttribute('data-source-id'), note: el.getAttribute('data-note') }
        },
      },
    ],
    toDOM(node) {
      return ['citation', { 'data-source-id': node.attrs.sourceId, 'data-note': node.attrs.note ?? undefined }]
    },
  },

  math_inline: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { latex: { default: '' } },
    parseDOM: [{ tag: 'math-inline', getAttrs: (dom) => ({ latex: (dom as HTMLElement).getAttribute('data-latex') ?? '' }) }],
    toDOM(node) {
      return ['math-inline', { 'data-latex': node.attrs.latex }]
    },
  },

  math_block: {
    group: 'block',
    atom: true,
    attrs: { latex: { default: '' } },
    parseDOM: [{ tag: 'math-block', getAttrs: (dom) => ({ latex: (dom as HTMLElement).getAttribute('data-latex') ?? '' }) }],
    toDOM(node) {
      return ['math-block', { 'data-latex': node.attrs.latex }]
    },
  },

  /**
   * A slideshow's own slide boundary — makes this same schema a strict
   * superset of the essay format: any essay doc is already a valid
   * slideshow doc, just one with no `slide_break`/`fragment_break`
   * dividers in it (and so, when presented, one single slide). A plain
   * atom with no content of its own and no layout attr — every slide
   * other than the deck's own auto-generated title/bibliography slides
   * (`slideSerializer.ts`, never real document content) shares one plain
   * layout, so there is nothing for a divider to choose between. Lands as
   * a direct child of whichever `section` encloses it (`pmCommands.ts`'s
   * `insertSlideBreak`) — `slideSerializer.ts` reads each slide's own
   * title from that same enclosing section.
   */
  slide_break: {
    group: 'block',
    atom: true,
    attrs: { id: { default: null } },
    parseDOM: [{ tag: 'slide-break', getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-id') }) }],
    toDOM(node) {
      return ['slide-break', { 'data-id': node.attrs.id }]
    },
  },

  /** A reveal.js fragment boundary within one slide — everything between two of these (or between a `slide_break`/`fragment_break` and the next one) reveals together as one incremental step when presenting (`slideSerializer.ts`); no effect at all on an essay rendered any other way. */
  fragment_break: {
    group: 'block',
    atom: true,
    attrs: { id: { default: null } },
    parseDOM: [{ tag: 'fragment-break', getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-id') }) }],
    toDOM(node) {
      return ['fragment-break', { 'data-id': node.attrs.id }]
    },
  },
}

const marks: Record<string, MarkSpec> = {
  strong: {
    parseDOM: [{ tag: 'strong' }, { tag: 'b' }],
    toDOM() {
      return ['strong', 0]
    },
  },
  em: {
    parseDOM: [{ tag: 'em' }, { tag: 'i' }],
    toDOM() {
      return ['em', 0]
    },
  },
  underline: {
    parseDOM: [{ tag: 'u' }],
    toDOM() {
      return ['u', 0]
    },
  },
  link: {
    attrs: { href: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: (dom as HTMLElement).getAttribute('href') }) }],
    toDOM(mark) {
      return ['a', { href: mark.attrs.href, target: '_blank', rel: 'noopener noreferrer' }, 0]
    },
  },
  /** A link whose href is derived from a `Source` record rather than typed by hand — kept distinct from plain `link` so export can tell "cites a source" apart from "an arbitrary external link," same distinction the old app's `insertSourceLink` vs. a plain pasted URL already made. */
  source_link: {
    attrs: { sourceId: {} },
    inclusive: false,
    parseDOM: [{ tag: 'a[data-source-id]', getAttrs: (dom) => ({ sourceId: (dom as HTMLElement).getAttribute('data-source-id') }) }],
    toDOM(mark) {
      return ['a', { 'data-source-id': mark.attrs.sourceId, target: '_blank', rel: 'noopener noreferrer' }, 0]
    },
  },
  /** A quoted excerpt's own text, wrapped so export/footnote-note logic can recover which source/page it was pulled from — the mark equivalent of the old app's `<span class="quote-inline" data-source-id data-page>`. */
  quote_inline: {
    attrs: { sourceId: {}, page: { default: null } },
    parseDOM: [{ tag: 'quote-inline', getAttrs: (dom) => ({ sourceId: (dom as HTMLElement).getAttribute('data-source-id'), page: (dom as HTMLElement).getAttribute('data-page') }) }],
    toDOM(mark) {
      return ['quote-inline', { 'data-source-id': mark.attrs.sourceId, 'data-page': mark.attrs.page ?? undefined }]
    },
  },
  /** The anchor a `Comment` (a side table, same as the old app — see this file's own doc comment) points at. `commentId` only — thread/resolved/body/timestamps all live off-tree. */
  comment_anchor: {
    attrs: { commentId: {} },
    excludes: '',
    parseDOM: [{ tag: 'comment-anchor', getAttrs: (dom) => ({ commentId: (dom as HTMLElement).getAttribute('data-comment-id') }) }],
    toDOM(mark) {
      return ['comment-anchor', { 'data-comment-id': mark.attrs.commentId }]
    },
  },
  /**
   * A top-level, inline-displayed comment's own body — unlike `comment_anchor`
   * (which marks the *original prose being commented on*), this marks the
   * comment's *own* reply text, living directly in the document right after
   * its anchor: an ordinary run of real, typable content, distinguished from
   * plain prose only in being extractable into the margin
   * (`pmCommands.ts`'s `extractInlineCommentBody`) and in never being
   * rendered in export (`lib/export.ts`'s own `inlineLeafToMarkdownPm`/
   * `inlineLeafToLatexPm` skip any text carrying this mark outright). No
   * `inclusive: false` here, deliberately — typing right after the end of a
   * `comment_text` range should keep extending it, the same way bold/italic
   * already behave, so a comment's own body grows the normal way as its
   * author keeps typing.
   */
  comment_text: {
    attrs: { commentId: {} },
    excludes: '',
    parseDOM: [{ tag: 'comment-text', getAttrs: (dom) => ({ commentId: (dom as HTMLElement).getAttribute('data-comment-id') }) }],
    toDOM(mark) {
      return ['comment-text', { 'data-comment-id': mark.attrs.commentId }]
    },
  },
}

export const essaySchema = new Schema({ nodes, marks })
