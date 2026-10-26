/**
 * Trimmed stand-ins for the real app's `models/types.ts` — just the shape
 * `bibtex.ts`/`export.ts` actually read (`id`, `bibtex.fields`). The real
 * migration imports the genuine `Source`/`BibtexEntry` types directly
 * instead of this file once this code moves into the real app.
 */
export interface BibtexEntry {
  type: string
  key: string
  fields: Record<string, string>
}

export interface Source {
  id: string
  bibtex: BibtexEntry
  noPageNumbers?: boolean
  pageOffset?: number
}

/**
 * Old-model shapes, read-only inputs to `migrate.ts` — a trimmed mirror of
 * the real app's own `models/types.ts`, just enough of each field for the
 * migration to read. `NodeVersion`/`EssayNode.versions`/`.headVersionId`
 * aren't included at all: that data is already deprecated in the real app
 * (superseded by `EssayCommitEntry`, a separate commit-history collection
 * the migration doesn't touch — a fresh commit history starts from the
 * migrated document instead, same as any other newly created essay) and
 * carries no content a live `EssayNode.draftContent`/`comments`/
 * `footnotes` wouldn't already include.
 */
export interface LegacyComment {
  id: string
  parentId: string | null
  anchorKind: 'node' | 'text' | 'inline'
  anchorText: string
  body: string
  displayMode?: 'margin' | 'inline'
  resolved: boolean
  createdAt: number
  updatedAt: number
}

export interface LegacyFootnote {
  id: string
  content: string
}

export interface LegacyEssayNode {
  id: string
  essayId: string
  title: string
  draftContent: string
  footnotes?: LegacyFootnote[]
  comments?: LegacyComment[]
  deleted?: boolean
}

export interface LegacyEssay {
  id: string
  title: string
  rootNodeId: string
  deleted?: boolean
}

/**
 * A snipped-out chunk of a node's own content, kept for recovery
 * (`sendSelectionToGraveyard` in the real app's `EssayWorkspace.tsx`) —
 * `html` is a plain cloned-selection fragment, the same shape as one of a
 * node's own text segments (see `migrate.ts`'s own `migrateGraveyardFragment`,
 * which reuses `htmlToBlocks` for exactly that reason), never a whole
 * node or subtree. Never has its own footnotes/comments of its own — a
 * footnote reference caught inside the cut selection still resolves
 * against `nodeId`'s own `footnotes` array, same as live.
 */
export interface LegacyGraveyardFragment {
  id: string
  essayId: string
  nodeId: string
  nodeTitle: string
  html: string
  deleted?: boolean
}

/**
 * The migrated app's own `Comment` shape — mostly unchanged from the real
 * app's (see its own doc comment in `models/types.ts`), with one new field
 * forced by the "maximal" single-document model: comments are no longer
 * split across per-`EssayNode` arrays (there's only one PM document per
 * essay now — see `schema.ts`'s own doc comment), so `migrate.ts` produces
 * one flat array per *essay* instead. That flattening loses something the
 * old per-node array gave for free, though: which section a top-level
 * `'node'`-anchored comment (no mark anywhere — see `anchorKind`'s own doc
 * comment in the real app) belongs to was previously *implicit*, simply
 * whichever node's own `comments` array it sat in. `sectionId` makes that
 * explicit instead — the owning `section` node's own stable `attrs.id`
 * (every `EssayNode.id` becomes exactly that id — see `migrate.ts`'s own
 * doc comment) — set on every top-level comment (`'node'` and `'text'`
 * alike, so lookups don't need to special-case which kind they're
 * dealing with) and left `null` on a nested reply/comment-on-a-comment,
 * which already has an unambiguous owner: its own `parentId`.
 */
export interface Comment {
  id: string
  parentId: string | null
  /** The owning `section` node's own `attrs.id` for a top-level comment (`parentId === null`); `null` for a nested one, whose `parentId` already identifies its owner unambiguously. See this type's own doc comment for why this exists at all. */
  sectionId: string | null
  anchorKind: 'node' | 'text' | 'inline'
  anchorText: string
  body: string
  displayMode?: 'margin' | 'inline'
  resolved: boolean
  createdAt: number
  updatedAt: number
}
