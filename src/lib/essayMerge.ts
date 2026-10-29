/**
 * The actual three-way merge behind essay sync (`sync/syncEngine.ts`'s own
 * `reconcileEssaysThreeWay`) — pure, framework-free logic over plain JSON
 * (an essay's `title`/`authorNote`/`deleted`/`comments`/`doc`), with no
 * knowledge of Firestore, IndexedDB, or even a live ProseMirror `Node`
 * instance. Given a `base` (the content as of the last point this device
 * and the remote account were known to agree — see `syncEngine.ts`'s own
 * `essaySyncBases`), and the `local`/`remote` copies as they stand now,
 * this reconciles independent edits on both sides instead of the
 * whole-essay last-write-wins every other synced collection still uses
 * (`syncEngine.ts`'s own generic push/pull loops) — the real gap that
 * left in place: two devices editing *different* parts of the same essay
 * between syncs used to mean whichever synced second silently discarded
 * the other's entire essay, content both sides actually wanted kept.
 *
 * Granularity, deliberately scoped rather than a full operational-
 * transform/CRDT system:
 *
 * - `comments`: merged per-comment, keyed by `id` (stable, random, never
 *   reused) — an addition, edit, or deletion on one side alone always
 *   survives; a comment edited on *both* sides differently is the one true
 *   per-comment conflict, resolved by that comment's own newer `updatedAt`
 *   (see `mergeComments`).
 * - `doc`: merged section-by-section, keyed by each `section`'s own
 *   stable `attrs.id` — a section added, removed, moved, or edited on only
 *   one side survives untouched; a section edited on both sides recurses
 *   into its own content. *Within* a section, the non-title children
 *   (ordinary paragraphs/lists/blockquotes/etc., interleaved with any
 *   nested sections — see `pmSchema.ts`'s own doc comment on why those
 *   interleave) are merged as a single ordered list, matched by *content*
 *   (a block with the exact same JSON on both sides is recognized as
 *   unchanged, regardless of where it moved to) rather than any node-level
 *   identity, since nothing but a `section` carries a durable id at all.
 *   This is paragraph-granularity, not character-granularity: two
 *   different edits to the *same original paragraph* (one fixes a typo,
 *   the other adds a citation) aren't merged word-by-word — true character-
 *   level merging is a much bigger system (real operational transform) and
 *   deliberately out of scope here. When that happens, or when the same
 *   span of a section's content is independently restructured on both
 *   sides in a way list-diffing can't reconcile positionally, it's a real
 *   conflict: the newer side's content stays live, and the older side's
 *   conflicting content is *not* discarded — it comes back in `conflicts`,
 *   for the caller to preserve (`syncEngine.ts` sends each one to that
 *   essay's own Graveyard, the same "cut, not destroyed" landing spot
 *   "Send to graveyard" already uses for anything else removed from a
 *   document on purpose).
 * - `title`/`authorNote`: plain three-way scalar merge — unchanged on one
 *   side always yields to whatever the other side has; genuinely changed
 *   differently on both sides resolves to the newer essay's version (no
 *   graveyard preservation for a single short field; see `mergeScalar`).
 * - `deleted`: the one field where "newer wins" is deliberately
 *   overridden — see `mergeEssayContent`'s own doc comment on "edit beats
 *   delete."
 *
 * No `base` at all (this device has never resolved this essay against the
 * remote copy before — true for every essay in every account the first
 * time this feature runs) means there's no ancestor to diff against, so
 * this falls back to picking the newer side wholesale, same as the old
 * last-write-wins behavior — but still *records* the winning content as
 * the new base, so the very next divergence between these two copies gets
 * a real three-way merge instead of staying last-write-wins forever.
 */
import { diff3Merge } from 'node-diff3'
import type { Comment } from '../models/types'

export interface EssayMergeSnapshot {
  title: string
  doc?: unknown
  comments?: Comment[]
  authorNote?: string
  deleted?: boolean
}

/** One region of a `doc` merge that couldn't be kept live without picking a winner — the losing side's own content, not discarded, for the caller to park somewhere recoverable (the Graveyard). `nodes` are plain PM JSON nodes (the same shape `Essay.doc` itself stores), in their original document order. */
export interface EssayMergeConflict {
  sectionId: string
  sectionTitle: string
  nodes: unknown[]
}

export interface EssayMergeResult {
  title: string
  doc?: unknown
  comments: Comment[]
  authorNote?: string
  deleted: boolean
  conflicts: EssayMergeConflict[]
}

/** Stable, key-order-independent serialization — the one thing this module ever uses to decide "are these two JSON values actually the same." */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) out[k] = canonical((value as Record<string, unknown>)[k])
    return out
  }
  return value
}

function ck(value: unknown): string {
  return JSON.stringify(canonical(value))
}

/** Key-order-independent structural equality — exported for `sync/syncEngine.ts`'s own use deciding whether a merge result actually differs from what's currently stored on either side (and so needs writing/pushing at all). */
export function deepEqual(a: unknown, b: unknown): boolean {
  return ck(a) === ck(b)
}

/** Plain three-way scalar merge: unchanged-from-base on one side always yields to the other side's value; changed differently on both resolves to whichever this merge is already preferring (see `mergeEssayContent`'s own `preferLocal`). `base` is `undefined` for the no-base bootstrap case, in which case there's nothing to compare against but `local`/`remote` themselves. */
function mergeScalar<T>(base: T | undefined, local: T, remote: T, preferLocal: boolean): T {
  if (local === remote) return local
  if (base !== undefined && base === local) return remote
  if (base !== undefined && base === remote) return local
  return preferLocal ? local : remote
}

/**
 * Per-comment three-way merge, keyed by `Comment.id` (random, durable,
 * never reused — see `models/types.ts`). Four cases beyond the trivial
 * ones: added fresh on exactly one side (kept), deleted on exactly one
 * side with the other side leaving it untouched (deletion wins), deleted
 * on one side while the *other* side actually edited it ("edit beats
 * delete" — same reasoning `mergeEssayContent` applies at the whole-essay
 * level, just per-comment here), and genuinely edited differently on both
 * sides (resolved by that one comment's own `updatedAt`, finer-grained
 * than the whole essay's).
 */
function mergeComments(base: Comment[], local: Comment[], remote: Comment[]): Comment[] {
  const baseMap = new Map(base.map((c) => [c.id, c]))
  const localMap = new Map(local.map((c) => [c.id, c]))
  const remoteMap = new Map(remote.map((c) => [c.id, c]))
  const ids = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])

  const result: Comment[] = []
  for (const id of ids) {
    const b = baseMap.get(id)
    const l = localMap.get(id)
    const r = remoteMap.get(id)

    if (!b) {
      // Not present in the base at all: a fresh addition on one (the
      // overwhelming common case) or, vanishingly unlikely given random
      // ids, both sides at once.
      if (l && r) result.push(deepEqual(l, r) || l.updatedAt >= r.updatedAt ? l : r)
      else if (l) result.push(l)
      else if (r) result.push(r)
      continue
    }
    if (!l && !r) continue // deleted on both sides
    if (!l) {
      if (!deepEqual(r, b)) result.push(r!) // remote actually edited it — edit beats delete
      continue
    }
    if (!r) {
      if (!deepEqual(l, b)) result.push(l)
      continue
    }
    if (deepEqual(l, r)) result.push(l)
    else if (deepEqual(l, b)) result.push(r)
    else if (deepEqual(r, b)) result.push(l)
    else result.push(l.updatedAt >= r.updatedAt ? l : r)
  }
  return result
}

// ---- doc (PM JSON) merge, at section granularity ------------------------

interface PMJsonNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PMJsonNode[]
  text?: string
  marks?: unknown[]
}

function asNode(value: unknown): PMJsonNode | undefined {
  return value && typeof value === 'object' ? (value as PMJsonNode) : undefined
}

function rootSection(doc: unknown): PMJsonNode | undefined {
  const root = asNode(doc)?.content?.[0]
  return root?.type === 'section' ? root : undefined
}

function sectionTitleText(section: PMJsonNode): string {
  const titleNode = section.content?.[0]
  return (titleNode?.content ?? []).map((c) => c.text ?? '').join('')
}

function sectionTitleNode(text: string): PMJsonNode {
  return text ? { type: 'section_title', content: [{ type: 'text', text }] } : { type: 'section_title' }
}

/** Everything in a section's own content after its mandatory first `section_title` child — ordinary blocks and nested sections, interleaved in document order (`pmSchema.ts`'s own doc comment on why). */
function sectionChildren(section: PMJsonNode): PMJsonNode[] {
  return (section.content ?? []).slice(1)
}

/** A section-type child's own durable match key (its id, stable across edits); any other child's key is content-addressed — the exact same JSON on both sides is recognized as the same, unmodified block regardless of where it moved to; anything else (even a one-word edit) is a different key entirely. See this module's own doc comment for why that's paragraph-, not character-, granularity. */
function keyFor(node: PMJsonNode): string {
  return node.type === 'section' && typeof node.attrs?.id === 'string' ? `section:${node.attrs.id}` : `block:${ck(node)}`
}

function indexSectionsById(children: PMJsonNode[]): Map<string, PMJsonNode> {
  const map = new Map<string, PMJsonNode>()
  for (const c of children) if (c.type === 'section' && typeof c.attrs?.id === 'string') map.set(c.attrs.id as string, c)
  return map
}

function sectionIdFromKey(key: string): string {
  return key.slice('section:'.length)
}

/**
 * Merges one section's own content — its title (a plain scalar merge) and
 * its children (a three-way *list* merge via `node-diff3`, treating each
 * child's own `keyFor` as the comparison unit). `base`/`local`/`remote`
 * are always the *same* section (same `attrs.id`) at this point — this is
 * only ever called once the caller already knows all three sides have it.
 */
function mergeSection(base: PMJsonNode, local: PMJsonNode, remote: PMJsonNode, preferLocal: boolean, conflicts: EssayMergeConflict[]): PMJsonNode {
  const id = local.attrs?.id as string
  const title = mergeScalar(sectionTitleText(base), sectionTitleText(local), sectionTitleText(remote), preferLocal)
  const baseChildren = sectionChildren(base)
  const localChildren = sectionChildren(local)
  const remoteChildren = sectionChildren(remote)

  const baseKeys = baseChildren.map(keyFor)
  const localKeys = localChildren.map(keyFor)
  const remoteKeys = remoteChildren.map(keyFor)

  const baseById = indexSectionsById(baseChildren)
  const localById = indexSectionsById(localChildren)
  const remoteById = indexSectionsById(remoteChildren)
  const blocksByKey = new Map<string, PMJsonNode>()
  for (const c of [...baseChildren, ...localChildren, ...remoteChildren]) if (c.type !== 'section') blocksByKey.set(keyFor(c), c)

  const resolveSectionKey = (key: string): PMJsonNode | undefined => {
    const sid = sectionIdFromKey(key)
    return localById.get(sid) ?? remoteById.get(sid) ?? baseById.get(sid)
  }

  const regions = diff3Merge(localKeys, baseKeys, remoteKeys, { excludeFalseConflicts: true })
  const resultKeys: string[] = []
  for (const region of regions) {
    if (region.ok) {
      resultKeys.push(...region.ok)
      continue
    }
    const c = region.conflict!
    const winning = preferLocal ? c.a : c.b
    const losing = preferLocal ? c.b : c.a
    resultKeys.push(...winning)

    const winningSet = new Set(winning)
    const baseSet = new Set(c.o)
    const losingNodes = losing
      .filter((key) => !winningSet.has(key) && !baseSet.has(key))
      .map((key) => (key.startsWith('section:') ? resolveSectionKey(key) : blocksByKey.get(key)))
      .filter((n): n is PMJsonNode => !!n)
    if (losingNodes.length > 0) conflicts.push({ sectionId: id, sectionTitle: title, nodes: losingNodes })
  }

  const children = resultKeys.map((key): PMJsonNode => {
    if (!key.startsWith('section:')) return blocksByKey.get(key)!
    const sid = sectionIdFromKey(key)
    const b = baseById.get(sid)
    const l = localById.get(sid)
    const r = remoteById.get(sid)
    if (b && l && r) return mergeSection(b, l, r, preferLocal, conflicts)
    // A fresh addition with no base counterpart — nothing to three-way
    // merge; take whichever version actually has it.
    return (l ?? r ?? b)!
  })

  // A section's own content model (`pmSchema.ts`) requires at least one
  // non-title block — if every one of this section's own children lost
  // out to a conflict resolution (or were all removed in a way that left
  // nothing behind), fall back to one empty paragraph, same placeholder
  // every other section-creating command in this codebase seeds a new,
  // otherwise-empty section with.
  const finalChildren = children.length > 0 ? children : [{ type: 'paragraph' } as PMJsonNode]

  return { type: 'section', attrs: { id, collapsed: false }, content: [sectionTitleNode(title), ...finalChildren] }
}

function mergeDoc(baseDoc: unknown, localDoc: unknown, remoteDoc: unknown, preferLocal: boolean): { doc: unknown; conflicts: EssayMergeConflict[] } {
  const conflicts: EssayMergeConflict[] = []
  const baseRoot = rootSection(baseDoc)
  const localRoot = rootSection(localDoc)
  const remoteRoot = rootSection(remoteDoc)
  // No usable structure to merge (a malformed/foreign doc, or the root
  // section's own identity doesn't line up across all three — never true
  // for a real essay, whose root id is set once at creation and never
  // regenerated) — fall back to picking a whole side rather than crashing.
  if (!baseRoot || !localRoot || !remoteRoot || baseRoot.attrs?.id !== localRoot.attrs?.id || baseRoot.attrs?.id !== remoteRoot.attrs?.id) {
    return { doc: preferLocal ? localDoc : remoteDoc, conflicts: [] }
  }
  const merged = mergeSection(baseRoot, localRoot, remoteRoot, preferLocal, conflicts)
  return { doc: { type: 'doc', content: [merged] }, conflicts }
}

function contentOf(s: EssayMergeSnapshot) {
  return { title: s.title, doc: s.doc, comments: s.comments ?? [], authorNote: s.authorNote }
}

/**
 * The entry point — reconciles one essay's `local`/`remote` copies against
 * their shared `base` (`null` for the no-base bootstrap case — see this
 * module's own doc comment). `local`/`remote` each carry their own whole-
 * essay `updatedAt`, used as the tiebreak wherever a genuine conflict has
 * no finer-grained timestamp to resolve by (comments use their own;
 * `doc` content and scalar fields don't, so they fall back to this).
 *
 * `deleted` is the one field where "newer wins" is deliberately
 * overridden: a plain scalar merge would let a delete on one side
 * silently destroy real, concurrent editing work on the other the moment
 * the delete happened to have the later timestamp — e.g. device A edits a
 * paragraph, device B (not having seen that edit yet) deletes the whole
 * essay a minute later; last-write-wins would erase A's edit along with
 * everything else. "Edit beats delete" instead: a delete on one side only
 * takes effect if the *other* side made no real content change relative
 * to the base — otherwise the essay comes back (undeleted), keeping the
 * edit. Deleted on both sides, or agreeing on the same value, is just the
 * trivial case either way.
 */
export function mergeEssayContent(base: EssayMergeSnapshot | null, local: EssayMergeSnapshot & { updatedAt: number }, remote: EssayMergeSnapshot & { updatedAt: number }): EssayMergeResult {
  const preferLocal = local.updatedAt >= remote.updatedAt

  const localContentChanged = base ? !deepEqual(contentOf(local), contentOf(base)) : true
  const remoteContentChanged = base ? !deepEqual(contentOf(remote), contentOf(base)) : true

  let deleted: boolean
  if (!base) {
    deleted = !!(preferLocal ? local.deleted : remote.deleted)
  } else if (!!base.deleted === !!local.deleted && !!base.deleted === !!remote.deleted) {
    deleted = !!base.deleted
  } else if (!!local.deleted === !!remote.deleted) {
    deleted = !!local.deleted
  } else if (local.deleted && !remoteContentChanged) {
    deleted = true
  } else if (remote.deleted && !localContentChanged) {
    deleted = true
  } else {
    deleted = false // edit beats delete
  }

  const title = mergeScalar(base?.title, local.title, remote.title, preferLocal)
  const authorNote = mergeScalar(base?.authorNote, local.authorNote, remote.authorNote, preferLocal)
  const comments = mergeComments(base?.comments ?? [], local.comments ?? [], remote.comments ?? [])

  let doc: unknown
  let conflicts: EssayMergeConflict[]
  if (deepEqual(local.doc, remote.doc)) {
    doc = local.doc
    conflicts = []
  } else if (base && deepEqual(base.doc, local.doc)) {
    doc = remote.doc
    conflicts = []
  } else if (base && deepEqual(base.doc, remote.doc)) {
    doc = local.doc
    conflicts = []
  } else if (base?.doc) {
    ;({ doc, conflicts } = mergeDoc(base.doc, local.doc, remote.doc, preferLocal))
  } else {
    doc = preferLocal ? local.doc : remote.doc
    conflicts = []
  }

  return { title, doc, comments, authorNote, deleted, conflicts }
}
