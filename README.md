# Marginal — an essay & source workbench (prototype)

A local-first workflow manager for writing essays/papers: a searchable
library of cited sources (PDFs with BibTeX + extracted text, or bare
citations) and a draft editor — presented as one continuous, collapsible
document rather than a file tree — with an explicit per-section version
history, inline commenting, and inline citation/quote insertion.

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
  below), `treeNumbering.ts` ("Section 2.3.1"-style placeholder titles for
  newly split-off sections), and `export.ts` (Markdown/LaTeX conversion for
  the export dialog — see below; the LaTeX path is zipped up with the
  `jszip` package, the one runtime dependency added purely for export).
- `src/components/sources/` and `src/components/essays/` — the UI.
  `EssayWorkspace.tsx` is the whole document: a sticky toolbar acting on
  "whichever section currently has the cursor," plus a recursive
  `SectionBlock.tsx` per section (its own small `contentEditable` shards,
  its own collapse state, its own version-history button).
- `src/sync/` and `src/components/sync/` — the optional cross-device sync
  layer: `syncEngine.ts` (the actual push/pull pass), `account.ts` and
  `firebaseConfig.ts` (what's stored locally to make sync possible at all),
  `autoSync.ts` (the polling loop), `qr.ts` (pairing-code generation), and
  `SyncSettingsDialog.tsx`/`QrScanner.tsx` for the UI. See "Syncing across
  devices" below for the full design and setup steps.
- `src/lib/useIsMobile.ts` plus the mobile branches inside `Modal.tsx` and
  `EssayWorkspace.tsx` — see "Mobile layout" below.

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
with a resolved checkbox. Selecting text in comment mode always works
immediately, even in a section with unsaved changes: rather than blocking
with "save first," it silently makes a new version out of whatever's
currently there — unlike the version pill's own freeze action, this one
does *not* clear the section afterward, since the point is to keep writing
and comment on live text, not to open a compare view — and anchors the
comment to that version, same as if it had already been committed.
Commenting itself happens in a small popover anchored right under the
selection (`.comment-widget` in `EssayWorkspace.tsx`) rather than a modal,
so the document stays visible and in place behind it; clicking anywhere
outside the widget or pressing Escape dismisses it without commenting.

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
  footnotes.
- **PDF** — the exact same Markdown, rendered back to a printable HTML
  page in a new tab, which then opens the browser's own print dialog;
  "Save as PDF" there is the actual PDF-generation step, so this needs no
  PDF-writing library of its own.
- **LaTeX project** — a `main.tex` using `\section`/`\subsection`/
  `\subsubsection` and, past that depth, `\paragraph`/`\subparagraph`, with
  citations rendered as `\cite` or `\footcite` (a dialog toggle — the
  latter switches the preamble to `biblatex`/`\printbibliography` instead
  of `natbib`/`\bibliography`) plus a `references.bib` built from exactly
  the sources actually cited in the essay, zipped together with JSZip.

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

## Mobile layout

Below a 720px viewport width, three things change; nothing else does —
splitting, versioning, comments, citations, and export all work exactly
the same way on mobile as on desktop.

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
replacement for local storage), PDFs and essay drafts are encrypted before
they ever leave the device, and there's no password or server-side
signup — an account *is* an encryption key plus a random id, and moving
that pair to a new device is what "logging in" means.

**Setting up your own Firebase project.** This is a single static HTML
file with no server of its own, so it can't ship a working sync backend
out of the box — each install points at *your own* Firebase project:

1. Create a Firebase project (free tier is enough) and enable
   **Firestore** and **Storage**, and enable **Anonymous** sign-in under
   Authentication (this is only so Firestore/Storage rules have a
   `request.auth` to check — see the security note below, it has nothing
   to do with the app's own account system).
2. Set these Firestore rules (`accounts/{userId}` is the app's own account
   id, not Firebase's):
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /accounts/{userId}/{collection}/{docId} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
   and this for Storage:
   ```
   rules_version = '2';
   service firebase.storage {
     match /b/{bucket}/o {
       match /accounts/{userId}/blobs/{blobId} {
         allow read, write: if request.auth != null;
       }
     }
   }
   ```
3. In Project settings → "Your apps," add a web app and copy its config
   object. Paste that into the app's Sync settings (🔄 Sync in the topbar)
   — it's stored in this browser's `localStorage`, not baked into the
   build, since there is no build-time secret to bake in (a Firebase web
   config is meant to be public; see below for what actually guards the
   data).

**Creating and transferring an account.** Sync settings offers "Create
account" (generates a fresh AES-256 key and a random id, right there in
the browser) or "Use an existing account," which accepts the same bundle
three ways: scanning another device's QR code, uploading its downloaded
key file, or pasting the key JSON directly. The QR/file/paste payload is
just `{ userId, key, v }` — literally the whole account. Camera-based QR
scanning needs a secure context (`https://`, or `localhost`) to get camera
access at all; a copy of this app opened straight from disk over `file://`
can't get there, so it falls back to a plain message and the key-file/paste
paths, which work everywhere.

**What's encrypted, what isn't.** A node's `draftContent` and its full
`versions` array (so: the actual prose, and every comment attached to any
version) are AES-256-GCM encrypted client-side before being written to
Firestore, as one `_enc: {iv, data}` field; PDF bytes are encrypted the
same way before upload to Storage, with the IV kept in the object's own
`customMetadata` (Storage has no per-field encryption of its own). Left as
plaintext metadata: essay/section titles, timestamps, a source's BibTeX
fields and free-text note, and which node has which parent (implicit in
`draftContent`'s markers, which — being inside a node's own content — are
covered by the same encryption as the prose). This split is deliberate, not
just laziness: it's what lets a device list your essays/sources and know
what's changed without decrypting everything, and keeps sync payloads
small. It also means a source's comment field and a essay's title are
readable by anyone who can read your Firestore data, encryption or not —
worth knowing if either would contain something sensitive.

**How sync actually decides what to send.** Every local record already
carries an `updatedAt`; each pass pushes anything newer than the last push,
and pulls anything remote newer than the last pull, applying a remote
change locally only if it's newer than what's already there
(last-write-wins, no merge). A PDF is pushed once, the first time a pass
notices it hasn't been uploaded yet (blob ids are never reused for a
different file, so there's no need to compare timestamps there). Deletion
is a tombstone (`deleted: true` plus a fresh `updatedAt` on the essay,
source, or node record — see the `deleted` field's own doc comment in
`models/types.ts`), not a hard delete, specifically so a deletion is itself
a synchronizable *change*; every list/read in `essaysRepo`/`sourcesRepo`
filters tombstoned records out, so nothing else in the app needs to know
this exists. Sync runs automatically every 30 seconds while the app is
open (toggle in Sync settings) and on demand via "Sync now."

**The security model, stated plainly.** There's no real per-account access
control here — the Firestore/Storage rules above allow *any* anonymously
authenticated client to read or write *any* account's path, if it knows
the id. What actually protects your data is that the id is an
unguessable random UUID (rules out casual discovery) and that anything
worth reading is encrypted with a key that never reaches Firebase at all
(rules out a compromised or curious server operator, and rules out someone
who does guess or leak an id from reading anything but ciphertext). A real
product would instead mint a Firebase custom auth token server-side, bound
to the account id, and write rules like `request.auth.uid == userId` — but
that needs a backend able to hold a service-account secret, which a
single static HTML file fundamentally can't do without reintroducing a
server. This tradeoff is the whole reason the account system stays
"rudimentary": it's exactly as much account system as a purely
client-side app can honestly implement.

**Known gaps.** No realtime listeners — a change on another device shows
up on the next 30-second tick or manual sync, not immediately. No
conflict UI — a genuine simultaneous edit on two devices just keeps
whichever timestamp is later, silently. Deleting a source removes its
Storage object's *local* reference immediately but doesn't delete the
remote copy (a minor, unreclaimed storage cost, not a correctness issue).
And — since this sandbox's network policy blocks reaching Firebase's own
domains at all — the actual push/pull pass against a live project could
not be exercised end-to-end while building this; what's verified directly
is the encryption round-trip (AES-GCM encrypt/decrypt, including that the
wrong key correctly fails to decrypt), every account-management UI flow
(create, export via QR/key-file, import via paste/file, forget), tombstone
deletion (a deleted record is confirmed to persist locally as
`{deleted: true}` rather than vanishing), and that a sync attempt against
an unreachable project fails safely into a visible error rather than
hanging the UI or throwing past the try/catch. The push/pull logic itself
is implemented directly against the documented Firestore/Storage SDK
semantics, but hasn't been watched moving real data between two real
devices.

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
