import { backend } from '../storage'
import { id } from '../lib/id'
import { getChildIds, insertMarkerInContent, removeMarkerFromContent, type MarkerPlacement } from '../lib/childMarkers'
import { citationHtml, citationLabelOpen, extractLegacyCitationNote } from '../lib/bibtex'
import { listSources } from './sourcesRepo'
import type { Comment, Essay, EssayNode, Footnote, Source } from './types'

const ESSAYS = 'essays'
const NODES = 'nodes'

export async function listEssays(): Promise<Essay[]> {
  const essays = await backend.docs.list<Essay>(ESSAYS)
  return essays.filter((e) => !e.deleted).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getEssay(essayId: string): Promise<Essay | undefined> {
  return backend.docs.get<Essay>(ESSAYS, essayId)
}

export async function getNode(nodeId: string): Promise<EssayNode | undefined> {
  const node = await backend.docs.get<EssayNode>(NODES, nodeId)
  if (node) {
    migrateComments(node)
    await syncCitations(node)
  }
  return node
}

/**
 * Keeps every `.citation` chip's own displayed label in step with its
 * `data-source-id`'s *current* bibtex entry — `data-source-id` has always
 * been the real reference; the label text sitting next to it (inside
 * `.citation-base`) was only ever a cached rendering of it, taken at
 * whatever moment the chip was inserted or last upgraded. Without this,
 * fixing a typo or a wrong year on a source would leave every citation
 * that already points to it quietly citing the old, wrong text forever —
 * `data-source-id` alone would be true, but nothing downstream reads it
 * instead of the label, so a reader never sees the correction. Lazy, run
 * every time a node is loaded (same as `migrateComments` above), mutating
 * in place rather than writing back immediately — the next real edit's
 * own autosave persists it for real.
 *
 * Two different chip shapes land here, handled differently:
 *
 * - **Legacy** (no `data-cite-v` — from before `citationHtml` started
 *   tagging its own output and splitting a source reference plus a
 *   separate freeform note out as structured data at all): the one piece
 *   of real information its old, hand-editable label text ever carried on
 *   top of `data-source-id` is wherever it mentioned a page, recovered via
 *   `extractLegacyCitationNote`. A rebuilt chip is only possible when
 *   there's still a source to rebuild it from (a missing `data-source-id`,
 *   or a source that's since been deleted, falls back to flattening to
 *   plain text instead — the same degraded fallback this used before
 *   `data-source-id` was recognized as already being real structured
 *   data).
 * - **Already structured** (`data-cite-v` present): its own `data-note` is
 *   real, freeform, user-entered data — never touched. Only the
 *   `.citation-base` label itself (always a pure function of the source's
 *   bibtex, never hand-edited — see `citationHtml`'s own doc comment on
 *   why that span is `contenteditable="false"`) gets re-derived, and only
 *   rebuilt at all when it's actually gone stale (a plain string
 *   comparison first, so a node with nothing to fix is never needlessly
 *   rewritten). A chip whose source has since been deleted is left exactly
 *   as it is — nothing to refresh it *from*, and unlike the legacy case
 *   there's no need to degrade it: its label was already valid structured
 *   HTML, just possibly stale.
 *
 * Runs against `draftContent` and every historical `version.content`
 * alike, so an old pinned version doesn't go on citing a source through
 * either unstructured markup or a stale label nothing downstream expects.
 */
async function syncCitations(node: EssayNode): Promise<void> {
  const htmls = [node.draftContent, ...node.versions.map((v) => v.content)]
  if (!htmls.some((html) => html.includes('citation'))) return
  // Sources are fetched at most once per `getNode` call, lazily, and only
  // when there's actually a citation to resolve against them —
  // `listSources()` itself is already the cheap, metadata-only path (no
  // extracted-PDF-text decompression), unlike calling `getSource` once per
  // citation would be.
  let sourcesById: Map<string, Source> | null = null
  async function sourceFor(sourceId: string): Promise<Source | undefined> {
    if (!sourcesById) sourcesById = new Map((await listSources()).map((s) => [s.id, s]))
    return sourcesById.get(sourceId)
  }
  node.draftContent = await syncCitationsInHtml(node.draftContent, sourceFor)
  for (const version of node.versions) version.content = await syncCitationsInHtml(version.content, sourceFor)
}

async function syncCitationsInHtml(html: string, sourceFor: (sourceId: string) => Promise<Source | undefined>): Promise<string> {
  // Cheap fast path: the overwhelming majority of nodes never had a
  // citation in them at all, and this skips ever constructing a
  // DOMParser document for any of them.
  if (!html.includes('citation')) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const els = Array.from(doc.querySelectorAll('.citation'))
  if (els.length === 0) return html
  // Only actually re-serializes (and so only ever persists, on the next
  // real save) when something below genuinely changed — the common case,
  // a node whose citations are all already accurate, leaves `html`
  // completely untouched rather than returning an incidentally
  // re-formatted copy of the exact same markup.
  let changed = false
  for (const el of els) {
    const sourceId = el.getAttribute('data-source-id')
    const source = sourceId ? await sourceFor(sourceId) : undefined
    if (!el.hasAttribute('data-cite-v')) {
      changed = true
      if (source) {
        const note = extractLegacyCitationNote(el.textContent ?? '', source.bibtex.fields.year)
        replaceWithFreshCitation(doc, el, source, note)
      } else {
        el.replaceWith(doc.createTextNode(el.textContent ?? ''))
      }
      continue
    }
    if (!source) continue // nothing to refresh the label from — leave exactly as is
    const base = el.querySelector(':scope > .citation-base')
    if (base?.textContent === citationLabelOpen(source.bibtex)) continue // already accurate
    replaceWithFreshCitation(doc, el, source, el.getAttribute('data-note') ?? undefined)
    changed = true
  }
  return changed ? doc.body.innerHTML : html
}

/** Rebuilds `el` in place as a fresh `citationHtml(source, { note })` chip — the exact same shape a brand-new "Cite" produces, so its label is always a pure function of the source's current bibtex. */
function replaceWithFreshCitation(doc: Document, el: Element, source: Source, note: string | undefined): void {
  const scratch = doc.createElement('div')
  scratch.innerHTML = citationHtml(source, { note })
  const replacement = scratch.firstElementChild
  if (replacement) el.replaceWith(replacement)
  else el.replaceWith(doc.createTextNode(el.textContent ?? ''))
}

/** A comment as it could look in already-stored data predating either migration below — a wider, looser shape than the current `Comment` type allows (in particular, `anchorKind` could be `'reply'`, a kind that no longer exists at all — see the loop below). */
interface LegacyComment {
  id: string
  parentId?: string | null
  anchorKind?: string
  anchorText: string
  body: string
  resolved: boolean
  createdAt: number
  updatedAt?: number
}

/**
 * A node saved before comments moved to this flat, node-level model still
 * has them scattered across `version.comments` (an old field no longer
 * declared on `NodeVersion`, but still sitting in already-stored data) —
 * one array per version, keyed by whichever version happened to be head
 * when each comment was added. Flattens all of that into `node.comments`
 * the first time the node is loaded, deduplicating by id (the same comment
 * could in principle appear on more than one version if it predates a
 * commitNewVersion).
 *
 * Also migrates a comment saved under the even older `anchorKind: 'reply'`
 * (a kind that's since been folded into `'inline'` — see `Comment`'s own
 * doc comment): a plain reply used to carry no mark anywhere at all, so one
 * needs an actual empty `<mark class="comment-anchor" data-comment-id>`
 * appended to the end of its own parent's `body` the first time it's seen,
 * or it would carry `anchorKind: 'inline'` with nothing for the
 * inline-positioning logic to actually find.
 *
 * Only ever runs once per node: a node that already has `comments` (even an
 * empty array) is left alone.
 */
function migrateComments(node: EssayNode): void {
  if (node.comments) return
  const flat: Comment[] = []
  const replyIds = new Set<string>()
  const seen = new Set<string>()
  for (const version of node.versions as unknown as { comments?: LegacyComment[] }[]) {
    for (const c of version.comments ?? []) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (c.anchorKind === 'reply') replyIds.add(c.id)
      const anchorKind: Comment['anchorKind'] = c.anchorKind === 'reply' ? 'inline' : ((c.anchorKind as Comment['anchorKind']) ?? 'text')
      flat.push({ id: c.id, parentId: c.parentId ?? null, anchorKind, anchorText: c.anchorText, body: c.body, resolved: c.resolved, createdAt: c.createdAt, updatedAt: c.updatedAt ?? c.createdAt })
    }
  }
  for (const c of flat) {
    if (!replyIds.has(c.id)) continue
    const parent = flat.find((p) => p.id === c.parentId)
    if (parent) parent.body += `<mark class="comment-anchor" data-comment-id="${c.id}"></mark>`
  }
  node.comments = flat
}

/**
 * Returns whether saving this node also pruned one or more orphaned
 * footnotes (see `pruneOrphanedFootnotes`) — `node.footnotes` is mutated
 * in place, so a caller holding onto the same `node` object already sees
 * the change without needing this return value at all, *except* a UI
 * component whose rendered footnote list came from a still-mounted React
 * prop: mutating the array in place doesn't itself trigger a re-render,
 * so `SectionBlock`'s debounced autosave uses this to know when it needs
 * to explicitly ask for one (see its own `scheduleSave`) rather than
 * leaving a just-deleted footnote looking like it's still there until
 * something unrelated happens to re-render the page.
 */
export async function saveNode(node: EssayNode): Promise<boolean> {
  const pruned = pruneOrphanedFootnotes(node)
  const now = Date.now()
  node.updatedAt = now
  await backend.docs.put(NODES, node)
  // Bubbles up to the parent essay's own `updatedAt` too — this is the one
  // place nearly every real edit passes through (the debounced autosave
  // behind every keystroke, a comment, a footnote, a version commit or
  // revert, moving a subsection), unlike `saveEssay`, which only a handful
  // of essay-level actions call directly (renaming the essay, archiving,
  // deleting). Without this, `listEssays()`'s "sorted by last edited"
  // ordering — and the Drafts tab's sort dropdown default — reflected only
  // those few structural/metadata changes, never the actual writing, which
  // is backwards from what "last edited" should mean. A missing essay
  // (deleted, or a node whose `essayId` is stale) is silently skipped —
  // nothing left to sort by last-edited for.
  const essay = await getEssay(node.essayId)
  if (essay && !essay.deleted) {
    essay.updatedAt = now
    await backend.docs.put(ESSAYS, essay)
  }
  return pruned
}

export async function saveEssay(essay: Essay): Promise<void> {
  essay.updatedAt = Date.now()
  await backend.docs.put(ESSAYS, essay)
}

/**
 * Marks an essay as finished, hiding it from the main Drafts view (behind
 * the "Show archived" toggle there) without deleting anything — unlike
 * `deleteEssay`, nothing underneath it (its nodes, their versions/comments/
 * footnotes) is touched at all; this only ever flips the one flag on the
 * essay itself. `unarchiveEssay` is the plain inverse.
 */
export async function archiveEssay(essay: Essay): Promise<void> {
  essay.archived = true
  await saveEssay(essay)
}

export async function unarchiveEssay(essay: Essay): Promise<void> {
  essay.archived = false
  await saveEssay(essay)
}

export async function createEssay(title: string): Promise<Essay> {
  const now = Date.now()
  const root: EssayNode = {
    id: id(),
    essayId: '', // filled below
    title: title || 'Untitled essay',
    // Deprecated (see NodeVersion's own doc comment) — nothing writes a new
    // one anymore; history now lives in the essayHistory collection (see
    // essayHistoryRepo.ts), populated the first time this essay is
    // committed, not seeded eagerly at creation the way a version used to
    // be.
    versions: [],
    headVersionId: '',
    draftContent: '',
    createdAt: now,
    updatedAt: now,
  }
  const essay: Essay = { id: id(), title: title || 'Untitled essay', rootNodeId: root.id, createdAt: now, updatedAt: now }
  root.essayId = essay.id
  await backend.docs.put(NODES, root)
  await backend.docs.put(ESSAYS, essay)
  return essay
}

/**
 * Tombstones the essay and every node in it, rather than deleting the
 * records outright — a deletion needs to be a *change* (with a newer
 * `updatedAt`) for sync to propagate it to other devices at all, and
 * hard-deleting it locally first would leave nothing to actually push. See
 * the `deleted` field on Essay/EssayNode/Source and the note there.
 */
export async function deleteEssay(essayId: string): Promise<void> {
  const essay = await getEssay(essayId)
  if (!essay) return
  const stack = [essay.rootNodeId]
  while (stack.length) {
    const nid = stack.pop()!
    const node = await getNode(nid)
    if (!node || node.deleted) continue
    stack.push(...getChildIds(node.draftContent))
    node.deleted = true
    await saveNode(node)
  }
  essay.deleted = true
  await saveEssay(essay)
}

export async function createChildNode(essayId: string, title: string, initialContent = ''): Promise<EssayNode> {
  const now = Date.now()
  const node: EssayNode = {
    id: id(),
    essayId,
    title: title || 'Untitled section',
    versions: [], // deprecated — see createEssay's own comment on the same field
    headVersionId: '',
    draftContent: initialContent,
    createdAt: now,
    updatedAt: now,
  }
  await backend.docs.put(NODES, node)
  return node
}

/** `html` with every `[data-child-id]` marker's own id rewritten through `idMap` — `cloneEssay`'s own way of re-pointing a cloned node's embedded subsection markers at its siblings' *new* ids rather than the original tree's. A marker whose id isn't in `idMap` (shouldn't happen for a coherent tree, but matches every other tree walk's own quiet skip of a dangling reference) is left exactly as it is. */
function remapChildMarkerIds(html: string, idMap: Map<string, string>): string {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const el of Array.from(doc.querySelectorAll('[data-child-id]'))) {
    const oldId = el.getAttribute('data-child-id')
    const newId = oldId ? idMap.get(oldId) : undefined
    if (newId) el.setAttribute('data-child-id', newId)
  }
  return doc.body.innerHTML
}

/**
 * A full, independent copy of `essayId`'s current live tree — every
 * reachable node gets a fresh id (so editing the clone can never touch the
 * original, or vice versa) and its own `draftContent`'s subsection markers
 * are rewritten to point at its own cloned children (`remapChildMarkerIds`)
 * rather than the original's. The clone starts with no commit history of
 * its own (an empty `essayHistory` — this is a brand-new document as far
 * as history is concerned, not a revert target pointing back at the
 * original) and no `projectId` (the caller — `EssayWorkspace`'s own
 * "Clone this essay" split-view option — is responsible for grouping the
 * two together via `groupEssays`, which this module can't call directly
 * without an import cycle back from `projectsRepo.ts`).
 *
 * Comment and footnote ids are copied verbatim, not remapped — unlike a
 * node id, neither is ever a storage key or referenced outside the one
 * node that owns it (a footnote's own marker, an inline comment's own
 * mark, both sit in that same node's `draftContent`/comment bodies), so
 * there's no real collision to avoid by minting new ones.
 */
export async function cloneEssay(essayId: string): Promise<Essay | undefined> {
  const original = await getEssay(essayId)
  if (!original) return undefined
  const nodeMap = await loadNodeMap(original)
  const idMap = new Map<string, string>()
  for (const nodeId of nodeMap.keys()) idMap.set(nodeId, id())

  const now = Date.now()
  const newEssayId = id()
  for (const [oldId, node] of nodeMap) {
    const clone: EssayNode = {
      id: idMap.get(oldId)!,
      essayId: newEssayId,
      title: node.title,
      versions: [],
      headVersionId: '',
      draftContent: remapChildMarkerIds(node.draftContent, idMap),
      footnotes: nodeFootnotes(node).map((f) => ({ ...f })),
      comments: nodeComments(node).map((c) => ({ ...c })),
      createdAt: now,
      updatedAt: now,
    }
    await backend.docs.put(NODES, clone)
  }

  const clonedEssay: Essay = { id: newEssayId, title: `Copy of ${original.title}`, rootNodeId: idMap.get(original.rootNodeId)!, createdAt: now, updatedAt: now }
  await backend.docs.put(ESSAYS, clonedEssay)
  return clonedEssay
}

/** `node.comments` is optional (absent on a node not yet touched by `migrateComments` — see `getNode`) — this is the one place that reads it directly, so "absent" and "empty" are treated identically everywhere else. */
export function nodeComments(node: EssayNode): Comment[] {
  migrateComments(node)
  return node.comments!
}

/** Every comment anchored directly to the node itself or to its own text — i.e. every comment that isn't a reply or a comment-on-a-comment. */
export function topLevelComments(node: EssayNode): Comment[] {
  return nodeComments(node).filter((c) => c.parentId === null)
}

/** The replies and comments-on-a-comment nested directly under `commentId` (one level — a caller walking a full thread recurses using this). */
export function commentChildren(node: EssayNode, commentId: string): Comment[] {
  return nodeComments(node).filter((c) => c.parentId === commentId)
}

export function findCommentById(node: EssayNode, commentId: string): Comment | undefined {
  return nodeComments(node).find((c) => c.id === commentId)
}

/** `commentId` itself, plus every comment nested under it at any depth (replies, comments-on-comments, and their own replies/comments, and so on) — the set `deleteCommentCascade` removes, and what a caller needs to also strip any `'text'`-anchor mark for out of live DOM before that runs (see EssayWorkspace/CommentsPanel's own `deleteComment`). */
export function commentSubtreeIds(node: EssayNode, commentId: string): string[] {
  const all = nodeComments(node)
  const result: string[] = []
  const stack = [commentId]
  while (stack.length) {
    const cid = stack.pop()!
    result.push(cid)
    for (const c of all) if (c.parentId === cid) stack.push(c.id)
  }
  return result
}

export async function addComment(
  node: EssayNode,
  opts: { anchorKind: Comment['anchorKind']; anchorText: string; body: string; parentId?: string | null; commentId?: string; displayMode?: 'margin' | 'inline' },
): Promise<Comment> {
  const now = Date.now()
  const comment: Comment = {
    id: opts.commentId ?? id(),
    parentId: opts.parentId ?? null,
    anchorKind: opts.anchorKind,
    anchorText: opts.anchorText,
    body: opts.body,
    displayMode: opts.parentId == null && opts.anchorKind === 'text' ? (opts.displayMode ?? 'margin') : undefined,
    resolved: false,
    createdAt: now,
    updatedAt: now,
  }
  node.comments = [...nodeComments(node), comment]
  await saveNode(node)
  return comment
}

export async function updateCommentBody(node: EssayNode, commentId: string, body: string): Promise<void> {
  const comment = findCommentById(node, commentId)
  if (!comment) return
  comment.body = body
  comment.updatedAt = Date.now()
  await saveNode(node)
}

export async function setCommentResolved(node: EssayNode, commentId: string, resolved: boolean): Promise<void> {
  const comment = findCommentById(node, commentId)
  if (!comment) return
  comment.resolved = resolved
  await saveNode(node)
}

/** All comment ids whose `<mark class="comment-anchor" data-comment-id>` still exists somewhere in `html` — used for a `'text'` comment's mark in a node's own content, or (with a comment's own `body` instead) an `'inline'` comment's mark within its parent. */
export function commentIdsInContent(html: string): string[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll('[data-comment-id]')).map((el) => el.getAttribute('data-comment-id')!)
}

/** Removes just the `<mark class="comment-anchor" data-comment-id="commentId">` wrapper from `html`, keeping whatever text/markup it wrapped in place — the string-level counterpart of unwrapping the same mark out of a live, mounted DOM shard (see EssayWorkspace/CommentsPanel's own `deleteComment`), used here so a comment can be deleted (and its mark cleaned up) even when the section it's anchored in, or the parent comment its mark sits inside, isn't currently mounted. */
function unwrapCommentMark(html: string, commentId: string): string {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const mark = doc.querySelector(`mark.comment-anchor[data-comment-id="${cssEscapeId(commentId)}"]`)
  if (!mark) return html
  mark.replaceWith(...Array.from(mark.childNodes))
  return doc.body.innerHTML
}

function cssEscapeId(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&')
}

/**
 * An inline comment's own marker — always empty in the *stored* HTML, a
 * `contenteditable="false"` island sitting *inside* one ordinary text
 * segment (never a segment boundary of its own — see `childMarkers.ts`'s
 * own doc comment for why that specifically doesn't work for something
 * meant to read inline, mid-sentence). Its rendered content is a real,
 * live, mounted component instead — see `SectionBlock`'s `InlineCommentBody`
 * and its own `createPortal` machinery, which finds this exact element by
 * `data-comment-id` and portals into it directly, so it always reflects the
 * comment's current body with no manual re-sync step.
 */
function inlineCommentMarkerHtml(commentId: string): string {
  return `<span class="inline-comment-marker" data-comment-id="${commentId}" contenteditable="false"></span>`
}

/** Splices `commentId`'s own `.inline-comment-marker` marker right after its `<mark class="comment-anchor">` anchor in `html` — a no-op if the anchor mark isn't there, or if the marker's already in place. */
function insertInlineCommentMarkerAfterAnchor(html: string, commentId: string): string {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const mark = doc.querySelector(`mark.comment-anchor[data-comment-id="${cssEscapeId(commentId)}"]`)
  if (!mark) return html
  if ((mark.nextElementSibling as HTMLElement | null)?.matches(`.inline-comment-marker[data-comment-id="${cssEscapeId(commentId)}"]`)) return html
  const markerDoc = new DOMParser().parseFromString(inlineCommentMarkerHtml(commentId), 'text/html')
  mark.after(doc.importNode(markerDoc.body.firstChild!, true))
  return doc.body.innerHTML
}

/** Removes `commentId`'s own `.inline-comment-marker` marker from `html`, leaving its `<mark class="comment-anchor">` anchor (if any) untouched — the anchor point itself doesn't change between margin and inline, only where the comment's body actually renders. */
function removeInlineCommentMarker(html: string, commentId: string): string {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const marker = doc.querySelector(`.inline-comment-marker[data-comment-id="${cssEscapeId(commentId)}"]`)
  if (!marker) return html
  marker.remove()
  return doc.body.innerHTML
}

/** Replaces `commentId`'s own `.inline-comment-marker` marker in `html` outright with `bodyHtml` — used only by `promoteInlineComment`, where the marker's placeholder gives way to the comment's real body content becoming ordinary document text. */
function replaceInlineCommentMarker(html: string, commentId: string, bodyHtml: string): string {
  if (!html) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const marker = doc.querySelector(`.inline-comment-marker[data-comment-id="${cssEscapeId(commentId)}"]`)
  if (!marker) return html
  const frag = new DOMParser().parseFromString(bodyHtml || '', 'text/html')
  marker.replaceWith(...Array.from(frag.body.childNodes).map((n) => doc.importNode(n, true)))
  return doc.body.innerHTML
}

/**
 * Switches a top-level, `'text'`-anchored comment between the margin (a
 * positioned card off to the side) and inline (a small marker rendered
 * right in the document's own text flow, showing a muted preview of the
 * comment and opening an editing popover on click — see `SectionBlock`'s
 * own inline-comment rendering) display modes — see `Comment.displayMode`'s
 * own doc comment. The comment's anchor mark itself is untouched either
 * way; only whether a `.inline-comment-marker` for its body also sits
 * right after that anchor changes. No-op for a comment that isn't a
 * top-level `'text'` comment (a `'node'` comment has no anchor point to
 * render inline *at*, and a nested comment always renders as part of its
 * parent's own thread regardless of this field).
 */
export async function setCommentDisplayMode(node: EssayNode, commentId: string, mode: 'margin' | 'inline'): Promise<void> {
  const comment = findCommentById(node, commentId)
  if (!comment || comment.anchorKind !== 'text' || comment.parentId !== null) return
  comment.displayMode = mode
  node.draftContent = mode === 'inline' ? insertInlineCommentMarkerAfterAnchor(node.draftContent, commentId) : removeInlineCommentMarker(node.draftContent, commentId)
  await saveNode(node)
}

/**
 * Dissolves an inline comment back into ordinary prose: its own body's HTML
 * is spliced directly into the section's `draftContent` in place of its
 * `.inline-comment-marker` marker, its anchor `<mark>` is unwrapped (keeping
 * whatever text it highlighted, same as a deleted comment's mark would be),
 * and the comment's own record is dropped — there's no longer anything for
 * it to be. Any comment directly nested under it (a reply, or a genuine
 * comment-on-a-comment) is promoted along with it: its `parentId` becomes
 * null and its `anchorKind` becomes `'text'`, since its own anchor mark —
 * still sitting inside the promoted body's HTML — now lives in the node's
 * *own* `draftContent` rather than inside another comment's `body`. A
 * reply/comment nested *under one of those* (two levels down from the
 * promoted comment) is untouched: its `parentId` still correctly points at
 * a comment that still exists, just no longer nested itself.
 */
export async function promoteInlineComment(node: EssayNode, commentId: string): Promise<void> {
  const comment = findCommentById(node, commentId)
  if (!comment || comment.parentId !== null) return
  let draftContent = replaceInlineCommentMarker(node.draftContent, commentId, comment.body)
  draftContent = unwrapCommentMark(draftContent, commentId)
  node.draftContent = draftContent
  for (const child of commentChildren(node, commentId)) {
    child.parentId = null
    child.anchorKind = 'text'
    if (!child.displayMode) child.displayMode = 'margin'
  }
  node.comments = nodeComments(node).filter((c) => c.id !== commentId)
  await saveNode(node)
}

/**
 * Deletes `commentId` and every comment nested under it, at any depth
 * (replies, comments-on-comments, and their own replies/comments-on-them,
 * and so on) — the recursive cascade requirement 6 asks for. Also cleans
 * up whatever anchor mark each deleted comment owned: a deleted `'text'`
 * comment's mark is unwrapped out of the node's own `draftContent`, and a
 * deleted `'inline'` comment's mark is unwrapped out of whichever
 * *surviving* comment's `body` it sat inside (no need to touch a parent
 * that's being deleted too — its whole body is going away regardless).
 * The caller is responsible for unwrapping a `'text'` mark from the live,
 * mounted DOM shard *first* if one exists (same division of labor as
 * footnote deletion) — this only ever touches the saved data.
 */
export async function deleteCommentCascade(node: EssayNode, commentId: string): Promise<void> {
  const all = nodeComments(node)
  const toDelete = new Set(commentSubtreeIds(node, commentId))
  const deletedTextIds = all.filter((c) => toDelete.has(c.id) && c.anchorKind === 'text').map((c) => c.id)
  const deletedInlineIds = all.filter((c) => toDelete.has(c.id) && c.anchorKind === 'inline').map((c) => c.id)
  const deletedInlineDisplayIds = all.filter((c) => toDelete.has(c.id) && c.displayMode === 'inline').map((c) => c.id)

  let draftContent = node.draftContent
  for (const cid of deletedTextIds) draftContent = unwrapCommentMark(draftContent, cid)
  for (const cid of deletedInlineDisplayIds) draftContent = removeInlineCommentMarker(draftContent, cid)
  node.draftContent = draftContent

  const kept = all.filter((c) => !toDelete.has(c.id))
  for (const c of kept) {
    let body = c.body
    for (const cid of deletedInlineIds) body = unwrapCommentMark(body, cid)
    c.body = body
  }
  node.comments = kept
  await saveNode(node)
}

/** `node.footnotes` is optional (absent on any node saved before footnotes existed) — this is the one place that reads it, so "absent" and "empty" are treated identically everywhere else. */
export function nodeFootnotes(node: EssayNode): Footnote[] {
  return node.footnotes ?? []
}

/** Every footnote id a `<sup class="footnote-ref" data-footnote-id>` marker in `html` still points to. */
function footnoteIdsInContent(html: string): string[] {
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return Array.from(doc.querySelectorAll('sup.footnote-ref[data-footnote-id]')).map((el) => el.getAttribute('data-footnote-id')!)
}

/**
 * Drops any footnote whose marker no longer appears *anywhere* this node's
 * content could still show it — not just the live draft, but every saved
 * version too. Unlike a `Comment`, a `Footnote` isn't per-version data at
 * all (see the design note above `EssayNode.versions`): `node.footnotes` is
 * one flat list, and "which footnotes exist" has always meant "whichever
 * ones some marker, in some version or the live draft, still references."
 * A marker referenced only by an *older* version's frozen content — most
 * commonly right after "Make a new version" clears the live draft for
 * fresh writing, leaving the just-frozen version as the only place its
 * markers still live — still needs its footnote kept around in case that
 * version is ever reverted to; pruning purely off the live draft would
 * silently destroy it the moment the freeze happened, long before anyone
 * asked to delete anything. Only once a footnote's marker is gone from
 * every version *and* the live draft — normal editing deleted the marker,
 * and nothing in the node's own history still points back to it — is it
 * genuinely unreachable, which is when this drops it: the fix for a
 * footnote whose only "delete" affordance used to be a separate button in
 * the footnote list, disconnected from the ordinary act of deleting its
 * reference from the text.
 */
function pruneOrphanedFootnotes(node: EssayNode): boolean {
  if (!node.footnotes || node.footnotes.length === 0) return false
  const referenced = new Set(footnoteIdsInContent(node.draftContent))
  for (const version of node.versions) for (const fid of footnoteIdsInContent(version.content)) referenced.add(fid)
  const kept = node.footnotes.filter((f) => referenced.has(f.id))
  if (kept.length === node.footnotes.length) return false
  node.footnotes = kept
  return true
}

/** Appends a new, empty footnote to the node and returns it — the caller inserts its `<sup class="footnote-ref" data-footnote-id>` marker into the live content separately (see EssayWorkspace's `insertFootnote`) and saves the node itself once both changes are made. */
export function addFootnote(node: EssayNode): Footnote {
  const footnote: Footnote = { id: id(), content: '' }
  node.footnotes = [...nodeFootnotes(node), footnote]
  return footnote
}

export async function updateFootnoteContent(node: EssayNode, footnoteId: string, content: string): Promise<void> {
  const footnote = nodeFootnotes(node).find((f) => f.id === footnoteId)
  if (!footnote) return
  footnote.content = content
  await saveNode(node)
}

/** Removes a footnote from the node's list — the caller is responsible for also removing its marker from the live content (see EssayWorkspace's `deleteFootnote`), same division of labor as `addFootnote`. */
export async function deleteFootnote(node: EssayNode, footnoteId: string): Promise<void> {
  node.footnotes = nodeFootnotes(node).filter((f) => f.id !== footnoteId)
  await saveNode(node)
}

/**
 * Deletes just this node's own record — used when "demoting" a subsection:
 * its content gets spliced back into its parent's content (grandchildren's
 * markers travel along with it automatically, since they're literally part
 * of that content string), so nothing but this one now-redundant record
 * needs to go away.
 */
export async function deleteNodeOnly(nodeId: string): Promise<void> {
  const node = await getNode(nodeId)
  if (!node) return
  node.deleted = true
  await saveNode(node)
}

/**
 * Moves `nodeId` from being a child of `fromParentId` to `placement` under
 * `toParentId` (which may be the same node, for a same-parent reorder).
 * Purely a structural edit — versions and their history are untouched, on
 * either the moved node or either parent, by design: dragging a section
 * around is not itself a version-worthy change to anyone's text.
 */
export async function moveNode(nodeId: string, fromParentId: string, toParentId: string, placement: MarkerPlacement): Promise<void> {
  const fromParent = await getNode(fromParentId)
  if (!fromParent) return
  const withoutNode = removeMarkerFromContent(fromParent.draftContent, nodeId)
  if (fromParentId === toParentId) {
    fromParent.draftContent = insertMarkerInContent(withoutNode, nodeId, placement)
    await saveNode(fromParent)
    return
  }
  fromParent.draftContent = withoutNode
  await saveNode(fromParent)
  const toParent = await getNode(toParentId)
  if (!toParent) return
  toParent.draftContent = insertMarkerInContent(toParent.draftContent, nodeId, placement)
  await saveNode(toParent)
}

/** Loads the whole live node tree for an essay into a flat map, for rendering — walked purely from each node's own current `draftContent` (there's no more reason to also walk old `versions` content for a node a stale version-compare view might have orphaned; that feature no longer exists — see `EssayHistoryPanel.tsx`'s own reconstructed snapshots for how past content is browsed instead). */
export async function loadNodeMap(essay: Essay): Promise<Map<string, EssayNode>> {
  const map = new Map<string, EssayNode>()
  const stack = [essay.rootNodeId]
  while (stack.length) {
    const nid = stack.pop()!
    if (map.has(nid)) continue
    const node = await getNode(nid)
    if (!node || node.deleted) continue
    map.set(nid, node)
    stack.push(...getChildIds(node.draftContent))
  }
  return map
}
