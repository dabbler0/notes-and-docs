# Marginal — an essay & source workbench (prototype)

A local-first workflow manager for writing essays/papers: a searchable
library of cited sources (PDFs with BibTeX + extracted text, or bare
citations) and a draft editor — presented as one continuous, collapsible
document rather than a file tree — with an explicit per-section version
history, inline commenting, and inline citation/quote insertion.

Runs entirely in the browser — no server, no account. Data lives in
**IndexedDB** (structured records) and **OPFS** (PDF blobs).

## Quick start

```
npm install
npm run dev          # local dev server
npm run build:onefile  # produces dist/index.html: everything inlined, open it from disk
```

`npm run build` produces a normal multi-file build (faster to iterate on);
`npm run build:onefile` is the one to hand someone as a single portable file.

## How it's organized

- `src/storage/` — the only layer that touches IndexedDB/OPFS. Everything
  else talks to the `Backend` interface (`docs` for JSON records, `blobs`
  for PDFs). `googleDriveBackend.ts` is an unimplemented skeleton showing
  how a Drive-backed `Backend` would slot in without touching any other
  module — see the comment at the top of that file.
- `src/models/` — data types plus repository functions (`sourcesRepo.ts`,
  `essaysRepo.ts`) that implement the actual domain logic on top of the
  storage layer.
- `src/lib/` — BibTeX parsing, PDF text extraction/rendering (pdf.js), DOM
  Range helpers used by the editor's citation/quote/split/move actions, and
  `treeNumbering.ts` (parent lookups + "Section 2.3.1"-style placeholder
  titles for newly split-off sections).
- `src/components/sources/` and `src/components/essays/` — the UI.
  `EssayWorkspace.tsx` is the whole document: a sticky toolbar acting on
  "whichever section currently has the cursor," plus a recursive
  `SectionBlock.tsx` per section (its own small `contentEditable`, its own
  collapse state, its own version-history button).

## Data model notes

**Sources.** A `Source` is always a BibTeX entry plus a free-text comment;
a PDF and its per-page extracted text are optional. The global "Search
PDFs" tab does a substring search over every source's extracted page text.

**Essay trees & versioning.** An essay is a tree of `EssayNode`s (sections/
subsections). Each node has:
- `draftContent` — a live, freely-editable working copy of its own text.
  Ordinary typing only ever touches this; it is *not* versioned.
- `versions` — an explicit, append-only history. "Make a new version"
  snapshots the current draft; "revert" points the draft/head back at an
  older snapshot. Reverting a node never touches its parent or children.
- `childIds` — the node's current subsections. This is **not** versioned:
  it's deliberately just "whatever is attached right now," independent of
  which historical version of the parent's own prose is showing. That's
  what gives the two behaviors from the brief: reverting one node's text
  can't disturb sibling/parent subtrees (structure isn't part of the
  history at all), and a new version of a node's text carries no memory of
  which subsections existed when an older version was written.

**Presentation vs. structure.** The document is *rendered* as one
continuous, scrollable flow — each section's own text sits directly above
its subsections' text, with only a small heading line marking the seam —
but the underlying data is still the tree above. "Split into subsection"
(select some text, click Split) makes this concrete: the selection becomes
a new child node with a placeholder title ("Section 2.3.1: Untitled",
computed from its position in the tree and left focused for you to type
over); text before the selection just stays put as the parent's own
(shorter) text, and text after it becomes a second new trailing child, since
a node's own text always renders before its subsections and the tail can't
stay in place without changing the reading order. A section is free to
still hold its own text even after it has subsections — nothing forces
text off of non-leaf nodes — the auto-created trailing section is just what
keeps "split" from silently reordering your prose.

**Comments.** Comments attach to a specific version's own content (so they
show up in that version's history entry and in the version-compare view),
with a resolved checkbox. Comment mode is only enabled when the draft has
no unsaved changes relative to its head version, since a comment is meant
to anchor to a real, committed version rather than to a state that has no
version yet.

## What's stubbed / simplified in this prototype

- The Google Drive backend is an interface skeleton only (see above) —
  wiring up real OAuth + Drive API calls is future work, not needed to
  demonstrate the abstraction boundary.
- The rich-text editor is a plain `contenteditable` with a small toolbar
  (bold/italic, citation, quote, split, move); no autosave conflict
  resolution, undo stack beyond the browser's native one, or collaborative
  editing.
- PDF search is a naive substring match over extracted text, not fuzzy or
  ranked.
- BibTeX parsing/formatting covers the common `@type{key, field = {...}}`
  shape (also `"..."` values); it isn't a full BibTeX-grammar parser.
