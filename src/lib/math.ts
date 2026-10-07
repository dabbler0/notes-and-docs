/**
 * The one place a LaTeX equation's source actually gets turned into
 * rendered math — a thin wrapper around KaTeX's own `renderToString`
 * (static HTML/MathML with inline styles, no client-side JS needed to
 * *display* it, which is what lets the "export to PDF" print view reuse
 * this too — see `export.ts`'s own doc comment) rather than its DOM-mutating
 * `render()`, so every caller (a live, portal-mounted equation in the
 * editor, or a one-shot string substitution in exported HTML) goes through
 * the same function regardless of whether it has a real element to render
 * into yet.
 *
 * `throwOnError: false` is the whole reason this never needs a try/catch of
 * its own: an unparseable equation renders as KaTeX's own red error text
 * in place, exactly where the equation would have been, rather than taking
 * down the rest of the section's render — a person mid-equation (most of
 * this feature's actual use) sees *something* update as they type, not a
 * blank gap. `strict: false` quiets KaTeX's own console warnings for
 * common-but-technically-non-standard LaTeX (e.g. `\over`) that a person
 * copying from a real paper or textbook is likely to paste in verbatim.
 */
import katex from 'katex'

export function renderMathHtml(latex: string, displayMode: boolean): string {
  return katex.renderToString(latex, { displayMode, throwOnError: false, strict: false })
}
