/**
 * The classified, structural view of a source's extracted text that
 * `buildEpub.ts` turns into an actual .epub — produced by `classify.ts` from
 * either extraction mode's `pageHtml` (see that file's own doc comment for
 * how the two differ in what they can detect). Deliberately not HTML: a
 * block is a plain semantic unit (a paragraph, a heading at some level, a
 * footnote, a scene break), so the EPUB writer is free to lay each one out
 * however EPUB readers actually want it (real `<h1>`-`<h3>` elements for
 * navigation, `<aside epub:type="footnote">` for footnotes) rather than
 * inheriting the source HTML's own presentation-oriented markup.
 */
export type BlockType = 'heading' | 'paragraph' | 'footnote' | 'break'

export interface DocBlock {
  type: BlockType
  text: string
  /** Heading level (1 = top-level section). Only meaningful when `type === 'heading'`. */
  level?: number
  /** 1-based source page this block began on — carried through purely for debugging/tests, not shown to the reader. */
  page: number
}
