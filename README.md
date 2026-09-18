# Marginal — an essay & source workbench (prototype)

A local-first workflow manager for writing essays/papers: a searchable
library of cited sources (PDFs with BibTeX + extracted text, or bare
citations), a quote bank of excerpts saved out of those PDFs independently
of any one essay, and a draft editor — presented as one continuous,
collapsible document rather than a file tree — with an explicit per-section
version history, inline commenting, inline citation/quote insertion,
footnotes, and a per-essay "graveyard" for text cut from the document
without discarding it outright. An existing paper can also be brought in
wholesale by importing a zipped LaTeX project, converted into that same
section-tree shape.

Runs entirely in the browser, local-first — no server of its own. Data
lives in **IndexedDB** on every device, both structured records and PDF
blobs (see the storage note below for why blobs aren't in OPFS despite that
being the more obvious fit); an optional, rudimentary sync layer (see
"Syncing across devices" below) can reconcile that local copy with your own
Firebase project, encrypting anything sensitive before it ever leaves the
device.

## Quick start

```
npm install
npm run dev          # local dev server
npm run build:onefile  # produces dist/index.html: everything inlined, open it from disk
npm test             # runs the sync test suite (vitest) — no network/emulator needed
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
  `essaysRepo.ts`, `quoteBankRepo.ts`, `graveyardRepo.ts`,
  `latexImportRepo.ts`) that implement the actual domain logic on top of
  the storage layer.
- `src/lib/` — BibTeX parsing, PDF text extraction/rendering (pdf.js), DOM
  Range helpers used by the editor's citation/quote/split actions,
  `childMarkers.ts` (how a node's content embeds its subsections — see
  below), `treeNumbering.ts` ("Section 2.3.1"-style placeholder titles for
  newly split-off sections), `export.ts` (Markdown/LaTeX conversion for the
  export dialog — see below; the LaTeX path is zipped up with the `jszip`
  package, also used for backups and for `latexImport.ts` — the parser
  behind importing a zipped LaTeX project, see "Importing a LaTeX project"
  below).
- `src/components/sources/` and `src/components/essays/` — the UI.
  `EssayWorkspace.tsx` is the whole document: a sticky toolbar acting on
  "whichever section currently has the cursor," plus a recursive
  `SectionBlock.tsx` per section (its own small `contentEditable` shards,
  its own collapse state, its own version-history button, its own
  footnotes list). `src/components/Icon.tsx` is the one small hand-drawn
  (inline SVG, no icon font or CDN — see its own doc comment) icon set used
  for cite/quote/link/subsection/footnote/underline/lists in the editor
  toolbar and for comment/graveyard/export/import/backup/sync wherever they
  appear, instead of emoji or a bare text label.
- `src/sync/` and `src/components/sync/` — the optional cross-device sync
  layer: `firebaseClient.ts` (Google sign-in plus the Firestore/Auth
  connections), `syncEngine.ts` (the actual push/pull pass, plus the
  automatic encryption-policy migration described below), `account.ts`
  (the local, per-Google-account encryption key — never uploaded),
  `accountMeta.ts` (the remote key-fingerprint check and account reset),
  `collections.ts` (the list of synced collections and the current
  encryption-policy version — its own small module purely so
  `accountMeta.ts` and `syncEngine.ts` can each use it without importing
  each other), `firebaseConfig.ts` (what's stored locally to make sync
  possible at all), `autoSync.ts` (the polling loop), `qr.ts`
  (pairing-code generation), and `SyncSettingsDialog.tsx`/`QrScanner.tsx`
  for the UI. See "Syncing across devices" below for the full design and
  setup steps.
- `src/test/` — in-memory fakes for Firestore, Auth, and a device's local
  storage, plus a small `deviceHarness.ts` that assembles them into
  simulated "devices" sharing one fake cloud; `src/sync/__tests__/` uses
  it to run the real sync code (`npm test`) against multi-device
  scenarios — see "Syncing across devices" below for what's covered.
- `src/lib/useIsMobile.ts` plus the mobile branches inside `Modal.tsx` and
  `EssayWorkspace.tsx` — see "Mobile layout" below.

## Data model notes

**Sources.** A `Source` is always a BibTeX entry plus a free-text comment;
a PDF and its per-page extracted text are optional. The global "Search
PDFs" tab does a substring search over every source's extracted page text.

Every field of an existing source can be edited after the fact from its
detail dialog, not just at creation: "Edit" on the BibTeX pane turns it into
a raw-text textarea (pre-filled with the current entry re-serialized), and
"Save" re-parses it with the same lenient BibTeX parser the "Add a source"
dialog uses — an entry that fails to parse is left untouched with an error
message rather than silently discarded. The PDF side supports adding a PDF
to a source that never had one, replacing an existing one, and removing one
outright (`setSourcePdf`/`removeSourcePdf` in `sourcesRepo.ts`). Attaching a
new PDF always mints a *fresh* blob id rather than overwriting the old blob
in place — the same reasoning as the demote/split blob-id convention
elsewhere: sync tracks "have I pushed this blob id" by id, so reusing one
for different bytes would let a device that already pushed the old PDF
believe there's nothing left to push. The old blob is only deleted locally
once the new one is safely stored. Either way, `updateSource` bumps
`updatedAt`, so the edit propagates through sync like any other change.

The detail dialog itself (`SourceDetailDialog.tsx`) splits BibTeX/comment
editing and PDF viewing/quoting into two tabs ("BibTeX & notes" and "PDF &
quotes") rather than showing them side by side. They used to share a
`.side-by-side` two-column layout, but a PDF page is rendered at a fixed
size and doesn't shrink to fit a column the way text does, so a wide page
would overflow its half of the dialog and overlap the BibTeX pane next to
it. Giving each concern the full dialog width instead removes the
constraint that caused the overlap in the first place. Opening the dialog
with `initialPage` set (as the Quotes tab's "View in source" link does)
opens straight to the PDF tab, since there's no reason to land on BibTeX
first when the whole point was to jump to a specific page.

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

Every node's own text is really a *sequence* of shards — one per run of
text between (or before/after) its embedded children — so a single screen
position can simultaneously be "the end of" several different nodes at
once: a node's own last shard sits immediately after its last child's
entire rendered subtree, which is also right where *that child's own*
last shard just ended, one level in, and so on up through however many
ancestors are themselves a last child. Each such shard is a real,
separately clickable line, indented to match its own node's depth.
`.node-content:empty:last-child` gives a node's own trailing shard — when
it has nothing in it yet — the same hover-revealed dashed outline every
other editable shard already gets on hover (`.leaf-outline`'s own rule,
just above): invisible at rest, so it doesn't clutter a document that
ends normally, but sweeping the cursor down past the last visible text
reveals each stacked level's own line, at its own indentation, one at a
time as the cursor passes it. Typing in one replaces it with ordinary
text, same as always. Suppressed in Comment mode, which hides every
other editing affordance the same way.

On top of that, the ordinary spacing between one section and the next
(`.section-header`'s own margin) still runs *between* two such stacked
shards belonging to different nodes, with nothing rendered there to catch
a click — a click landing in that specific gap used to hit
`.section-body`/`.editor-scroll` itself, not editable, so focus simply
stayed wherever it already was, and anything typed afterward landed
somewhere else in the document entirely (whatever was last focused,
easily an ancestor several levels up — the actual "my text ended up on
the wrong section" bug this all started from). `EssayWorkspace.tsx`'s
`handleDocMissClick` catches exactly that case — a click that hit the
document area but no actual shard — and falls back to whichever shard is
vertically closest, placing the cursor at its end, the same way Google
Docs (and most block editors) already handle a click below or between
real content instead of leaving it a no-op.

**Comments.** Comments attach to a specific version's own content (so they
show up in that version's history entry and in the version-compare view),
with a resolved checkbox. Turning on Comment mode (top right, next to
Export) is itself what makes that true everywhere at once: it walks every
section in the essay and freezes any with unsaved draft changes into a new
version immediately, rather than lazily one section at a time as you
happen to select text in each — unlike the version pill's own freeze
action, this does *not* clear a section afterward, since the point is to
keep reading/writing on live text, not to open a compare view. Selecting
text and commenting a moment later, in a section edited *after* entering
comment mode, still freezes just that one section first as a safety net,
but the common case (every section already dirty when you turn comment
mode on) is handled up front. Comment mode also turns off contentEditable
and hides every per-section editing control (version pill, history, "make
new version," demote) and the toolbar's own formatting buttons, so the
document reads close to a print view — selecting text to comment on still
works normally either way, since that only ever needed native text
selection, not editing. Commenting itself happens in a small popover
anchored right under the selection (`.comment-widget` in
`EssayWorkspace.tsx`) rather than a modal, so the document stays visible
and in place behind it; clicking anywhere outside the widget or pressing
Escape dismisses it without commenting.

Once added, a comment shows up in the margin to the right of the document,
vertically aligned with its own `<mark class="comment-anchor" data-comment-id>`
in the text — like Google Docs — rather than in a flat, unordered list
(`CommentsPanel.tsx`). That column doesn't scroll on its own: it's a
fixed-height window over a tall inner canvas shifted up by the *document's*
own scroll offset, so a card tracks its anchor as the document scrolls
without the two ever needing to share one scrolling element. Cards that
would overlap (two comments anchored close together) get pushed down just
enough to stay legible, closest-anchor-first. Adding a comment wraps its
anchor text in a `<mark>` right there in the draft, which would normally
read as an unsaved change against the version comment mode just froze —
that's folded straight back into the same version's own content instead of
triggering *another* freeze (and a fresh version) the next time a comment
gets added in that section, since an anchor mark is metadata about where a
comment points, not a new revision of the prose.

**Quoting a source.** One toolbar button ("Insert a quote from a source")
opens `QuoteInsertDialog` — one quote-*selection* interface with two tabs
("From a source": pick any source, drag-select text in its embedded
`PdfViewer` if it has a PDF attached, or type/paste the excerpt straight
into the textarea either way — a source with no PDF just skips the viewer
entirely and asks for the quote (and, optionally, a page number) by hand;
"From the quote bank": search and pick from whatever's already saved there,
see below) feeding two insert *actions* at the bottom, since "block or
inline" is a question about how the
excerpt should land in the document, orthogonal to which excerpt it is —
asking it twice (once per tab, as two near-duplicate dialogs used to) would
just be the same question asked in the wrong place. "Insert as block quote"
drops in a `<blockquote class="quote">` of its own, followed by a citation
in its own paragraph — for an excerpt that should read as set apart from
the surrounding prose. "Insert as inline quote" instead wraps the excerpt in
a `<span class="quote-inline">` with literal curly quote marks and inserts
it, plus its citation, right at the cursor with no paragraph break — for a
shorter excerpt meant to read as part of the sentence it's dropped into
(`insertQuote`/`insertInlineQuote` in `EssayWorkspace.tsx`). Both actions
pass a `page` through to the citation chip and, for the block form, to the
`data-page` attribute the quote itself carries. Neither export path
(Markdown/LaTeX/print) needs to special-case `quote-inline`: unlike a
`blockquote`, which markdown/LaTeX export both recognize and reformat, the
inline span's surrounding quote marks are literal characters in the
content, so it falls through the same plain-inline-text handling a citation
or source link already gets.

**Searching within a PDF.** `PdfViewer` — used both from a source's own
detail view and from the "From a source" tab of `QuoteInsertDialog` — has its
own search box above the page controls, independent of the global "Search
PDFs" tab (which finds *which source* to open, not a spot within one already
open). Typing a query jumps straight to its first hit, wherever in the
document that is, and the ↑/↓ buttons (or Enter/Shift+Enter in the box)
step through every occurrence in reading order, crossing page boundaries as
needed and reporting an overall "N of M" count. The search itself
(`findPdfMatches` in `lib/pdf.ts`) runs against the source's already-extracted
`pageTexts` rather than re-parsing the PDF, so it can count matches on pages
that aren't even the one currently rendered — which is what lets it jump
pages at all. Only the *currently rendered* page's matches get visually
highlighted (a `<mark>` wrapped around the hit within the invisible text
layer, with the active occurrence in a darker shade), since that's the only
page with real text-item positions to highlight against; a query that happens
to be split across two adjacent text items (rare, but possible mid-line) is
still found and counted by `findPdfMatches`, just not highlighted, since
highlighting works item-by-item.

**The quote bank.** A `QuoteBankEntry` (`quoteBankRepo.ts`) is a quote saved
out of a source's PDF independently of any essay — from a source's own
detail view (Sources tab), drag-select text in its embedded `PdfViewer` (or
type/paste one in) and "+ Add to quote bank" with an optional annotation
explaining why it's worth keeping. Saved quotes are browsable and
searchable on their own in the "Quotes" tab (title/author, page, and
annotation all match a search), each with a "View in source" link that
reopens that source's detail view straight to the page it was quoted from
(`SourceDetailDialog`'s new `initialPage` prop) — and, from any essay, in
the quote-insertion dialog's own "From the quote bank" tab, so a quote saved
once can be reused across as many drafts as it's actually relevant to,
rather than living wherever it first got quoted. A quote whose source has
since been deleted stays listed (nothing here is ever cascade-deleted along
with its source — same tombstone convention as everything else) but loses
its "View in source" link and drops out of the insertion dialog's bank tab,
since there's no citation left to attach it to.

**The graveyard.** "Send to graveyard" (the cross-and-ground-line icon, at
the end of the formatting toolbar) cuts the current selection out of the
document — same as a delete — but keeps it, verbatim HTML and all, as a
`GraveyardFragment` (`graveyardRepo.ts`) attached to the essay it came from,
rather than discarding it. Unlike the insert-a-quote/citation tools, this
acts directly on whatever's currently selected instead of opening a dialog
first — there's nothing to pick, so there's no reason to risk losing the
live selection to a dialog stealing focus. Fragments are browsed from a
right-hand panel that now shows either Comments or the Graveyard — never
both, since it's genuinely one column with a small tab switcher
(`.right-panel-tabs`) at its top, not two independently-toggleable panels —
with Copy (plain text, via the clipboard API where available) and Delete on
each card; sending a selection there automatically switches the panel to
the Graveyard tab so it's obvious where the cut text went. A fragment
remembers the node it came from (id *and* a title snapshot taken at the
moment of removal) purely as a reference — that reference is never
dereferenced to decide whether to show the fragment, specifically so it
keeps showing up even once that node is gone (deleted outright, split away,
merged elsewhere): the title snapshot is what keeps a fragment reading
sensibly once that's happened, since the live node title obviously isn't
there to ask anymore.

**Autoformatting lists.** Typing `- ` or `* ` at the very start of an
otherwise-empty line turns it into a bulleted list; `1. ` (any number, not
just 1) turns it into a numbered one — the same shorthand most word
processors support, so a list rarely needs the toolbar's own list buttons
at all. `autoListify()` in `SectionBlock.tsx` checks this on every `input`
event, but only actually does anything the instant the just-typed
character is the space that completes one of those two markers
(`e.data === ' '` on the native `InputEvent`) — never mid-word, never
while deleting. "Very start of an otherwise-empty line" is enforced by
reading the *whole* line's text up to the cursor (a `Range` from the start
of the nearest block ancestor to the caret, not just the current text
node) and requiring it to be *exactly* the marker: `See item 1. really`
never triggers, since there's real text before the `1. `. Once confirmed,
it strips the marker text from the DOM and calls the same
`document.execCommand('insertOrderedList' | 'insertUnorderedList')` the
toolbar's own list buttons use — this is DOM-first rather than going
through Preact state deliberately, for the same reason `persist`'s own
doc comment gives: a shard is an uncontrolled `contentEditable`, so this
is just another direct edit to the live DOM the browser's already editing,
exactly like a toolbar click would be.

**Footnotes.** "Insert footnote" (a small baseline with a raised digit)
drops an empty `<sup class="footnote-ref" data-footnote-id>` marker at the
cursor and hands focus straight to the new footnote's own body, listed
right under that section's text, ready to type into immediately — the same
"create it, then focus its editable surface" shape "Split into subsection"
already uses for a new child's title. A footnote's actual content lives in
`EssayNode.footnotes` (see the `Footnote` type in `models/types.ts`), not
inline in the marker itself — the marker is just a reference, exactly like
a subsection marker references a child node — so numbering is never stored
anywhere: it's purely how many footnote-ref markers precede this one in
the node's own content, computed with a CSS counter scoped to each node's
own `.section-body` for the inline superscripts, and independently for the
list underneath (see the CSS's own comment on why those are deliberately
*separate* counters, not one shared one). Deleting a footnote (the "×" on
its own row) removes both its record and its marker, if the marker's still
actually mounted. Footnotes aren't versioned — there's no per-footnote
history the way a node's own text has `versions` — they just always reflect
whatever's currently in `node.footnotes`, comparing-a-version or not.
`node.footnotes` is optional precisely so a node saved before this feature
existed doesn't need any migration: every read goes through
`essaysRepo.nodeFootnotes()`, which treats "the field is absent" and "the
field is an empty array" identically everywhere in the app, export included.

**Linking to a source.** "🔗 Link to source" wraps the current selection
(or, with nothing selected, the source's own title) in a real hyperlink to
that source's URL — picked from the same source-search dialog citations
use, filtered down to sources that actually have one — and always tacks on
a citation right after it, so a reader can tell which source a bare link
points to without following it. A source's URL is one of the optional
fields (alongside DOI, journal/venue, and a note) in the "Add a source"
dialog's manual-entry fields; when a source has a URL, its citation chip
becomes a real link to it too (`citationHtml()` in `lib/bibtex.ts`) instead
of the inert `<cite>` used when there's nowhere to send you.

**Exporting a draft.** The topbar's "⬇ Export" opens a dialog with three
paths (`lib/export.ts`, `ExportDialog.tsx`), all walking the node tree the
same way the editor renders it — `parseSegments()` on each node's own
`draftContent`, recursing into embedded children in document order — so
what's exported matches what's on screen rather than some separately
versioned snapshot:
- **Markdown** — headings by depth, bold/italic, links, and blockquotes;
  citations keep their plain visible label text rather than becoming
  footnotes. Real footnotes (from `node.footnotes`, not citations) *do*
  become proper Markdown footnotes — `[^fn3]` inline, with a `[^fn3]: ...`
  definition collected at the very end of the document under a `---` rule.
  Labels are a document-wide running count (`fn1`, `fn2`, ...), never the
  per-node-local number the editor itself shows next to a footnote — since
  a real Markdown renderer matches `[^label]` document-wide, reusing small
  per-node numbers as labels would silently conflate two different
  sections' own "footnote 1."
- **PDF** — the exact same Markdown, rendered back to a printable HTML
  page in a new tab, which then opens the browser's own print dialog;
  "Save as PDF" there is the actual PDF-generation step, so this needs no
  PDF-writing library of its own. `markdownToHtml()` understands its own
  sibling function's footnote syntax specifically (not general Markdown
  footnote syntax) — an inline `[^label]` becomes a superscript link, and
  the trailing `[^label]: ...` lines become a numbered list at the very
  end of the page, both connected by a matching `#fn-label` anchor.
- **LaTeX project** — a `main.tex` using `\section`/`\subsection`/
  `\subsubsection` and, past that depth, `\paragraph`/`\subparagraph`, with
  citations rendered as `\cite` or `\footcite` (a dialog toggle — the
  latter switches the preamble to `biblatex`/`\printbibliography` instead
  of `natbib`/`\bibliography`) plus a `references.bib` built from exactly
  the sources actually cited in the essay, zipped together with JSZip. Real
  footnotes round-trip the cleanest of the three formats here: LaTeX's own
  `\footnote{...}` is inline and self-numbering, so a footnote-ref marker
  converts straight to one, no separate label or definition needed.

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
sea of "→ Section Title" placeholders. "Revert to this version" restores
the old text (`revertToVersion`, unchanged from before); "Done comparing"
just stops showing the comparison and keeps whatever's been written on
the right. Because a subsection is just a marker embedded in its parent's
text (see above), clearing a section's text also clears whatever markers
were in it — its subsections become unreferenced (not deleted — their own
node records and history are untouched, and `loadNodeMap` deliberately
still walks every version's content, not just the live draft, so an
orphaned section stays resolvable for exactly this kind of frozen-version
display) until either reverting restores the old markers or new ones get
split off the new text.

Every version a section has ever had is kept — nothing is pruned — and
the 🕓 button next to the version pill opens the full list (newest first,
current one marked), each with its own non-destructive "View" that shows
it side by side with whatever's currently there without freezing or
clearing anything. That's the only difference from clicking the version
pill itself: browsing history is just look-don't-touch, so reverting to
something several versions back doesn't require re-living every version
in between the way the version-pill's freeze-and-clear action would.

## Importing a LaTeX project

"Import LaTeX project" (Drafts tab) turns a zipped `.tex`/`.bib` project
into a real draft — the mirror image of the LaTeX export above, but
necessarily far less exact: it's a small, deliberately narrow parser
(`lib/latexImport.ts`), not a LaTeX engine, built to make sense of what a
typical single-author paper's own `.tex` file actually contains, not the
whole language. Anything it doesn't recognize degrades to plain text
rather than being silently dropped.

- **Unzipping and file selection** happen in the browser (JSZip, same
  library the backup/export features already use) — nothing is uploaded
  anywhere. Every `.bib` file found is concatenated and parsed with the
  same lenient BibTeX parser "Add a source" uses; every `.tex` file is a
  candidate for the *main* file, picked by which one actually contains
  `\begin{document}` (falling back to sheer file size if none do), then
  the shallowest path, then a conventional name (`main.tex`, `paper.tex`,
  ...) — see `pickMainTexFile()`.
- **Sources come first.** Every new bib entry becomes a real `Source`
  (skipping any whose key already matches an existing local source, so
  re-importing the same project twice doesn't create duplicates) *before*
  the `.tex` file is parsed, specifically so `\cite`/`\citep`/`\citet`/
  `\footcite{key}` can resolve straight to a real citation chip
  (`citationHtml()`, the exact same one the editor's own "Cite a source"
  tool inserts) while parsing, rather than needing a separate
  patch-up pass afterward. An unresolvable key still degrades gracefully —
  a plain `[key]` in the text plus a warning shown in the import summary —
  rather than being dropped.
- **Structure**: `\section`/`\subsection`/`\subsubsection` become nested
  child nodes (a level skip, e.g. a `\subsubsection` with no enclosing
  `\subsection`, just nests under the nearest real ancestor instead of
  fabricating a placeholder one); a `\begin{abstract}` becomes its own
  leading "Abstract" child if present; `\textbf`/`\textit`/`\emph`/
  `\underline` and a `quote` environment become their normal editor
  equivalents (`<b>`/`<i>`/`<u>`/`<blockquote class="quote">`).
- **Footnotes are the interesting case.** Every `\footnote{...}` is
  checked against the resolved bibliography *first*, through two matchers
  in `matchFootnoteToSource()` (`lib/latexImport.ts`):
  - A **shorthand-citation** check first, for a footnote that's *nothing
    but* a compact hand-typed citation — anchored to the whole trimmed
    footnote text, not just a prefix, which is what actually enforces "no
    extraneous text": a real sentence that happens to mention a name
    simply doesn't match this shape at all. Recognizes `Lastname`,
    `Firstname Lastname`, optionally followed by `, Title` (plain,
    `\textit{...}`-wrapped, or quoted — formatting is already gone by the
    time this runs) and/or a trailing page reference (`p. 12`, `p12`,
    `pp. 12-15`, `pp 12–15`, ...) in any combination — see
    `parseShorthandCitation()`/`resolveShorthandCitation()`. A bare last
    name, or last name + title with no year at all, is only ever accepted
    here when it resolves to a **unique** source; two sources sharing a
    surname fall back to the surname alone being ambiguous, get
    disambiguated by a given first name or by title-keyword overlap when
    either is present, and stay unresolved (never guessed at) otherwise.
  - Free-text scoring as a fallback, for a footnote embedded in an
    otherwise ordinary sentence: mentions a known source's year and/or
    author's last name, optionally reinforced by title-word overlap or a
    bare page reference, with a year or author match specifically required
    (title/page overlap alone is deliberately never enough, precisely so
    an ordinary aside that happens to share a word — or a number that
    looks like a page — with someone's paper doesn't get misidentified).
    Like the shorthand matcher, this only ever returns a *uniquely*
    top-scoring source — a tie is treated as no match, not a coin flip.

  Either way, a footnote that resolves becomes a real citation; one that
  doesn't clear either bar becomes an actual footnote (a fresh `Footnote`
  entry plus its `<sup>` marker, the same shape "Insert footnote" produces
  by hand). A `\footcite{key}` is never run through either matcher at all
  — it already names a bibtex key explicitly, so it's just a citation,
  resolved the same way `\cite` is.
- **What's imported** (a summary shown after the fact): how many
  bibliography entries were added vs. already existed locally, how many
  footnotes were recognized as citations vs. kept as real footnotes, and
  any warnings (an unresolved citation key, mainly).
- **Persistence** (`models/latexImportRepo.ts`) writes the parsed tree
  directly as `Essay`/`EssayNode` records with ids already assigned during
  parsing (rather than going through `essaysRepo.createEssay`/
  `createChildNode`, which each mint their own) — the one part of the
  whole flow that isn't a pure function, kept as thin as possible around
  the actual parser so the parser itself (unzipping and DB writes aside)
  stays fully unit-testable without a database at all
  (`lib/__tests__/latexImport.test.ts`).

## Mobile layout

Below a 720px viewport width, four things change; nothing else does —
splitting, versioning, comments, citations, and export all work exactly
the same way on mobile as on desktop.

- **The app-level topbar (brand, tabs, Backup/Sync) wraps onto two rows
  instead of one.** With four tabs, the single-row layout could run wider
  than a narrow phone's screen with nothing to indicate it — Backup/Sync
  would end up positioned off the right edge, reachable only by a
  horizontal scroll nothing invited you to try. `flex-wrap` on `.topbar`
  lets the tab row drop to its own line below brand/Backup/Sync (which
  stay short enough to always fit on the first line together), and that
  tab row is independently horizontally scrollable in case even four tabs
  alone don't fit a particularly narrow screen. `.essay-header` reuses the
  same `.topbar` class but doesn't have a `.tabs` child, so this never
  visibly changes anything there — its own content (an already-flexible
  title input) just shrinks to fit rather than needing to wrap.
- **Every modal is a full-screen view instead.** `Modal.tsx` is the one
  place every dialog in the app goes through (add/detail source, the
  citation/quote/link pickers, export, sync settings), so this is a single
  branch there: below the breakpoint it renders as `position: fixed; inset:
  0` with a pinned "← Back" bar, instead of a backdrop behind a centered
  card. No dialog anywhere had to change its own code for this.
- **The outline and comments aren't side columns.** There's no room for
  them to coexist with the document on a phone screen, so on mobile they
  simply aren't rendered as persistent columns at all — two toolbar buttons
  ("☰ Outline," "💬 Comments") open them as their own full-screen views
  (through the same `Modal`). Comments there render as a plain scrollable
  list (`CommentsPanel`'s `mode="list"`) rather than the desktop's
  margin-aligned cards, since there's no document visible alongside them to
  align a card against; tapping a row jumps back into the document at that
  section.
- **The version-compare split screen stacks vertically instead of
  side-by-side**, and — on both orientations, not just mobile — each pane
  scrolls independently rather than growing together with the surrounding
  page, so comparing a long old version against a long new one doesn't mean
  scrolling the whole page just to read the bottom of one side.

## Syncing across devices

Sync is opt-in and rudimentary by design: no realtime updates, no
conflict-resolution UI, one polling interval. What it does do: every
device keeps a full local copy of everything in IndexedDB (nothing here
changes that — sync is a reconciliation pass layered on top, not a
replacement for local storage), and PDFs and essay drafts are encrypted
before they ever leave the device.

**Two independent guards, not one.** An account is identified by signing
into a **Google account** (via Firebase Auth) — that's what a Firestore
security rule checks, so nobody without access to that specific Google
account can even fetch your ciphertext. Separately, an **AES-256 encryption
key never leaves the device it was created or imported on** — Google
sign-in is not a substitute for it, and vice versa: someone who somehow got
your Google session could read nothing but ciphertext, and someone who
somehow got your key still can't reach Firestore without also being signed
into the right Google account. Moving the key to a new device (QR code, key
file, or pasted text) is what "adding a device to your account" means;
there is no password and no separate signup, just Google sign-in plus that
key.

It talks to **Firestore only** — deliberately not Cloud Storage, even for
PDFs (see "PDFs through Firestore" below) — specifically so the whole
thing stays usable on Firebase's no-billing-required **Spark** (free)
plan. As of late 2024 Google requires the pay-as-you-go Blaze plan just to
*provision* a Cloud Storage bucket at all, even to stay within its own
free-tier limits, which would have made "free to run" and "uses Storage"
mutually exclusive.

**Setting up your own Firebase project.** This is a single static HTML
file with no server of its own, so it can't ship a working sync backend
out of the box — each install points at *your own* Firebase project:

1. Create a Firebase project (free tier is enough), enable **Firestore**,
   and under Authentication → Sign-in method enable **Google** (not
   Anonymous — the whole point now is a real, checkable identity).
2. Set these Firestore rules (`accounts/{userId}` here is the signed-in
   Firebase Auth **uid**, not a locally-generated id; the recursive
   `{document=**}` covers the flat essays/nodes/sources collections, the
   `meta/account` fingerprint doc, and the nested `blobs/{id}/chunks/{i}`
   subcollection PDFs live in, at any depth, with one rule):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /accounts/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```
   This is genuine per-account enforcement, not obscurity: Firestore itself
   refuses a request whose signed-in uid doesn't match the path, regardless
   of whether the caller knows or guesses another account's id.
3. In Project settings → "Your apps," add a web app (`firebase init
   hosting` typically already leaves you with one). Its config object is
   what Sync settings needs — but see the next section before pasting it
   in by hand.

**If this app is deployed on that same project's own Firebase Hosting**
(see "Deploying to Firebase Hosting" below), it doesn't need pasting in at
all: `detectHostingConfig()` in `sync/firebaseConfig.ts` fetches Hosting's
own reserved `/__/firebase/init.json` on startup, which Firebase Hosting
auto-serves with the project's config for exactly this purpose, and stores
whatever it finds (tagged `source: 'auto'`) — so every visit to that
hosted URL, on every device, is already connected to the right project
with nothing typed in. This only resolves to something real when actually
served *by* Firebase Hosting for a project that has a registered web app;
running the app any other way (`npm run dev`, a downloaded HTML file, a
different host) gets a 404 there, and Sync settings falls back to the
manual-paste form below. An explicitly pasted-in config is never
overwritten by auto-detection, even on an origin that also has one — the
"Use a different project" button in Sync settings is how a device opts
back into pointing at a project by hand.

Once one way or the other gets a config in place, the rest of setup is
the same:

**Signing in and setting up a key.** Sync settings' "Sign in with Google"
button uses Firebase Auth's normal OAuth popup flow — which needs a real
`https://` (or `localhost`) origin, so it doesn't work from a copy of this
app opened straight off disk over `file://`; use the hosted copy (or `npm
run dev`) to sign in, and the key can then be exported to a device running
however you like. Once signed in, what happens next depends on whether
this Google account has ever had a key set up anywhere before, which the
app checks via a small non-sensitive fingerprint doc it keeps in Firestore
(see "The key-fingerprint check" below) — never the key itself:

- **Never set up before** → "Create key" generates a fresh AES-256 key
  right there in the browser (or "Use an existing key" if you're deliberately
  restoring one from a backup file on a brand-new account).
- **Already set up, this device doesn't have it** → the app refuses to
  silently mint a second, conflicting key. Instead it prompts you to bring
  over the *existing* key: scanning another device's QR code, uploading its
  downloaded key file, or pasting the key JSON directly. Camera-based QR
  scanning needs a secure context (`https://`, or `localhost`) to get
  camera access at all; on an origin that can't get there it falls back to
  a plain message and the key-file/paste paths, which work everywhere. Each
  candidate key is checked against the account's stored fingerprint
  *before* being adopted, so pasting the wrong device's key is rejected
  with an explanation rather than silently corrupting sync.
- **Lost the key file entirely** → a deliberately buried "I've lost the key
  file — reset this account instead" link, behind a warning box, a
  type-"RESET"-to-confirm text box, and a native confirm dialog. This wipes
  every remote document for the account (structured records, PDF blob
  chunks, the fingerprint doc) and bootstraps a brand-new key — a genuine
  last resort, since it permanently orphans any other device still holding
  the old key, which is exactly why it's made this hard to reach by
  accident rather than offered as a normal option.

The key/bundle payload transferred by QR/file/paste is just `{ key, v }` —
the key alone; which account it belongs to is Google sign-in's job, not
the bundle's.

**What's encrypted, what isn't.** The policy (`SENSITIVE_FIELDS` in
`syncEngine.ts`) is: every user-editable field is AES-256-GCM encrypted
client-side before being written to Firestore, bundled as one `_enc:
{iv, data}` field per document — an essay's title, a section's title and
its `draftContent`/`versions` (so: the actual prose, and every comment
attached to any version), a source's whole BibTeX entry plus its
free-text comment and its PDF's original filename, a quote bank entry's
text/annotation/page number, a footnote's or graveyard fragment's own
HTML. PDF bytes are encrypted the same way before being chunked into
Firestore documents (see "PDFs through Firestore" below), with the IV
kept on the manifest document. Left as plaintext metadata: `id` and other
system-generated references — a node's `essayId`, an essay's
`rootNodeId`, a quote's `sourceId`, a PDF's `pdfBlobId`, and so on, none
of which are ever user-typed content, and which node has which parent
(implicit in `draftContent`'s markers, themselves inside the encrypted
prose) — plus `createdAt`/`updatedAt`/the deletion tombstone, which are
system-stamped rather than user-entered, and which for `updatedAt`
specifically *has* to stay plaintext no matter what: Firestore needs to
filter and sort on it server-side for incremental sync's own
`where('updatedAt', '>', cursor)` queries to work at all. This split is
deliberate, not laziness: it's what lets a device list which local docs
are dirty and pull only what's changed without decrypting everything
first, while still keeping every piece of actual user content — not just
the prose — unreadable to anyone who can merely read your Firestore data.

This wasn't always the policy — titles, a source's BibTeX/comment/PDF
filename, and a quote's page number used to sit in that same plaintext
metadata, unencrypted (`CURRENT_ENCRYPTION_VERSION` in
`sync/collections.ts` — bumped to 2 for this tightening, with the version
history documented right there). Rather than leaving already-synced
accounts stuck with old, less-encrypted remote data forever, each
account's own remote `meta/account` doc records the encryption version
its data is *confirmed* fully in; the next device to sign in and sync
checks that first, and if it's behind, runs `migrateAccountEncryption()`
before anything else that pass — a full read of every document in every
synced collection, decoding each one (already has to tolerate a doc that's
entirely old-shape, entirely new-shape, or any mix, since a doc can easily
have been pushed once years ago and never touched since) and re-encoding
it under the current policy, then writing it straight back. `updatedAt`
(and everything else that was never sensitive) passes through completely
unchanged, so this can never look like a real edit to any other device's
last-write-wins comparison — only the *shape* of the ciphertext changes,
never the content or its timestamp. This costs one full collection scan
per account, the first time any device syncs after the policy changes —
never once per device, since the migrated version is recorded remotely
the moment it finishes.

**PDFs through Firestore.** A Firestore document caps out at ~1MiB, so a
PDF (encrypted, then base64-encoded) is split into 700,000-character
chunks well under that cap: one manifest document
(`accounts/{uid}/blobs/{blobId}`, holding the encryption IV and a chunk
count) plus that many chunk documents in a `chunks` subcollection under it,
each just one base64 string field. A local blob not yet known to have been
pushed is uploaded once (blob ids are never reused for a different file,
so simple "pushed already?" membership is enough — no timestamp comparison
needed); a blob referenced by a synced Source but missing locally is
reassembled from its manifest and chunks and decrypted. The tradeoff for
staying on Firestore alone: a multi-MB PDF costs several Firestore
read/write operations instead of one Storage upload/download, which counts
against the Spark plan's daily quota (50K reads / 20K writes free per day)
faster than Storage's own free tier would have — worth knowing if syncing
many or large PDFs.

**How sync actually decides what to send.** Every local record already
carries an `updatedAt`; each pass pushes anything newer than the last push,
and pulls anything remote newer than the last pull, applying a remote
change locally only if it's newer than what's already there
(last-write-wins, no merge) — via `backend.docs.put` directly rather than
through EssaysView/SourcesView's own state, which is why a pass that pulls
anything also fires a `sync/syncEvents.ts` notification those views
subscribe to, so a background sync doesn't leave an already-open list
looking stale until it happens to remount on its own. Deletion is a
tombstone (`deleted: true` plus a fresh `updatedAt` on the essay, source,
or node record — see the `deleted` field's own doc comment in
`models/types.ts`), not a hard delete, specifically so a deletion is itself
a synchronizable *change*; every list/read in `essaysRepo`/`sourcesRepo`
filters tombstoned records out, so nothing else in the app needs to know
this exists. Sync runs automatically every 30 seconds while the app is
open (toggle in Sync settings) and on demand via "Sync now."

**The security model, stated plainly.** This is genuine per-account access
control, not obscurity: the Firestore rule requires the caller's signed-in
Firebase Auth uid to match the path being read or written, which Firestore
itself enforces server-side — knowing or guessing someone else's account
id gets you nowhere. On top of that, independently, anything worth reading
is encrypted client-side with a key that never reaches Firebase at all —
so even a compromised or curious server operator (who, unlike an outside
attacker, *does* pass the Firestore rule for every account) sees only
ciphertext. The two guards protect against different things and neither
stands in for the other: Google sign-in without the key gets you
inaccessible ciphertext; the key without being signed into the right
Google account never gets Firestore to hand over anything to decrypt in
the first place.

**The key-fingerprint check.** So that a second device can tell "this
account already has a key, and it isn't the one I have" *before* touching
any real data, each account keeps one small Firestore doc
(`accounts/{uid}/meta/account`) holding a SHA-256 fingerprint of the raw
key bytes — never the key itself; a fingerprint doesn't let anyone
reconstruct or verify-by-brute-force the actual key any faster than
guessing at random. The Firestore rule above scopes that doc to the
account's own uid same as everything else, so only the signed-in owner can
even read whether one exists.

**Testing sync locally.** `?fbEmulator=host:firestorePort:authPort` on the
app's URL (e.g. `?fbEmulator=127.0.0.1:8180:9199`) points Firestore/Auth at
a local `firebase emulators:start` suite instead of the real project — for
trying out sync, or testing security-rule changes, against disposable
local data. Not something an end user ever needs to set.

**Known gaps.** No realtime listeners — a change on another device shows
up on the next 30-second tick or manual sync, not immediately. No conflict
UI — a genuine simultaneous edit on two devices just keeps whichever
timestamp is later, silently. Deleting a source removes its blob chunk
documents' *local* reference immediately but doesn't delete the remote
copies (a minor, unreclaimed storage cost, not a correctness issue). A
fresh device seeds its own local demo essay/source (see `seed.ts`) before
it ever syncs, so the first sync from a second fresh device will carry its
own separate copy of that same demo content in as a genuinely distinct
essay — harmless, just occasionally a mildly confusing duplicate the first
time two brand-new installs meet each other.

**The cursor watermarks, and two races that used to exist around them.**
Each device tracks its own local "pushed up to" and "pulled up to"
watermarks. Two subtleties in how those advance were found (via the
sync test suite — see below) and fixed:
- *Push could clobber a newer remote edit.* "Dirty since I last pushed"
  only meant "I have a change to send" — it said nothing about whether the
  remote copy had moved on without this device knowing (its first-ever
  sync of a doc it's actually had all along, after another device already
  pushed something newer). Push now reads the remote doc's own `updatedAt`
  before writing and skips if what's already there is newer — one extra
  read per dirty doc, making push symmetric with pull's own always-existing
  last-write-wins check.
- *An empty pull pass could poison future pulls.* The pull watermark used
  to be stamped with wall-clock "now" at the end of *every* pass, even one
  that pulled nothing. If another device later pushed something whose own
  `updatedAt` happened to predate that now-advanced watermark — which
  genuinely happens, not just in theory: restoring an old local backup
  (see "Backup & restore" below) deliberately preserves each record's
  original `updatedAt` rather than bumping it to "now," so a merge-mode
  restore can't overwrite newer local work with older backup content —
  this device would never pull it, having never actually seen it. The
  watermark now only ever advances to the latest `updatedAt` a pass
  actually *observed* in its own query results; an empty pass observes
  nothing, so it no longer moves the watermark at all, and nothing pushed
  later can end up "behind" a watermark that never legitimately passed it.
  Sync settings' "Force a full resync" button (next to "Sync now") remains
  as a manual fallback for the narrower race the fix doesn't fully close
  — two devices' pushes crossing paths within the same pass — by ignoring
  the watermarks entirely for one pass; it's always safe to run, since the
  per-doc last-write-wins check still applies underneath, just costlier
  (it re-reads everything instead of only what changed).

Both races, plus ordinary multi-device propagation, tombstoned deletions,
PDF blob round-tripping, the encryption-key fingerprint gate, account
reset, quote bank and graveyard propagation (including a graveyard
fragment staying listed after the node it references is deleted — see the
quote bank/graveyard section above), an account that predates the quote
bank/graveyard entirely syncing cleanly and then adopting them without
issue (both devices simply never write to those collections until one of
them starts — nothing about a collection with zero prior documents needs
special-casing), a node saved before footnotes existed (no `footnotes`
field on the object at all, not even an empty array) syncing cleanly and
then having a footnote added on top of it, overlapping concurrent
`runSyncPass` calls sharing one pass instead of double-running (see
`syncEngine.ts`'s own `inFlightPass`), that a fresh push never leaves any
user-editable field in plaintext (`src/sync/__tests__/encryptionPolicy.test.ts`
inspects the raw fake-Firestore document directly, not just what comes
back out through decryption), and the encryption-policy migration itself —
a hand-seeded account in the old, partially-plaintext shape gets fully
re-encrypted on its next sync with `updatedAt` untouched, the remote
`encryptionVersion` recorded afterward so a second sync doesn't redundantly
re-touch it, and a brand-new account never running the migration at all —
are covered by an automated test suite (`npm test`, `src/sync/__tests__/`)
that runs the real sync code
against in-memory fakes of Firestore, Auth, and each device's own local
storage (`src/test/`) — no network or emulator process needed, so it runs
in a couple of seconds and stays easy to extend with more scenarios as
they come up. `SYNCED_COLLECTIONS` in `syncEngine.ts` is the single list
every push/pull loop iterates over generically, so a new collection (the
quote bank and graveyard both went in this way) is a matter of adding it
there plus its `SENSITIVE_FIELDS` entry, not touching the loops themselves.

This was verified end-to-end against a real `firebase emulators:start`
Firestore + Auth instance (not just unit-level pieces), across three
independent browser profiles: one Google identity signing in fresh and
bootstrapping a key; that same identity signing in on a second device with
no local key, correctly refusing to bootstrap a second one and instead
detecting the existing account, rejecting a deliberately-wrong key with an
explanation, then accepting the correct key transferred by file and
successfully syncing (an edited essay's text and a ~2MB PDF blob both
propagating byte-for-byte through the chunking scheme above); and a
*different* Google identity confirmed unable to see any of the first
account's data, exercising the `request.auth.uid == userId` rule for real.
What's *not* verified this way is the actual interactive Google
popup-sign-in click-through itself: this sandbox's network policy blocks
both Firebase's production domains and, it turns out, the handful of
external calls `signInWithPopup` needs to even open a popup, regardless of
the Auth emulator being otherwise fully reachable. Everything downstream
of "a Google account is signed in" — including the emulator's own uid,
fingerprint doc, and Firestore rules — was exercised for real by signing in
through the Auth emulator's documented `signInWithCredential` test path
instead of the popup UI; only that one interactive step needs confirming
yourself, on a live project, before relying on this.

## Backup & restore

Independent of sync — this works with no Firebase project or account
configured at all, since it's just a snapshot of what's already local.
"💾 Backup" in the topbar (`lib/backup.ts`, `BackupDialog.tsx`) exports
*everything* on the device (every essay, section, version, comment, the
text graveyard, source, saved quote, and PDF) as one `.zip` — a
`data.json` manifest plus a `blobs/` folder — for safekeeping or moving to
a new browser/device by hand. `quotes`/`graveyard` are read with `?? []`
on restore, so a backup made before either feature existed still restores
cleanly — it just has nothing to contribute for them. Covered by
`src/lib/__tests__/backup.test.ts`: a manifest built with that older
(pre-quote-bank/graveyard) shape restores without error in both merge mode
(existing local quotes/graveyard entries survive untouched) and replace
mode (wiped along with everything else, same as any other replace restore
— there's nothing in an old snapshot to bring them back as), plus a
plain export → wipe → restore round trip for the new collections
themselves.

Unlike sync's payload, this file is **not encrypted**: it's meant to
leave the device only under your own control (onto your own disk, into
your own cloud drive), not to cross a network boundary the way a sync
payload does, so there was no reason to pay the complexity of key
management twice for the same data.

Restoring offers two modes:
- **Merge** (the default, safe to run anytime): applies a backup record
  only where it's newer than what's already local — the same
  last-write-wins rule sync uses — so restoring an old backup on top of
  newer local work can't clobber that work, and can't resurrect something
  you deleted more recently than the backup was taken.
- **Replace everything**: wipes local data first, then loads the backup
  verbatim. This is the actual disaster-recovery path — "this device's
  data is gone or corrupted, put it back exactly as the backup has it" —
  and is guarded by a confirmation since it's the one destructive option
  here.

A restore ends by reloading the page, since a restore (especially in
replace mode) can touch or wipe data that several already-mounted views
loaded independently on their own mount — reloading is the simple way to
guarantee nothing on screen is left showing stale pre-restore state.

## Deploying to Firebase Hosting

`.github/workflows/firebase-deploy.yml` builds the app (the normal
multi-file `npm run build`, not `build:onefile` — a real host serves
per-asset files with its own caching, so there's no reason to pay for
everything-inlined-as-one-file here) and deploys `dist/` to Firebase
Hosting on every push to `claude/essay-workflow-manager-y7gklc` (this
repo's current default branch — update that branch name in the workflow
if that ever changes), or on demand via the Actions tab's "Run workflow"
button. `firebase.json`/`.firebaserc` point it at the `notes-16464`
project.

It authenticates with a **plain Google Cloud service account key**, not
Firebase's own `firebase init hosting:github` flow — that flow works by
installing a Firebase-controlled GitHub App on the repo, which is exactly
the kind of standing third-party GitHub access this setup avoids. A
service account key is just a credential your own workflow holds (as a
GitHub secret, revocable any time from the Cloud Console, never granting
GitHub itself anything): set it up once, by hand, like this.

1. **Create the service account.** Open
   [console.cloud.google.com/iam-admin/serviceaccounts?project=notes-16464](https://console.cloud.google.com/iam-admin/serviceaccounts?project=notes-16464)
   and click **Create Service Account**. Any name works (e.g.
   `github-actions-deploy`); you can skip granting it a role in this
   wizard — the next step does that more precisely.
2. **Grant it deploy access.** Open
   [console.cloud.google.com/iam-admin/iam?project=notes-16464](https://console.cloud.google.com/iam-admin/iam?project=notes-16464),
   click **Grant Access**, enter the service account's email (it looks
   like `github-actions-deploy@notes-16464.iam.gserviceaccount.com`), and
   give it the **Firebase Hosting Admin** role
   (`roles/firebasehosting.admin`) — that's the minimum needed to deploy
   Hosting. If a deploy ever fails with a permissions error, add **Firebase
   Viewer** too; some project configurations want both.
3. **Create a key for it.** Back on the service accounts page, click into
   the one you made → **Keys** tab → **Add Key** → **Create new key** →
   **JSON**. This downloads a `.json` file — treat it like a password from
   here on (don't commit it, don't paste it anywhere but the GitHub secret
   below).
4. **Add it as a GitHub secret.** In this repo on GitHub: **Settings** →
   **Secrets and variables** → **Actions** → **New repository secret**.
   Name it exactly `FIREBASE_SERVICE_ACCOUNT`, and for the value, open the
   downloaded JSON file and paste its *entire contents* (the whole `{
   "type": "service_account", ... }` object) as-is.
5. **Delete the local copy** of the JSON key file once it's safely stored
   as the secret (or move it somewhere access-controlled if you want to
   keep a copy — either way, don't leave it sitting in a downloads
   folder).
6. Push to the branch above, or use **Run workflow** on
   `firebase-deploy.yml` in the Actions tab, to trigger a deploy. The
   workflow writes the secret to a temporary JSON file for
   `GOOGLE_APPLICATION_CREDENTIALS` (which is how `firebase-tools`
   authenticates as a service account in CI — no browser login, no stored
   OAuth token) and deletes that file again once the deploy step finishes.

If a deploy fails with something like "no currently active project" or a
missing-site error, Hosting itself may not be fully provisioned yet for
`notes-16464` — running `firebase init hosting` once from your own machine
(logged in as yourself, not the service account) against this project
will sort that out; the checked-in `firebase.json`/`.firebaserc` don't
need to change for it.

## What's stubbed / simplified in this prototype

- `src/lib/pdf.ts` points pdf.js's `cMapUrl`/`standardFontDataUrl` at a
  jsDelivr CDN build matching the pinned `pdfjs-dist` version, rather than
  bundling those (large, many-small-files) resources into the single HTML
  file. A PDF using an embedded CJK/Type0 font or a non-embedded standard
  font needs one of these to render correctly; left unset, pdf.js fetches
  them by filename from a path relative to the page, which — for a
  double-clicked local file — resolves against its own `file://` location
  and can be refused outright by the browser (each `file://` URL is a
  unique, opaque origin), not just render with a fallback glyph. This only
  matters for a PDF that actually needs one of those files; opening the
  file directly needs internet access for that specific case (the hosted
  preview's own sandbox blocks the request via CSP either way, which just
  means degraded fonts there, not a crash).
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
- Bundling the Firebase SDK for the optional sync feature adds real weight
  to the single-file build (roughly 900KB → 1.1MB gzipped) even for
  someone who never turns sync on — an acceptable tradeoff for "sync is
  built in and just needs your own Firebase project," but worth knowing if
  file size matters more than that convenience.
- The PDF viewer's drag-to-select-a-quote interaction (used by "Quote from
  PDF") is mouse-drag-shaped and hasn't been adapted for touch; quoting
  from a PDF on mobile is the one editor feature that's meaningfully more
  awkward there than on desktop.
