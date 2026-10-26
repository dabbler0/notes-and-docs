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
import type { Essay } from '../../models/types'

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
export function PMEssayEditor({
  essay,
  editable = true,
  onViewReady,
  onViewDestroyed,
  onDocChanged,
}: {
  essay: Essay
  editable?: boolean
  onViewReady?: (view: EditorView) => void
  onViewDestroyed?: () => void
  onDocChanged?: (doc: PMNode) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const doc = PMNode.fromJSON(essaySchema, essay.doc)
    let saveTimer: number | undefined

    function scheduleSave(newDoc: PMNode) {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        essay.doc = newDoc.toJSON()
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
      ],
    })

    const view = new EditorView(containerRef.current, {
      state,
      editable: () => editable,
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr)
        view.updateState(newState)
        if (tr.docChanged) {
          onDocChanged?.(newState.doc)
          if (editable) scheduleSave(newState.doc)
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
    // unrelated prop/state change. `editable` is read once, at mount; a
    // caller that needs a different editable-ness for the exact same
    // essay.id (none does yet — a read-only history preview mounts a
    // fresh instance against a different, historical doc, which already
    // gets a fresh mount some other way) would need its own key to force
    // a remount, not a live toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [essay.id])

  return <div className="pm-editor-root" ref={containerRef} />
}
