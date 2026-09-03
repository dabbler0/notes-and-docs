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
  /** Per-page extracted text, for search and quoting. Empty if no PDF. */
  pageTexts: string[]
  createdAt: number
  updatedAt: number
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
  createdAt: number
  updatedAt: number
}

export interface Essay {
  id: string
  title: string
  rootNodeId: string
  createdAt: number
  updatedAt: number
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
