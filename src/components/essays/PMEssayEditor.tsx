import { useEffect, useRef } from 'preact/hooks'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { splitListItem } from 'prosemirror-schema-list'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema } from '../../lib/pmSchema'
import { saveEssay } from '../../models/essaysRepo'
import { createCitationView, SectionView } from './pmNodeViews'
import { createCommentPlugin } from './pmCommentPlugin'
import type { Essay, Source } from '../../models/types'

/**
 * The real ProseMirror editing surface for a migrated essay (`Essay.doc`) —
 * replaces `SectionBlock.tsx`'s own per-node `contentEditable` shards and
 * `reconstructContent()`'s DOM-walk-back-to-HTML persistence with a real
 * `EditorView`/`EditorState`: every edit is a `Transaction` against the
 * actual document model, not a DOM mutation reconciled after the fact.
 *
 * Mounts and tears down its own `EditorView` imperatively in an effect
 * (ProseMirror owns this DOM subtree directly, the same way the old
 * `contentEditable` shards did, so there's nothing for Preact to
 * reconcile inside `containerRef` itself) — remounts fresh whenever
 * `essay.id` changes (switching essays, or a split-view pane opening a
 * different one), never for an unrelated re-render.
 *
 * Persistence: a transaction that actually changed the document schedules
 * a debounced (500ms, matching the old shard-level cadence) save of the
 * *whole* `essay.doc` — the "maximal" single-document model's own known
 * sync-safety tradeoff (whole-doc last-write-wins, no per-field merge),
 * accepted up front when this migration was first planned, with real
 * diff/merge explicitly left as future work once a "last synced version"
 * anchor exists to diff against.
 *
 * `onViewReady`/`onViewDestroyed` hand the live `EditorView` up to
 * `EssayWorkspace`, which drives toolbar commands (`toggleMark`,
 * `wrapInList`, insert-citation, …) directly against it — the PM-native
 * analogue of the old `activeEditorEl`/`exec()` pattern. `onDocChanged`
 * fires on every document-changing transaction, handing up the new `doc`
 * itself — for anything outside the editor that needs to stay in sync
 * with its *current* content (the outline's own section titles, a live
 * word count), since ProseMirror owns its state internally and Preact
 * never sees it otherwise.
 */
/**
 * A section's own `collapsed` attr (`pmSchema.ts`) is deliberately
 * *session* state, not document state — it should reset to "all expanded"
 * on reload the same way scroll position or cursor placement would, never
 * synced to another device or left folded in a backup. Rather than a
 * second, separate state-sync channel alongside the document (which really
 * would add real complexity — an imperative registry of mounted
 * `SectionView`s to push toggles into, a second re-render trigger for the
 * sidebar, all duplicating what `setNodeMarkup`/`onDocChanged` already give
 * the *document* case for free), toggling collapse stays an ordinary
 * transaction against the live, in-memory document — the sidebar and the
 * in-document chevron (`pmCommands.ts`'s `toggleSectionCollapsed`,
 * `pmNodeViews.ts`'s `SectionView`) both read/write it exactly as before,
 * fully live within this one mounted session. Only the persistence
 * boundary right here is different: every `collapsed` is reset to `false`
 * on the way into `essay.doc`, so whatever lands in storage (and syncs to
 * other devices) never remembers it — the next fresh load of this essay
 * (a real reload, or just switching away and back, which remounts this
 * same `EditorView` from `essay.doc`) always starts fully expanded.
 */
function stripCollapsedAttrs(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node
  const obj = node as Record<string, unknown>
  const next: Record<string, unknown> = { ...obj }
  if (next.type === 'section' && next.attrs && typeof next.attrs === 'object') {
    next.attrs = { ...(next.attrs as Record<string, unknown>), collapsed: false }
  }
  if (Array.isArray(next.content)) {
    next.content = next.content.map(stripCollapsedAttrs)
  }
  return next
}

export function PMEssayEditor({
  essay,
  sources,
  commentsHolder,
  onAnchorClick,
  editable = true,
  onViewReady,
  onViewDestroyed,
  onDocChanged,
}: {
  essay: Essay
  /** Live source map (`listSources()`, loaded once by `EssayWorkspace.tsx`) — closed over by the `citation` NodeView so every citation always renders fresh from current bibtex, never a cached label (see `pmSchema.ts`'s own doc comment). */
  sources: Map<string, Source>
  /** A stable holder for the live `essay` (same "never replaced, always re-pointed at the current object" shape as `sources` above) — closed over once by `pmCommentPlugin.ts`'s own decorations, which need `essay.comments` fresh on every rebuild, not whatever it was the moment this `EditorView` first mounted. */
  commentsHolder: { current: Essay | null }
  /** A `comment_anchor` mark (margin) or an inline comment's own preview chip was clicked — see `pmCommentPlugin.ts`'s own doc comment for why this is the one place both route through. */
  onAnchorClick?: (commentId: string) => void
  editable?: boolean
  onViewReady?: (view: EditorView) => void
  onViewDestroyed?: () => void
  onDocChanged?: (doc: PMNode) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Read live by `editable: () => editableRef.current` below, rather than
  // closed over once — "Comment mode" (EssayWorkspace.tsx) needs to flip
  // the live view between editable and read-only without remounting it
  // (which would tear down undo history, scroll position, everything).
  const editableRef = useRef(editable)
  editableRef.current = editable
  // Same reasoning as `sources`/`commentsHolder` above — the comment
  // plugin's own click handler is built once, inside the mount effect
  // below, so closing over the `onAnchorClick` *prop* directly would wire
  // it to whichever render happened to be current at mount time (and, in
  // turn, to that render's own stale `essay`/`openInlineComment` — this
  // was a real bug, caught live: an inline comment's preview chip, added
  // *after* the editor first mounted, didn't open its popover at all,
  // because the handler closed over at mount time still thought there
  // were no comments yet).
  const onAnchorClickRef = useRef(onAnchorClick)
  onAnchorClickRef.current = onAnchorClick

  useEffect(() => {
    if (!containerRef.current) return
    const doc = PMNode.fromJSON(essaySchema, essay.doc)
    let saveTimer: number | undefined

    function scheduleSave(newDoc: PMNode) {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        essay.doc = stripCollapsedAttrs(newDoc.toJSON())
        essay.updatedAt = Date.now()
        saveEssay(essay)
      }, 500)
    }

    const state = EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo,
          'Mod-b': toggleMark(essaySchema.marks.strong),
          'Mod-i': toggleMark(essaySchema.marks.em),
          'Mod-u': toggleMark(essaySchema.marks.underline),
          Enter: splitListItem(essaySchema.nodes.list_item),
        }),
        keymap(baseKeymap),
        createCommentPlugin(commentsHolder, (commentId) => onAnchorClickRef.current?.(commentId)),
      ],
    })

    const view = new EditorView(containerRef.current, {
      state,
      editable: () => editableRef.current,
      nodeViews: {
        citation: (node, v, getPos) => new (createCitationView(sources))(node, v, getPos as () => number | undefined),
        section: (node, v, getPos) => new SectionView(node, v, getPos as () => number | undefined),
      },
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr)
        view.updateState(newState)
        if (tr.docChanged) {
          onDocChanged?.(newState.doc)
          if (editableRef.current) scheduleSave(newState.doc)
        }
      },
    })

    onViewReady?.(view)
    onDocChanged?.(doc)
    return () => {
      window.clearTimeout(saveTimer)
      view.destroy()
      onViewDestroyed?.()
    }
    // Only `essay.id` — a new EditorView per essay switch, never per
    // unrelated prop/state change. `editable` itself is read live off
    // `editableRef` (see above) specifically so "Comment mode" can flip it
    // without a remount; `sources`/`commentsHolder` are the same kind of
    // stable, mutated-in-place container, read fresh by the NodeViews/
    // plugin that close over them rather than re-closed-over per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [essay.id])

  return <div className="pm-editor-root" ref={containerRef} />
}
