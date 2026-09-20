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
   * quoting. Empty if no PDF. Real HTML, not plain text — enrichable rather
   * than just a flat string — produced by one of the two extractors in
   * `lib/textExtraction.ts`: `'plain'` (the default; a `<p>` per paragraph,
   * a `<br>` per line break, nothing else) or the experimental `'layout'`
   * one (each run of text positioned, sized, and colored to match the
   * original page, with images reinserted where they were). Wherever this
   * needs to be searched, scanned for "does this look like a scanned PDF,"
   * or shown as a short plain-text snippet rather than actually rendered,
   * `htmlToPlainText` (`lib/textExtraction.ts`) reduces it back down first
   * — nothing else should assume this is plain text. A source saved before
   * `pageHtml` existed (when this field was `pageTexts: string[]`, genuine
   * plain text) gets migrated the moment it's loaded — see `sourcesRepo.ts`'s
   * own doc comment on `normalizeSource`.
   *
   * This is the shape every other part of the app sees and works with —
   * `sourcesRepo.ts` is the only place that ever touches how it's actually
   * stored, which is gzip-compressed (see that module's doc comment) rather
   * than this plain array; nothing outside that module should assume
   * anything about the on-disk shape from this field's type.
   */
  pageHtml: string[]
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
 * A quote saved out of a source's PDF independently of any essay — browsed
 * and searched on its own (the "Quotes" tab) and, from there, reused across
 * as many essays as you like via the quote-insertion dialog's "From the
 * quote bank" tab, rather than being tied to wherever it first got quoted.
 */
export interface QuoteBankEntry {
  id: string
  sourceId: string
  page: number
  quoteText: string
  /** Free-text note about why this quote was worth keeping. */
  annotation: string
  createdAt: number
  updatedAt: number
  /** Tombstone — see the note on Source.deleted. */
  deleted?: boolean
}

// ---- Essays / drafts -----------------------------------------------------

export interface Comment {
  id: string
  /** Plain-text snippet the comment is anchored to (best-effort, for display). */
  anchorText: string
  body: string
  resolved: boolean
  createdAt: number
}

export interface NodeVersion {
  id: string
  /** HTML content of this node's own text (not including children). */
  content: string
  comments: Comment[]
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
