import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model'

/**
 * A slide deck as one continuous flowing document — not a slide-per-box
 * structure (an earlier prototype tried that; see the
 * `slideshow-wysiwyg-boxes-prototype` branch for it, kept around rather
 * than deleted). Per explicit direction: editing a deck should feel like
 * editing an essay — one scrollable flow of real prose, read and typed
 * top to bottom — with slide/fragment boundaries marked by thin in-flow
 * divider nodes rather than by chopping the document into separate boxes.
 *
 * `section`/`section_title` (recursive, same shape as `pmSchema.ts`'s own
 * essay sections) plus `slide_break`/`fragment_break` are the new ideas
 * versus the essay schema; everything else (`paragraph`/`bullet_list`/
 * `ordered_list`/`list_item`/`blockquote`/`citation`/`text`, `strong`/`em`/
 * `underline`/`quote_inline`) is duplicated from it verbatim for the same
 * reason `pmSchema.ts`'s own sibling-schema doc comment already gives for
 * not sharing a module: two tiny independent copies of a handful of plain-
 * object specs is simpler than threading a shared-pieces module through
 * both schemas for something unlikely to drift.
 *
 * - `section`/`section_title` — the same outline structure an essay has,
 *   nestable arbitrarily deep, but it deliberately renders as little as
 *   possible (`SlideDeckEditor.tsx`'s own CSS: a plain small heading, no
 *   vertical rule/chevron/numbering) — its real job isn't visual, it's to
 *   drive `slideSerializer.ts`'s own auto-titling: a slide's own title is
 *   never typed directly, it's always just whichever section it happens to
 *   sit inside at that point in the document (the *innermost* one, for a
 *   slide nested two or more sections deep), and the deck's running
 *   "eyebrow" label is the *outermost* enclosing section's own title. See
 *   `slideSerializer.ts` for exactly how. Unlike the essay schema, `doc`
 *   here allows any number of top-level `section`s side by side (not one
 *   single root) — a deck's own sections are its top-level "parts," not one
 *   all-enclosing whole-deck wrapper the way an essay's root section is.
 * - `slide_break` — an atom, block-level divider marking "a new slide
 *   starts here." `layout` is now just `content` (the default) or
 *   `section` (a big, centered, title-only divider slide) — a *title* or
 *   *bibliography* slide is never one of these; both are generated
 *   automatically, always, at fixed points (deck start/end) rather than
 *   being a layout choice on some particular divider (see
 *   `slideSerializer.ts`'s own `serializeDeck`).
 * - `fragment_break` — an atom, block-level divider marking "a reveal step
 *   starts here," within whatever slide it falls inside. Everything from
 *   one `fragment_break` up to the next one (or the next `slide_break`)
 *   reveals together as one step when presenting — see
 *   `slideSerializer.ts` for exactly how.
 *
 * Both dividers are deliberately *content-free* atoms, the same shape
 * `pmSchema.ts`'s own `citation`/`math_inline` are — a divider has nothing
 * to edit inside it, just a position in the flow and (for `slide_break`)
 * one attr a small widget on its own NodeView changes directly
 * (`pmSlideNodeViews.ts`). Deleting one is just deleting a node like any
 * other — no custom "merge the two slides on either side" command needed,
 * since removing the divider between them already *is* that merge, for
 * free, via ordinary backspace/delete.
 */

const pDOM = ['p', 0] as const

const nodes: Record<string, NodeSpec> = {
  /** Any number of top-level blocks — unlike `pmSchema.ts`'s own single-root-`section` essay `doc`, a deck's own `section`s are siblings, not nested inside one implicit whole-deck wrapper (see this file's own doc comment). */
  doc: {
    content: 'block+',
  },

  /** Same recursive shape as `pmSchema.ts`'s own `section` — see this file's own doc comment on why it exists here at all (driving auto-titling, not visual nesting). */
  section: {
    content: 'section_title block+',
    group: 'block',
    defining: true,
    attrs: { id: { default: null } },
    parseDOM: [{ tag: 'section', getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-section-id') }) }],
    toDOM(node) {
      return ['section', { 'data-section-id': node.attrs.id }, 0]
    },
  },

  /** Same shape as `pmSchema.ts`'s own `section_title` — plain text only, always a section's first child. */
  section_title: {
    content: 'text*',
    marks: '',
    parseDOM: [{ tag: 'h1, h2, h3, h4, h5, h6' }],
    toDOM() {
      return ['h2', { class: 'slide-section-title' }, 0]
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
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM() {
      return ['ul', 0]
    },
  },

  ordered_list: {
    content: 'list_item+',
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

  /** Same shape as `pmSchema.ts`'s own `citation` — see its doc comment there. */
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

  /** Marks "a new slide starts here" — see this file's own doc comment. `id` is a stable handle nothing currently dereferences, kept for the same forward-looking reason `pmSchema.ts`'s `section.attrs.id` is. */
  slide_break: {
    group: 'block',
    atom: true,
    attrs: { id: { default: null }, layout: { default: 'content' } },
    parseDOM: [
      {
        tag: 'slide-break',
        getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute('data-id'), layout: (dom as HTMLElement).getAttribute('data-layout') || 'content' }),
      },
    ],
    toDOM(node) {
      return ['slide-break', { 'data-id': node.attrs.id, 'data-layout': node.attrs.layout }]
    },
  },

  /** Marks "a reveal step starts here" — see this file's own doc comment. */
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
  /** Same shape as `pmSchema.ts`'s own `quote_inline` — see its doc comment there. */
  quote_inline: {
    attrs: { sourceId: {}, page: { default: null } },
    parseDOM: [{ tag: 'quote-inline', getAttrs: (dom) => ({ sourceId: (dom as HTMLElement).getAttribute('data-source-id'), page: (dom as HTMLElement).getAttribute('data-page') }) }],
    toDOM(mark) {
      return ['quote-inline', { 'data-source-id': mark.attrs.sourceId, 'data-page': mark.attrs.page ?? undefined }]
    },
  },
}

export const slideSchema = new Schema({ nodes, marks })

/** A brand-new deck's own minimal content: one empty top-level section, ready to type its own title (the deck's first "part") straight into — not the deck's own title, which never lives in the document at all (see `slideSerializer.ts`'s own auto-generated title slide). */
export function initialSlideDeckJson(sectionId: string) {
  return {
    type: 'doc',
    content: [{ type: 'section', attrs: { id: sectionId }, content: [{ type: 'section_title' }, { type: 'paragraph' }] }],
  }
}
