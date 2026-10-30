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
import { createCitationView, SectionView, FootnoteView, CommentThreadView, createMathView, SlideBreakView, FragmentBreakView } from './pmNodeViews'
import { splitIntoSection, preventJoinIntoSectionTitle, dedupeSectionIds, pasteFlatSectionsFromHtml } from './pmCommands'
import { createCitationArrowPlugin } from './pmCitationArrowPlugin'
import { createActiveSectionPlugin } from './pmActiveSectionPlugin'
import { createSectionIdDedupePlugin } from './pmSectionIdPlugin'
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
export function stripCollapsedAttrs(node: unknown): unknown {
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
  const onCiteShortcutRef = useRef(onCiteShortcut)
  onCiteShortcutRef.current = onCiteShortcut

  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  useEffect(() => {
    if (!containerRef.current) return
    const parsedDoc = PMNode.fromJSON(essaySchema, record.doc)
    // Repairs a record whose own stored `doc` *already* has duplicate
    // section ids (see `dedupeSectionIds`'s own doc comment, pmCommands.ts,
    // for the real paste-driven corruption path and its confusing
    // symptoms) the moment it's opened — `pmSectionIdPlugin.ts`'s own
    // `appendTransaction` plugin, registered below, only ever catches a
    // *future* transaction introducing one, not whatever's already there.
    const doc = dedupeSectionIds(parsedDoc)
    let saveTimer: number | undefined

    function scheduleSave(newDoc: PMNode) {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        record.doc = stripCollapsedAttrs(newDoc.toJSON())
        record.updatedAt = Date.now()
        ;(onSaveRef.current ?? ((r) => saveEssay(r as Essay)))(record)
      }, 500)
    }
    // Persists the repair above, so a corrupted record only ever needs
    // fixing once rather than silently re-repairing itself in memory on
    // every future open.
    if (doc !== parsedDoc) scheduleSave(doc)

    const state = EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({
          'Mod-z': undo,
          'Mod-y': redo,
          'Mod-Shift-z': redo,
          // Ahead of `keymap(baseKeymap)`'s own default Backspace chain,
          // below — see `preventJoinIntoSectionTitle`'s own doc comment.
          Backspace: preventJoinIntoSectionTitle,
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
        createActiveSectionPlugin(),
        createSectionIdDedupePlugin(),
      ],
    })

    // Every currently-mounted `SectionView` in this one editor — passed to
    // each instance alike so `dispatchTransaction`, below, can renumber all
    // of them on every doc-changing transaction, not just whichever ones
    // ProseMirror's own diffing decided were inside the changed range. See
    // `SectionView.renumber`'s own doc comment for the real, confirmed-live
    // bug this fixes: numbering depends on a section's position among its
    // siblings, which a section's own `update()` can miss entirely when a
    // *different* section is inserted/removed elsewhere in the document.
    const sectionViews = new Set<SectionView>()

    const view = new EditorView(containerRef.current, {
      state,
      editable: () => editableRef.current,
      nodeViews: {
        citation: (node, v, getPos) => new (createCitationView(sources))(node, v, getPos as () => number | undefined),
        section: (node, v, getPos) => new SectionView(node, v, getPos as () => number | undefined, sectionViews),
        footnote: (node) => new FootnoteView(node),
        comment_thread: (node, v, getPos) => new CommentThreadView(node, v, getPos as () => number | undefined),
        math_inline: (node, v, getPos) => new (createMathView(false))(node, v, getPos as () => number | undefined),
        math_block: (node, v, getPos) => new (createMathView(true))(node, v, getPos as () => number | undefined),
        slide_break: (node, v, getPos) => new SlideBreakView(node, v, getPos as () => number | undefined),
        fragment_break: (node, v, getPos) => new FragmentBreakView(node, v, getPos as () => number | undefined),
      },
      handleDOMEvents: {
        // Pasting HTML whose own headings were never wrapped in a real
        // `<section>` (content copied from outside this app) needs its
        // own handling — see `pasteFlatSectionsFromHtml`'s own doc
        // comment for the ProseMirror parsing quirk its default fallback
        // hits otherwise. Deliberately `handleDOMEvents.paste` (the raw
        // DOM event, fired before ProseMirror's own default clipboard
        // handling ever touches it) rather than the higher-level
        // `handlePaste` prop — confirmed live: `handlePaste` itself
        // already runs *after* ProseMirror's own internal clipboard-read
        // pipeline has had a first pass at the pasted HTML, which hit the
        // very same crash this exists to avoid before `handlePaste`'s own
        // callback ever got a chance to run. `preventDefault()` is what
        // actually stops that default pipeline from running at all once
        // this decides to handle the paste itself.
        paste(v, event) {
          const html = (event as ClipboardEvent).clipboardData?.getData('text/html')
          if (!html) return false
          const handled = pasteFlatSectionsFromHtml(v, html)
          if (handled) event.preventDefault()
          return handled
        },
      },
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr)
        view.updateState(newState)
        if (tr.docChanged) {
          // `updateState` above has already finished reconciling every
          // mounted view's own position tracking (`getPos()`), whether or
          // not that view's own `update()` was actually invoked — safe to
          // renumber all of them now.
          sectionViews.forEach((v) => v.renumber())
          onDocChanged?.(newState.doc)
          // Always schedule a save on a real doc change, "Comment mode"
          // (editable: false) included — `editable` only ever blocks
          // DOM-level typing from reaching a transaction in the first
          // place; any doc-changing transaction that gets here while not
          // editable is already a *programmatic* one (a section's own
          // collapse toggle, or now a comment_thread's own resolve/reply/
          // delete toolbar — CommentThreadView, pmNodeViews.ts — dispatched
          // directly via `view.dispatch`, same as collapse). The old
          // `if (editableRef.current)` gate here silently dropped exactly
          // those programmatic changes while "editing off but commenting
          // still on" — harmless for a collapse toggle (stripped before
          // persisting either way, see `stripCollapsedAttrs`), but it would
          // have reintroduced an "action completes live but never
          // persists" bug for comment actions specifically, which Comment
          // mode explicitly keeps enabled.
          scheduleSave(newState.doc)
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
    // without a remount; `sources` is the same kind of stable,
    // mutated-in-place container, read fresh by the NodeViews that close
    // over it rather than re-closed-over per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id])

  return <div className="pm-editor-root" ref={containerRef} />
}
