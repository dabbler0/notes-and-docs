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
  /** Current, live child ordering — NOT versioned (see design notes below). */
  childIds: string[]
  versions: NodeVersion[]
  headVersionId: string
  /** Live working copy of content, edited freely without creating a version. */
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
 * `childIds` is deliberately *not* part of that history — it is always the
 * live, current tree structure. That is what gives the two behaviors asked
 * for: (a) reverting one node's text never disturbs sibling/parent subtrees,
 * because structure isn't versioned at all, and (b) making a new version of
 * a node's text carries no memory of "which subsections existed back then" —
 * subsections are just whatever is currently attached, independent of which
 * historical version of the parent's own prose you're looking at.
 */
