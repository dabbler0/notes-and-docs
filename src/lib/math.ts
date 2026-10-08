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

/**
 * Strips a `.math-inline`/`.math-block` marker's own children — the live
 * KaTeX output `MathBody` portal-mounts into it (SectionBlock.tsx) —
 * wherever a chunk of the live, already-rendered editor DOM is about to be
 * turned into an HTML *string*: saved as `draftContent`
 * (`childMarkers.ts`'s `reconstructContent`), carved into a new
 * subsection's own content (`extractRangeHtml` in `lib/selection.ts`, used
 * by "split into subsection" / moving a selection into a child), or cut to
 * the graveyard (`sendSelectionToGraveyard` in EssayWorkspace.tsx).
 *
 * Without this, a marker's *rendered* children end up baked into the saved
 * string right alongside its `data-latex` attribute. That's invisible until
 * the content loads fresh somewhere: `parseSegments` puts the baked-in
 * markup back as the marker's *starting* children, and `MathBody`'s own
 * portal then mounts its own freshly-rendered copy alongside it rather than
 * replacing it, since Preact never created those original children and has
 * no record of them to diff against — visibly duplicating the equation.
 *
 * Takes and returns a plain DOM subtree (never the live, mounted editor
 * itself — always either a disconnected clone, as `reconstructContent`
 * passes, or a fragment already extracted/cloned out of the live DOM, as
 * `extractRangeHtml` and the graveyard both pass) since clearing a
 * *mounted* portal's target children out from under Preact would be the
 * same kind of DOM-ownership mismatch in reverse.
 */
export function emptyMathMarkers<T extends Element>(root: T): T {
  if (!root.querySelector('.math-inline, .math-block')) return root
  for (const marker of Array.from(root.querySelectorAll('.math-inline, .math-block'))) marker.replaceChildren()
  return root
}
