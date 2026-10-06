// ---- Sources -----------------------------------------------------------

export interface BibtexEntry {
  type: string // e.g. "article", "book", "inproceedings"
  key: string // citation key, e.g. "smith2020learning"
  fields: Record<string, string> // title, author, year, journal, ...
}

export interface Source {
  id: string
  bibtex: BibtexEntry
  /** Free-text note, mainly useful for sources with no PDF attached. */
  comment: string
  /** Blob id in the BlobStore, if a PDF is attached. */
  pdfBlobId?: string
  pdfFileName?: string
  /**
   * Per-page extracted content, for reading (`TextViewer`), search, and
   * quoting. Real HTML, not plain text — enrichable rather than just a
   * flat string — produced by layout extraction (`extractLayoutPageHtml`
   * in `lib/textExtraction.ts`): each run of text positioned, sized, and
   * colored to match the original page, with images reinserted where they
   * were (unless extracted with images skipped — see
   * `LayoutExtractionOptions`). A source extracted before layout
   * extraction became the only extractor may instead hold plain, unstyled
   * HTML (a `<p>` per paragraph, a `<br>` per line break, nothing else)
   * from the extractor that used to exist alongside it. Wherever this
   * needs to be searched, scanned for "does this look like a scanned PDF,"
   * or shown as a short plain-text snippet rather than actually rendered,
   * `htmlToPlainText` (`lib/textExtraction.ts`) reduces it back down first
   * — nothing else should assume this is plain text.
   *
   * **Often empty (`[]`) even for a source that genuinely has pages** —
   * `sourcesRepo.ts` stores this field in its own `sourceContent` record,
   * separate from the rest of the source, specifically so listing sources
   * (`listSources`) never has to load it at all; only `getSource` (one
   * specific source, fetched to actually view/search/quote it) populates
   * it for real. `pageCount` below is always accurate regardless of
   * whether this is loaded — check that, never `pageHtml.length`, for
   * "does this source have extracted text" or "how many pages." When this
   * *is* loaded, `pageHtml.length === pageCount` always holds.
   */
  pageHtml: string[]
  /** Always accurate, whether or not `pageHtml` above is actually loaded —
   * see its own doc comment. Set by whatever last wrote this source's
   * content (`sourcesRepo.ts`'s `updateSourceContent`/`createSource`), 0
   * for a BibTeX-only source with nothing extracted. */
  pageCount: number
  /** This source's extracted-text content as it actually sits on disk,
   * compressed (see `sourcesRepo.ts`'s own doc comment on
   * `StoredSourceContent`) — always accurate without needing `pageHtml`
   * loaded, the same way `pageCount` is. 0 when `pageCount` is 0. Used for
   * the "how much space is this using" display (`getSourceStorageBytes`),
   * which would otherwise need to recompress a source's full text just to
   * report its own size every time a source list renders. */
  contentBytes: number
  /**
   * True once the original PDF has been discarded and only its extracted
   * `pageHtml` is kept (see `convertSourceToTextOnly` in
   * `sourcesRepo.ts`) — a way to reclaim a large PDF's storage while still
   * keeping the ability to browse and quote it via `TextViewer`. Absent
   * (falsy) for both "has a real PDF" and "BibTeX + comment only" sources;
   * only `pdfBlobId`'s presence/absence actually distinguishes those two,
   * exactly as before this field existed.
   */
  textOnly?: boolean
  /**
   * True when this source doesn't have meaningful page numbers of its own
   * (a web page, a source with no fixed pagination) — citations from it
   * never show a page number, however a quote's own `page` happens to be
   * set (that field still tracks the raw PDF/text-viewer page internally,
   * e.g. for "View in source" to jump back to — this only suppresses it
   * from the *displayed* citation).
   */
  noPageNumbers?: boolean
  /**
   * How many pages into the stored PDF the document's own printed page 1
   * actually starts — e.g. 3 for a PDF with a cover, title page, and blank
   * page before the numbered content begins. Can be negative instead, for
   * a work (a journal article, typically) whose PDF starts already
   * numbered higher than 1 — e.g. -152 for one starting on the work's own
   * printed page 153. `citationPage` (`lib/bibtex.ts`) subtracts this from
   * whatever raw page a quote was taken from, so a citation reads with the
   * document's own page numbers rather than the PDF viewer's. Irrelevant
   * (and ignored) when `noPageNumbers` is set.
   */
  pageOffset?: number
  /**
   * This device's own last-viewed page in this source's PDF/text viewer
   * (1-based) — what re-opening the source resumes to, and what
   * `lastViewedAt` (below) is updated alongside. Written straight through
   * `sourcesRepo.ts`'s `touchSourceViewed`, deliberately *not* via
   * `updateSource` — see that function's own doc comment for why merely
   * looking at a page is kept out of `updatedAt`/sync entirely (a purely
   * local reading-position convenience, not real content).
   */
  lastViewedPage?: number
  /**
   * When this device last opened this source's PDF/text viewer — used only
   * to order source lists by recency of use (`listSources`), never synced
   * and never counted as a real edit. See `lastViewedPage`'s own doc
   * comment for why.
   */
  lastViewedAt?: number
  createdAt: number
  updatedAt: number
  /**
   * Tombstone rather than a hard local delete, so a deletion is itself a
   * change with a newer `updatedAt` that sync can propagate to other
   * devices — every list/read in sourcesRepo filters these out, so nothing
   * elsewhere in the app needs to know this field exists.
   */
  deleted?: boolean
}

/**
 * `'quote'` — kept as a preparation for insertion into an essay, for
 * others to eventually read: browsed and searched on its own (the global
 * "Quotes" tab) and, from there, reused across as many essays as you like
 * via the quote-insertion dialog's "From the quote bank" tab, rather than
 * being tied to wherever it first got quoted.
 *
 * `'annotation'` — a margin annotation: a note to yourself while reading,
 * never meant for the quote bank or essay insertion. Shown only from the
 * source it came from (`SourceWorkspace`'s own "Margin annotations"
 * panel), and deliberately excluded from `listQuoteBank`/the global Quotes
 * tab/the quote-insertion dialog — see those call sites' own doc comments.
 *
 * Absent on an entry saved before this distinction existed; every read
 * path treats a missing `kind` as `'quote'` (see `quoteBankRepo.ts`'s own
 * doc comments) — the formal migration (`quoteBankMigrations.ts`) backfills
 * it explicitly too, but the defensive default means nothing actually
 * depends on that migration having already run (an old backup restored
 * later, or a remote account mid-migration, still behaves correctly).
 */
export type QuoteBankEntryKind = 'quote' | 'annotation'

/**
 * A highlighted excerpt saved out of a source, independent of any essay —
 * either a `'quote'` (see `QuoteBankEntryKind`'s own doc comment) or an
 * `'annotation'`. Both are otherwise the same shape and get the same
 * interaction model in `SourceWorkspace`/`ReaderMode` (select text in the
 * source, see it highlighted, optionally attach a free-text note, browse a
 * list, jump back to the page) — only `kind` and which lists/dialogs each
 * one is allowed to show up in differ.
 */
export interface QuoteBankEntry {
  id: string
  sourceId: string
  page: number
  quoteText: string
  /** Free-text note — why this quote was worth keeping, or what this
   * margin annotation is actually about. */
  annotation: string
  /** See `QuoteBankEntryKind`'s own doc comment. Optional only because an
   * entry saved before this field existed may not have it yet on disk —
   * every read path defaults a missing value to `'quote'`, so nothing
   * outside `quoteBankRepo.ts`/the migration should ever need to do that
   * itself. */
  kind?: QuoteBankEntryKind
  createdAt: number
  updatedAt: number
  /** Tombstone — see the note on Source.deleted. */
  deleted?: boolean
}

/**
 * A marked page in a source, for jumping back later — the "dog-ear a page"
 * counterpart to a quote bank entry's "keep this exact passage." Shown both
 * from a source's own detail view and from `ReaderMode.tsx`, since both are
 * just different ways of browsing the same `pageHtml`/PDF pages. Unlike a
 * `QuoteBankEntry`, there's no text captured at all — just the page and an
 * optional label — since the point is purely navigational, not a citation.
 */
export interface Bookmark {
  id: string
  sourceId: string
  page: number
  /** Optional free-text label ("start of chapter 3") — falls back to "Page N" wherever this is displayed if left blank. */
  label: string
  createdAt: number
  updatedAt: number
  /** Tombstone — see the note on Source.deleted. */
  deleted?: boolean
}

// ---- Essays / drafts -----------------------------------------------------

/**
 * A comment (or a reply to one, or a comment made on a highlighted span
 * within one) lives flat on the `EssayNode` it belongs to (see
 * `EssayNode.comments`), not on any one version — unlike a node's own text,
 * a comment thread isn't something a version boundary should ever silently
 * cut off or orphan. `parentId`/`anchorKind` together are what unify what
 * used to be four different-looking features (a comment on selected text, a
 * comment on a whole section, a comment on a comment, and a plain threaded
 * reply) into one shape:
 *
 * - `'text'` — anchored to a `<mark class="comment-anchor" data-comment-id>`
 *   span sitting in the node's own `draftContent`. Always top-level
 *   (`parentId` null); a comment can't itself be nested *and* anchored to
 *   the main document text; see `'inline'` for nesting with an anchor. The
 *   mark can be empty (a comment created with nothing selected, anchored to
 *   the empty span right at the cursor) — that's what an inline comment's
 *   own anchor point normally looks like; see `displayMode`.
 * - `'node'` — attached to the section as a whole, no mark anywhere. Also
 *   always top-level. Legacy: no longer created by any UI action (a
 *   `'text'` comment with an empty mark, at whatever `displayMode`, covers
 *   the same "nothing highlighted" case now) but still rendered for a node
 *   that already has one.
 * - `'inline'` — nested under `parentId`, anchored to a
 *   `<mark class="comment-anchor" data-comment-id>` span sitting inside
 *   `parentId`'s own `body` HTML, exactly the same marking scheme as
 *   `'text'` just applied to a comment's body instead of a section's. A
 *   genuine "comment on a comment" has real anchor text in that mark; a
 *   plain reply is the same thing with an *empty* mark appended at the very
 *   end of the parent's body — one mechanism covers both, so there's no
 *   separate "reply" shape to keep in sync with it.
 *
 * `displayMode` only applies to a top-level, `'text'`-anchored comment (a
 * nested comment always renders as part of its parent's own thread, and a
 * `'node'` comment has no anchor point to render inline *at*):
 * - `'margin'` (the default, and the only mode before this existed) — a
 *   positioned card off to the side, as before.
 * - `'inline'` — the comment's own body renders directly in the document's
 *   own text flow, right after its anchor mark, in place — a real mounted
 *   segment (see `childMarkers.ts`'s `'inline-comment'` segment kind), not
 *   markup spliced into `draftContent` itself, so it stays editable and
 *   convertible back to a margin comment (or promotable to ordinary prose —
 *   see `promoteInlineComment`) without losing anything.
 *
 * Deliberately never auto-pruned the way a `Footnote` is (see
 * `pruneOrphanedFootnotes` in `essaysRepo.ts`): editing away the text a
 * comment (or a reply thread under it) is anchored to doesn't silently
 * destroy the discussion — only an explicit, recursively-cascading delete
 * does (see `deleteCommentCascade`).
 */
export interface Comment {
  id: string
  /** Id of the comment this one is nested under, or null for a top-level comment. */
  parentId: string | null
  anchorKind: 'node' | 'text' | 'inline'
  /** Plain-text snippet the comment is anchored to (best-effort, for display) — empty for a 'node' comment, a comment with nothing selected, or a plain reply (an 'inline' comment anchored to an empty mark). */
  anchorText: string
  /** Rich-text HTML, edited the same uncontrolled-contentEditable way as a footnote's own body. */
  body: string
  /** Only meaningful for a top-level `'text'` comment — see this type's own doc comment. Absent (both here and in stored data predating this field) means `'margin'`. */
  displayMode?: 'margin' | 'inline'
  resolved: boolean
  createdAt: number
  updatedAt: number
}

export interface NodeVersion {
  id: string
  /** HTML content of this node's own text (not including children). */
  content: string
  createdAt: number
  label?: string
}

/**
 * A footnote body, referenced from within a node's own content by a
 * `<sup class="footnote-ref" data-footnote-id>` marker sitting wherever the
 * footnote was inserted — the same "marker in the text, real content kept
 * elsewhere" shape `childMarkers.ts` uses for subsections, chosen for the
 * same reason: the footnote's own body is ordinary editable HTML, not a
 * plain string, and shouldn't have to live inline in the middle of running
 * text to be edited. Numbering is deliberately not stored here — it's
 * however many footnote-ref markers precede this one in the node's own
 * content, computed at render/export time (via a CSS counter in the editor,
 * a running counter in export.ts) — so reordering, inserting, or deleting a
 * footnote never leaves a stale number sitting on some other one.
 */
export interface Footnote {
  id: string
  content: string
}

export interface EssayNode {
  id: string
  essayId: string
  title: string
  versions: NodeVersion[]
  headVersionId: string
  /**
   * Live working copy of content, edited freely without creating a version.
   * This is HTML that may embed subsection markers (see
   * src/lib/childMarkers.ts) — a subsection is a literal child element
   * sitting wherever the text it was split out of used to be, exactly like
   * an element embedded in an HTML document. There is no separate
   * child-list field: "what are this node's children, in what order" is
   * simply "whatever markers this content currently contains."
   */
  draftContent: string
  /**
   * This node's own footnotes, referenced from `draftContent` (see
   * `Footnote`'s own doc comment). Absent on any node saved before
   * footnotes existed — always read through `essaysRepo.nodeFootnotes()`
   * rather than directly, so that older data doesn't need an explicit
   * migration pass: "no footnotes field" and "an empty footnotes array"
   * are treated identically everywhere this is read.
   */
  footnotes?: Footnote[]
  /**
   * This node's own comment threads — every comment anchored to its text,
   * to itself as a whole section, and every reply/comment-on-a-comment
   * nested under any of those (see `Comment`'s own doc comment). Absent on
   * any node saved before this flat, node-level model replaced the old
   * per-version one; always read through `essaysRepo.nodeComments()`,
   * which also lazily migrates a node still carrying the old
   * `NodeVersion.comments` shape the first time it's loaded.
   */
  comments?: Comment[]
  createdAt: number
  updatedAt: number
  /** Tombstone — see the note on Source.deleted. */
  deleted?: boolean
}

export interface Essay {
  id: string
  title: string
  rootNodeId: string
  createdAt: number
  updatedAt: number
  /** Set once an essay is considered finished — hides it from the main Drafts view (behind a "Show archived" toggle) without deleting anything; see `archiveEssay`/`unarchiveEssay` in `essaysRepo.ts`. Absent (falsy) means active, same as for any essay saved before this existed. */
  archived?: boolean
  /** Tombstone — see the note on Source.deleted. */
  deleted?: boolean
}

/**
 * Text cut from an essay via "Send to graveyard" rather than deleted
 * outright — kept around, attached to the essay it came from, so it can be
 * browsed and copied back in later instead of only living in undo history.
 * `nodeId`/`nodeTitle` are a best-effort *reference* to where it came from,
 * captured at the moment of removal — never dereferenced to decide whether
 * to show a fragment, since the whole point is that it should keep showing
 * up even once that node is gone (deleted, split away, merged elsewhere).
 */
export interface GraveyardFragment {
  id: string
  essayId: string
  nodeId: string
  nodeTitle: string
  /** The removed content's own HTML, exactly as it looked in the document. */
  html: string
  createdAt: number
  updatedAt: number
  /** Tombstone — see the note on Source.deleted. */
  deleted?: boolean
}

/**
 * Design note on versioning (see project brief): each node's own text has an
 * independent, explicit version history (draftContent -> "make a new
 * version" -> snapshot pushed to `versions`, becomes `headVersionId`).
 * Structure (which markers a node's content embeds) is deliberately *not*
 * part of that history — a version is just a frozen HTML snapshot, and
 * reverting one node's text can't disturb any other node, since nothing
 * about any other node is stored on it.
 */
