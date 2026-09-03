# Marginal — an essay & source workbench (prototype)

A local-first workflow manager for writing essays/papers: a searchable
library of cited sources (PDFs with BibTeX + extracted text, or bare
citations) and a draft editor — presented as one continuous, collapsible
document rather than a file tree — with an explicit per-section version
history, inline commenting, and inline citation/quote insertion.

Runs entirely in the browser — no server, no account. Data lives in
**IndexedDB**, both structured records and PDF blobs (see the storage note
below for why blobs aren't in OPFS despite that being the more obvious
fit).

## Quick start

```
npm install
npm run dev          # local dev server
npm run build:onefile  # produces dist/index.html: everything inlined, open it from disk
```

`npm run build` produces a normal multi-file build (faster to iterate on);
`npm run build:onefile` is the one to hand someone as a single portable file.

## How it's organized

- `src/storage/` — the only layer that touches IndexedDB. Everything else
  talks to the `Backend` interface (`docs` for JSON records, `blobs` for
  PDFs — both IndexedDB-backed; see the comment on `IndexedDbBlobStore` in
  `localBackend.ts` for why blobs live there rather than OPFS).
  `googleDriveBackend.ts` is an unimplemented skeleton showing how a
  Drive-backed `Backend` would slot in without touching any other module —
  see the comment at the top of that file.
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
order they appear in the markup. With nothing collapsed, this is deliberately
styled to read like one piece of ordinary prose — no placeholder copy, no
faint borders except a subtle one on hover — the section headings are the
only seams. Saving reverses the parse: it walks the *live* DOM
(`reconstructContent` in `childMarkers.ts`) and rebuilds the content string
from whatever's actually in the shards and which children are mounted
where. There are three structural actions, and all three only ever move
already-written text — nothing is duplicated or discarded:
- **Split into subsection** (select text, click Split) — the only way new
  subsections get created — lifts the selection into a new child node
  right where it was, like promoting a run of text into its own element.
  Whatever came before and after the selection is simply left alone as
  this node's own text, now with the new subsection's marker sitting
  between the two halves (or before/after all of it, if the selection ran
  to one end). There's no dedicated way to add *interstitial* text between
  two existing subsections — short of demoting one back out — since that
  would need inventing text from nothing; splitting only ever redistributes
  text that's already there.
- **Demote** (the ⤴ button in a subsection's header) is the only removal
  action, and it's non-destructive: it un-wraps the section, splicing its
  own current text directly back into its parent's content at the marker's
  position. Any grandchildren embedded in it come along for free, since
  they're just more markers inside that same content string — nothing but
  the now-redundant node record itself goes away.
- **Drag-and-drop** in the restored tree sidebar (`NodeTree.tsx`) reorders
  siblings (drop on the top/bottom edge of a row) or reparents a section
  under a different one (drop on the middle of a row) — dropping is
  rejected if the target is the dragged section itself or one of its own
  subsections, which would create a cycle. This only ever moves an
  existing marker from one content string to another (`moveNode` in
  `essaysRepo.ts`); it never touches any node's version history, on
  purpose — dragging a section around isn't itself a version-worthy edit
  to anyone's text.

**Comments.** Comments attach to a specific version's own content (so they
show up in that version's history entry and in the version-compare view),
with a resolved checkbox. Comment mode is only enabled when the draft has
no unsaved changes relative to its head version, since a comment is meant
to anchor to a real, committed version rather than to a state that has no
version yet.

**Making a new version.** Clicking a section's version pill (`vN`) is a
single explicit action, not a dialog: it freezes the current text into a
new version, clears the section back to blank, and opens an inline split
screen — the whole width the section normally occupies splits into the
frozen old version on the left and the section's own live, fully-featured
editing surface on the right, right in the document flow rather than a
modal. The left side is read-only, but otherwise deliberately looks like
the real document rather than a stripped-down preview: `FrozenPreview.tsx`
mirrors SectionBlock's own markup (same headings, same citation/quote
styling) and recurses into embedded subsections' *current* content the
same way the live editor does — there's no separate frozen snapshot of a
whole subtree, only this one node's own text was ever versioned, so
"what it currently contains" is the closest thing to "what this looked
like" and is what makes the two sides genuinely comparable rather than a
sea of "→ Section Title" placeholders. "Revert to previous version"
restores the old text (`revertToVersion`, unchanged from before); "Done
comparing" just stops showing the comparison and keeps whatever's been
written on the right. Because a subsection is just a marker embedded in
its parent's text (see above), clearing a section's text also clears
whatever markers were in it — its subsections become unreferenced (not
deleted — their own node records and history are untouched, and
`loadNodeMap` deliberately still walks every version's content, not just
the live draft, so an orphaned section stays resolvable for exactly this
kind of frozen-version display) until either reverting restores the old
markers or new ones get split off the new text.

## What's stubbed / simplified in this prototype

- The Google Drive backend is an interface skeleton only (see above) —
  wiring up real OAuth + Drive API calls is future work, not needed to
  demonstrate the abstraction boundary.
- The rich-text editor is a plain `contenteditable` with a small toolbar
  (bold/italic, citation, quote, split); no autosave conflict resolution,
  undo stack beyond the browser's native one, or collaborative editing.
  Split, demote, and drag-and-drop are the only structural actions — moving
  a run of *text* (rather than a whole section) to a different section is
  just the browser's own cut/paste.
- Placeholder section titles ("Section 2.3.1: Untitled") are numbered from
  where a split lands at the moment it happens; splitting again earlier in
  the document renumbers any sibling that still has its auto-generated
  title (so numbers don't go stale), but never touches a title you've
  actually edited.
- PDF search is a naive substring match over extracted text, not fuzzy or
  ranked.
- BibTeX parsing/formatting covers the common `@type{key, field = {...}}`
  shape (also `"..."` values); it isn't a full BibTeX-grammar parser.
