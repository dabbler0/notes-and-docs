import { useEffect, useRef } from 'preact/hooks'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { splitListItem, sinkListItem } from 'prosemirror-schema-list'
import { Node as PMNode } from 'prosemirror-model'
import { essaySchema } from '../../lib/pmSchema'
import { saveEssay } from '../../models/essaysRepo'
import { createCitationView, SectionView, FootnoteView, createMathView, SlideBreakView, FragmentBreakView } from './pmNodeViews'
import { splitIntoSection } from './pmCommands'
import { createCommentPlugin } from './pmCommentPlugin'
import { createCitationArrowPlugin } from './pmCitationArrowPlugin'
import { createActiveSectionPlugin } from './pmActiveSectionPlugin'
import { createMathInputRules, createListInputRules } from './pmInputRules'
import type { Essay, Source } from '../../models/types'

/**
 * The minimal shape `PMEssayEditor` actually needs from whatever record it's
 * editing — just enough to load/save a PM `doc`. `Essay` already satisfies
 * this structurally, so every existing caller keeps type-checking unchanged;
 * `Slideshow` (`SlideshowWorkspace.tsx`) satisfies it too, which is the whole
 * point: a slideshow's document is a strict superset of the essay format
 * (`pmSchema.ts`'s own doc comment on `slide_break`/`fragment_break`), so the
 * *editor* for it can be exactly this same component, not a reimplementation.
 */
export interface PMDocHost {
  id: string
  doc?: unknown
  updatedAt: number
}

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
  record,
  sources,
  commentsHolder,
  onAnchorClick,
  onCiteShortcut,
  editable = true,
  onViewReady,
  onViewDestroyed,
  onDocChanged,
  onSave,
}: {
  record: PMDocHost
  /** Live source map (`listSources()`, loaded once by `EssayWorkspace.tsx`) — closed over by the `citation` NodeView so every citation always renders fresh from current bibtex, never a cached label (see `pmSchema.ts`'s own doc comment). */
  sources: Map<string, Source>
  /** A stable holder for the live essay (same "never replaced, always re-pointed at the current object" shape as `sources` above) — closed over once by `pmCommentPlugin.ts`'s own decorations, which need `essay.comments` fresh on every rebuild, not whatever it was the moment this `EditorView` first mounted. Left permanently `null` for a non-essay `record` (a slideshow) — there's no comment feature for those, so the plugin's own anchor lookups just never find anything to decorate. */
  commentsHolder: { current: Essay | null }
  /** A `comment_anchor` mark (margin) or an inline comment's own preview chip was clicked — see `pmCommentPlugin.ts`'s own doc comment for why this is the one place both route through. */
  onAnchorClick?: (commentId: string) => void
  /** Mod-Shift-K pressed inside the editor — `EssayWorkspace.tsx`'s own keyboard-shortcut counterpart to clicking the "Cite a source" toolbar button. */
  onCiteShortcut?: () => void
  editable?: boolean
  onViewReady?: (view: EditorView) => void
  onViewDestroyed?: () => void
  onDocChanged?: (doc: PMNode) => void
  /** How to persist `record` once its `doc`/`updatedAt` have already been updated in place — defaults to `saveEssay`, so every existing essay caller (which never passes this) keeps its exact old behavior. `SlideshowWorkspace.tsx` passes `saveSlideshow` instead. */
  onSave?: (record: PMDocHost) => void
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
  const onCiteShortcutRef = useRef(onCiteShortcut)
  onCiteShortcutRef.current = onCiteShortcut

  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!containerRef.current) return
    const doc = PMNode.fromJSON(essaySchema, record.doc)
    let saveTimer: number | undefined

    function scheduleSave(newDoc: PMNode) {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        record.doc = stripCollapsedAttrs(newDoc.toJSON())
        record.updatedAt = Date.now()
        ;(onSaveRef.current ?? ((r) => saveEssay(r as Essay)))(record)
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
          // Captured unconditionally — even outside a list, Tab's default
          // browser behavior (moving focus to the next focusable element
          // entirely out of the editor) is worse than doing nothing, so
          // the fallback below always returns true once `sinkListItem`
          // itself declines.
          Tab: (state, dispatch, view) => {
            const sink = sinkListItem(essaySchema.nodes.list_item)
            if (sink(state, dispatch, view)) return true
            return true
          },
          'Mod-Shift-k': () => {
            onCiteShortcutRef.current?.()
            return true
          },
          // New (sub)section — `splitIntoSection`'s own doc comment covers
          // both the "promote the current selection" and "nothing
          // selected: insert a new empty one at the cursor" cases; this is
          // the keyboard counterpart to the toolbar's own "Section" button
          // (`EssayWorkspace.tsx`/`SlideshowWorkspace.tsx`), shared here
          // since both editors are this same component.
          'Mod-Shift-Enter': splitIntoSection,
        }),
        createCitationArrowPlugin(),
        keymap(baseKeymap),
        createMathInputRules(),
        createListInputRules(),
        createCommentPlugin(commentsHolder, (commentId) => onAnchorClickRef.current?.(commentId)),
        createActiveSectionPlugin(),
      ],
    })

    const view = new EditorView(containerRef.current, {
      state,
      editable: () => editableRef.current,
      nodeViews: {
        citation: (node, v, getPos) => new (createCitationView(sources))(node, v, getPos as () => number | undefined),
        section: (node, v, getPos) => new SectionView(node, v, getPos as () => number | undefined),
        footnote: (node) => new FootnoteView(node),
        math_inline: (node, v, getPos) => new (createMathView(false))(node, v, getPos as () => number | undefined),
        math_block: (node, v, getPos) => new (createMathView(true))(node, v, getPos as () => number | undefined),
        slide_break: (node, v, getPos) => new SlideBreakView(node, v, getPos as () => number | undefined),
        fragment_break: (node, v, getPos) => new FragmentBreakView(node, v, getPos as () => number | undefined),
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
    // Only `record.id` — a new EditorView per record switch, never per
    // unrelated prop/state change. `editable` itself is read live off
    // `editableRef` (see above) specifically so "Comment mode" can flip it
    // without a remount; `sources`/`commentsHolder` are the same kind of
    // stable, mutated-in-place container, read fresh by the NodeViews/
    // plugin that close over them rather than re-closed-over per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id])

  return <div className="pm-editor-root" ref={containerRef} />
}
