# ProseMirror migration prototype

A standalone, isolated prototype for the "maximal" ProseMirror migration
(see the `claude/prosemirror-migration` branch) — **not wired into the
real app, Firebase, or IndexedDB in any way**. Its only job is to validate
the target document model before any of the real app's storage, sync, or
export code gets touched.

## What this proves

- An essay as **one real, schema-validated ProseMirror document**
  (`src/schema.ts`) — nested `section` nodes replace the old app's
  `EssayNode` tree-of-records-glued-by-HTML-marker-divs.
- A footnote's own body is **real document content** (an inline node with
  real text content), not a side record referenced by id.
- A citation chip is a **true atom that always re-renders fresh** from its
  source id — no cached/stale label text, live editing included.
- A comment's anchor is a **mark** (metadata stays off-tree, same as the
  real app already does), not a node.
- Math, lists, blockquotes, and the usual marks (bold/italic/underline/
  link) all round-trip through the schema.

See `src/schema.ts` and `src/nodeViews.ts` for the real documentation —
both have extensive doc comments, including notes on two real bugs found
and fixed while building this (a block-in-inline schema mismatch, and a
`MutationObserver`/`ignoreMutation` NodeView gotcha), left in place since
they're exactly the kind of thing the real migration will hit again.

## Export (`src/export.ts`)

The Markdown + print-HTML export pipeline is ported — click "Export" in
the toolbar for a live preview (Markdown and citation-styled print HTML,
both regenerated from whatever's actually in the editor). The real app's
own `lib/export.ts` splits cleanly into two halves, and that split is the
whole reason this ported so fast:

- **Genuinely new** (`pmEssayToMarkdown` and everything around it): walks
  the PM doc tree directly instead of parsing `EssayNode.draftContent`
  HTML strings. This is the only part that actually needed rewriting.
- **Copied verbatim, zero changes**: `markdownToHtml`, `addPrintChrome`,
  `ensureCitationSpacing`, `moveFootnoteCitationsPastPeriod`,
  `floatPrintFootnotes`, `addAuthorAttribution`, every bibliography-style
  formatter (APA/MLA/Chicago) — all pure string/HTML transforms that never
  cared where the Markdown came from, now proven against the new model too.

**LaTeX export is also ported** (`pmEssayToLatex`) — same shape of work as
`pmEssayToMarkdown` (a second PM-doc walk, LaTeX-flavored this time,
kept as its own pipeline rather than routing through Markdown — real
`\footnote{}`/`\cite{}` are genuine single LaTeX constructs, unlike
Markdown's label-plus-separate-definition workarounds). Visible in the
Export panel's third pane.

Two real bugs found live while building the Export panel, both documented
in place:
- `citationMarkdown`'s own doc comment in `export.ts`: the plain `.md`
  export path was wrapping every citation in the print-pipeline-only
  `<cite class="print-citation">` scaffold meant to be unwrapped later by
  `ensureCitationSpacing` — a stage the plain `.md` path never runs, so
  the raw tag was leaking into literal Markdown text.
- `texEscape`'s own doc comment: the real app's version chains several
  sequential `.replace()` calls, each of which inserts its own `\`/`{`/`}`
  characters that a *later* step in the same chain then matches and
  escapes all over again — confirmed two different ways live (escaping
  `\` first corrupts its own `\textbackslash{}` output; escaping it last
  instead corrupts every other step's own escaped output). Fixed here
  with a single combined regex + replacer function, which sidesteps the
  whole bug class since `String.replace` never re-scans text a
  replacement just produced. Worth porting back to the real app's own
  `lib/export.ts` separately.

## Running it

```sh
npm install
npm run dev    # local dev server
npm run build  # outputs dist/index.html — one single, self-contained file
npm run test   # vitest — covers src/export.ts's own PM-doc-dependent half
```

## Known rough edges (expected at this stage)

- No KaTeX in the live editor — math NodeViews show raw LaTeX text (the
  export panel's print-HTML preview *does* render real KaTeX, via the
  same `renderMathHtml` the real app uses — swapping the live NodeView
  over is the same drop-in change, deliberately deferred).
- No real "insert citation" picker — the toolbar inserts fixed citations
  to two fake in-memory sources (`src/sources.ts`).
- Section drag-and-drop reordering isn't implemented — only "add sibling"/
  "add child" via the toolbar.
- No persistence at all — refreshing the page resets to the sample doc.
