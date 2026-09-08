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
  its own collapse state, its own version-history button). `src/components/Icon.tsx`
  is the one small hand-drawn (inline SVG, no icon font or CDN — see its
  own doc comment) icon set used for cite/quote/link/subsection/underline/
  lists in the editor toolbar and for comment/export/backup/sync wherever
  they appear, instead of emoji or a bare text label.
- `src/sync/` and `src/components/sync/` — the optional cross-device sync
  layer: `firebaseClient.ts` (Google sign-in plus the Firestore/Auth
  connections), `syncEngine.ts` (the actual push/pull pass), `account.ts`
  (the local, per-Google-account encryption key — never uploaded) and
  `accountMeta.ts` (the remote key-fingerprint check, and account reset),
  `firebaseConfig.ts` (what's stored locally to make sync possible at all),
  `autoSync.ts` (the polling loop), `qr.ts` (pairing-code generation), and
  `SyncSettingsDialog.tsx`/`QrScanner.tsx` for the UI. See "Syncing across
  devices" below for the full design and setup steps.
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
separately clickable line, indented to match its own node's depth — but
an *empty* one used to render as literally nothing: no border, no
placeholder, zero visual trace, so a stack of them (one per nesting
level, right where the visible text stops) looked like a single blank
page underneath the document rather than several distinct, individually
clickable lines. `.node-content:empty:last-child` now draws a permanent
(not hover-only) dashed box for exactly this case — a node's own trailing
shard, when it has nothing in it yet — so "there are 3 places to add text
here, one per level" is something you can actually see, not just
something that happens to be technically true if you know to look;
typing in one replaces it with ordinary text, same as always, and the
other levels' own boxes stay put below/above it. Suppressed in Comment
mode, which hides every other editing affordance the same way.

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

**What's encrypted, what isn't.** A node's `draftContent` and its full
`versions` array (so: the actual prose, and every comment attached to any
version) are AES-256-GCM encrypted client-side before being written to
Firestore, as one `_enc: {iv, data}` field; PDF bytes are encrypted the
same way before being chunked into Firestore documents (see "PDFs through
Firestore" below), with the IV kept on the manifest document. Left as
plaintext metadata: essay/section titles, timestamps, a source's BibTeX
fields and free-text note, and which node has which parent (implicit in
`draftContent`'s markers, which — being inside a node's own content — are
covered by the same encryption as the prose). This split is deliberate, not
just laziness: it's what lets a device list your essays/sources and know
what's changed without decrypting everything, and keeps sync payloads
small. It also means a source's comment field and a essay's title are
readable by anyone who can read your Firestore data, encryption or not —
worth knowing if either would contain something sensitive.

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
reset, and overlapping concurrent `runSyncPass` calls sharing one pass
instead of double-running (see `syncEngine.ts`'s own `inFlightPass`), are
covered by an automated test suite (`npm test`, `src/sync/__tests__/`)
that runs the real sync code against in-memory fakes of Firestore, Auth,
and each device's own local storage (`src/test/`) — no network or
emulator process needed, so it runs in a couple of seconds and stays easy
to extend with more scenarios as they come up.

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
*everything* on the device (every essay, section, version, comment,
source, and PDF) as one `.zip` — a `data.json` manifest plus a `blobs/`
folder — for safekeeping or moving to a new browser/device by hand.

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
