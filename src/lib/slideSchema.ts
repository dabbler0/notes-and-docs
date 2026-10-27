import { Schema, type NodeSpec, type MarkSpec } from 'prosemirror-model'

/**
 * A prototype second schema, sibling to `essaySchema` (`pmSchema.ts`) rather
 * than a variant of it — a slide deck's own structure (a flat, ordered
 * sequence of slides, each one a fixed, named layout rather than a nested
 * tree of sections) has little enough in common with an essay's that
 * sharing one schema between them would mean every essay-only concept
 * (recursive sections, footnotes, math) becomes a dead option slides never
 * use, or vice versa. `paragraph`/`bullet_list`/`ordered_list`/`list_item`/
 * `text`/`citation` and the inline marks are duplicated from `pmSchema.ts`
 * rather than imported — ProseMirror `NodeSpec`/`MarkSpec` objects are
 * perfectly fine to reuse across two independent `Schema` instances, but
 * keeping two tiny, independent copies here is simpler than threading a
 * shared-pieces module through both for a handful of plain-object specs
 * unlikely to drift (and if they ever do need to diverge — e.g. a slide
 * paragraph someday wanting different inline content — nothing has to be
 * un-shared first).
 */

const pDOM = ['p', 0] as const

const nodes: Record<string, NodeSpec> = {
  /** A deck is just its slides, in order — no nesting, unlike `essaySchema`'s recursive `section`. */
  doc: {
    content: 'slide+',
  },

  /**
   * One slide. `layout` is the entire "where does things go" decision for
   * this slide — see `slideSerializer.ts` for what each value actually
   * renders as. There is deliberately no x/y, size, or free content
   * placement anywhere in this schema: every slide's layout is one of a
   * fixed, small set of templates, which is the whole point (see the
   * conversation that led to this file — "forces all things into natural
   * and mathematically precise locations").
   *
   * - `title` — the deck's own opening slide: big centered title, italic
   *   subtitle, author line. Exactly one of these is expected (the first
   *   slide), but nothing enforces that structurally — a prototype choice,
   *   not a schema limitation.
   * - `section` — a section-header slide (just a big title, no body) that
   *   also sets the "eyebrow" label (the small running head in the
   *   corner of every slide after it) shown on every following `content`/
   *   `quote`/`bibliography` slide, up to the next `section` slide —
   *   computed at serialize time (`slideSerializer.ts`), never stored.
   * - `content` — the ordinary case: a title plus body blocks.
   * - `bibliography` — its own body content is ignored; rendered content
   *   is generated fresh at serialize time from every `citation` node's
   *   `sourceId` anywhere in the whole deck (see `slideSerializer.ts`),
   *   the same "always re-derived, never baked in" choice `pmSchema.ts`'s
   *   own `citation` node doc comment already makes for essays.
   */
  slide: {
    content: 'slide_title block*',
    group: 'block',
    defining: true,
    attrs: {
      id: { default: null },
      layout: { default: 'content' },
    },
    parseDOM: [
      {
        tag: 'slide',
        getAttrs: (dom) => ({
          id: (dom as HTMLElement).getAttribute('data-slide-id'),
          layout: (dom as HTMLElement).getAttribute('data-layout') || 'content',
        }),
      },
    ],
    toDOM(node) {
      return ['slide', { 'data-slide-id': node.attrs.id, 'data-layout': node.attrs.layout }, 0]
    },
  },

  /** A slide's own title — plain text only, same constraint `pmSchema.ts`'s `section_title` already uses. Always the first child, enforced by `slide`'s own content expression. */
  slide_title: {
    content: 'text*',
    marks: '',
    parseDOM: [{ tag: 'h1, h2, h3, h4, h5, h6' }],
    toDOM() {
      return ['h2', { class: 'slide-title' }, 0]
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

  /** Same shape as `pmSchema.ts`'s own `citation` — a true atom, always re-rendered fresh from the current `Source`, never a baked-in label. See `slide`'s own doc comment above for how the `bibliography` layout consumes these. */
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
}

export const slideSchema = new Schema({ nodes, marks })

/** A brand-new slide's own minimal content — a title and one empty paragraph, same shape `essaysRepo.ts`'s `createEssay` gives a fresh root section. */
export function slideJson(title: string, layout: 'title' | 'section' | 'content' | 'bibliography' = 'content', id?: string) {
  return {
    type: 'slide',
    attrs: { id: id ?? null, layout },
    content: [{ type: 'slide_title', content: title ? [{ type: 'text', text: title }] : [] }, { type: 'paragraph' }],
  }
}
