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
  Range helpers used by the editor's citation/quote/split actions,
  `childMarkers.ts` (how a node's content embeds its subsections — see
  below), and `treeNumbering.ts` ("Section 2.3.1"-style placeholder titles
  for newly split-off sections).
- `src/components/sources/` and `src/components/essays/` — the UI.
  `EssayWorkspace.tsx` is the whole document: a sticky toolbar acting on
  "whichever section currently has the cursor," plus a recursive
  `SectionBlock.tsx` per section (its own small `contentEditable` shards,
  its own collapse state, its own version-history button).

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
  older snapshot. Reverting a node never touches any other node.

There is deliberately no separate child-list field. A node's subsections
are embedded directly inside `draftContent`, modeled on how HTML embeds
child elements: a subsection is a literal (non-editable) marker element
sitting wherever the text it was carved out of used to be, with ordinary
text free to come before, after, or between markers (`src/lib/childMarkers.ts`).
"What are this node's children, in what order" is simply "whatever markers
its content currently contains" — so a node is completely free to keep its
own text after gaining subsections; nothing pushes text off of a node just
because it has children.

The live editor never mounts a marker literally — `SectionBlock` parses a
node's content into a (text, child, text, child, …) sequence and renders
each text run as its own small `contentEditable` shard with a recursive
`SectionBlock` for each embedded child mounted in between, in the same
order they appear in the markup. Saving reverses this: it walks the *live*
DOM (`reconstructContent` in `childMarkers.ts`) and rebuilds the content
string from whatever's actually in the shards and which children are
mounted where — which is also how "split" and "demote" work:
- **Split into subsection** (select text, click Split) — the only way new
  subsections get created — lifts the selection into a new child node
  right where it was, like promoting a run of text into its own element.
  Text after the selection becomes a second new trailing child (a node's
  own text always precedes its subsections, so leftover trailing text
  can't stay in place without reordering things); text before it is simply
  left alone.
- **Demote** (the ⤴ button in a subsection's header) is the only removal
  action, and it's non-destructive: it un-wraps the section, splicing its
  own current text directly back into its parent's content at the marker's
  position. Any grandchildren embedded in it come along for free, since
  they're just more markers inside that same content string — nothing but
  the now-redundant node record itself goes away.

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
  (bold/italic, citation, quote, split); no autosave conflict resolution,
  undo stack beyond the browser's native one, or collaborative editing.
  There's no dedicated "move text to a different section" action beyond
  the browser's own cut/paste — split (create) and demote (un-wrap) are
  the only structural actions, per the current design brief.
- Placeholder section titles ("Section 2.3.1: Untitled") are numbered from
  where a split lands at the moment it happens; splitting again earlier in
  the document renumbers any sibling that still has its auto-generated
  title (so numbers don't go stale), but never touches a title you've
  actually edited.
- PDF search is a naive substring match over extracted text, not fuzzy or
  ranked.
- BibTeX parsing/formatting covers the common `@type{key, field = {...}}`
  shape (also `"..."` values); it isn't a full BibTeX-grammar parser.
