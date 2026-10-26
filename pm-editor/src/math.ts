/**
 * The one place a LaTeX equation's source actually gets turned into
 * rendered math — a thin wrapper around KaTeX's own `renderToString`
 * (static HTML/MathML with inline styles) — ported unchanged from the
 * real app's `lib/math.ts`. `emptyMathMarkers`, that file's other export,
 * is a DOM-marker artifact of the old HTML-string content model (clearing
 * a live-rendered equation's children before baking a chunk of editor DOM
 * into a saved string) and has no equivalent need here: a `math_inline`/
 * `math_block` node's `latex` attr is the only thing ever stored.
 */
import katex from 'katex'

export function renderMathHtml(latex: string, displayMode: boolean): string {
  return katex.renderToString(latex, { displayMode, throwOnError: false, strict: false })
}
