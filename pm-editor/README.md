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

## Running it

```sh
npm install
npm run dev    # local dev server
npm run build  # outputs dist/index.html — one single, self-contained file
```

## Known rough edges (expected at this stage)

- No KaTeX — math nodes show raw LaTeX text. Swapping in real KaTeX
  rendering is a drop-in NodeView change, deliberately deferred.
- No real "insert citation" picker — the toolbar inserts fixed citations
  to two fake in-memory sources (`src/sources.ts`).
- Section drag-and-drop reordering isn't implemented — only "add sibling"/
  "add child" via the toolbar.
- No persistence at all — refreshing the page resets to the sample doc.
