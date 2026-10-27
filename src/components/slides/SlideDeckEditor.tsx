import { useEffect, useRef } from 'preact/hooks'
import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { splitListItem, sinkListItem } from 'prosemirror-schema-list'
import { inputRules, wrappingInputRule } from 'prosemirror-inputrules'
import { Node as PMNode } from 'prosemirror-model'
import { slideSchema } from '../../lib/slideSchema'
import { saveSlideshow } from '../../models/slideshowsRepo'
import { SlideBreakView, FragmentBreakView, SlideSectionView } from './pmSlideNodeViews'
import { createSlideCitationView } from './pmSlideCitationView'
import { insertSlideBreak, insertFragmentBreak } from './slideCommands'
import type { Slideshow, Source } from '../../models/types'

/**
 * A section's own `collapsed` attr is session-only UI state (see
 * `slideSchema.ts`'s own doc comment) — reset to `false` on the way into
 * persisted storage, same convention and same reason as
 * `PMEssayEditor.tsx`'s own identical `stripCollapsedAttrs`.
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

/**
 * The slide-deck counterpart of `PMEssayEditor.tsx` — same "mount/tear down
 * a real `EditorView` imperatively, debounced whole-doc save" shape, but
 * editing one continuous flow of prose (see `slideSchema.ts`'s own doc
 * comment) rather than a slide-per-box layout — deliberately as close to
 * the essay editor's own feel as this schema allows. No comments, commit
 * history, or footnotes/math yet; those are essay-only concerns this deck
 * schema hasn't grown (see `slideSchema.ts`'s own doc comment) — if a
 * slide deck turns out to want any of them later, they can be added the
 * same way the essay editor already has them, not by sharing a component
 * with it.
 */
export function SlideDeckEditor({
  deck,
  sources,
  onCiteShortcut,
  onViewReady,
  onViewDestroyed,
  onDocChanged,
}: {
  deck: Slideshow
  sources: Map<string, Source>
  /** Mod-Shift-K — same shortcut, same ref-indirection reason, as `PMEssayEditor.tsx`'s own `onCiteShortcut`. */
  onCiteShortcut?: () => void
  onViewReady?: (view: EditorView) => void
  onViewDestroyed?: () => void
  onDocChanged?: (doc: PMNode) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onCiteShortcutRef = useRef(onCiteShortcut)
  onCiteShortcutRef.current = onCiteShortcut

  useEffect(() => {
    if (!containerRef.current) return
    const doc = PMNode.fromJSON(slideSchema, deck.doc)
    let saveTimer: number | undefined

    function scheduleSave(newDoc: PMNode) {
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        deck.doc = stripCollapsedAttrs(newDoc.toJSON())
        saveSlideshow(deck)
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
          'Mod-b': toggleMark(slideSchema.marks.strong),
          'Mod-i': toggleMark(slideSchema.marks.em),
          'Mod-u': toggleMark(slideSchema.marks.underline),
          Enter: splitListItem(slideSchema.nodes.list_item),
          // "Slide change" / "fragmented reveal" as real keyboard commands
          // against the live document, the PM-native counterpart of the
          // slash-commands idea floated while discussing this feature —
          // real divider nodes instead of parsed text syntax.
          'Mod-Enter': (editorState, dispatch, view) => {
            if (!view) return false
            insertSlideBreak(view)
            return true
          },
          'Mod-Shift-Enter': (editorState, dispatch, view) => {
            if (!view) return false
            insertFragmentBreak(view)
            return true
          },
          Tab: (editorState, dispatch, view) => {
            if (!view) return true
            const sink = sinkListItem(slideSchema.nodes.list_item)
            if (sink(editorState, dispatch, view)) return true
            return true
          },
          'Mod-Shift-k': () => {
            onCiteShortcutRef.current?.()
            return true
          },
        }),
        keymap(baseKeymap),
        inputRules({
          rules: [
            wrappingInputRule(/^\s*([-+*])\s$/, slideSchema.nodes.bullet_list),
            wrappingInputRule(
              /^(\d+)\.\s$/,
              slideSchema.nodes.ordered_list,
              (match) => ({ order: Number(match[1]) }),
              (match, node) => node.childCount + node.attrs.order === Number(match[1]),
            ),
          ],
        }),
      ],
    })

    const view = new EditorView(containerRef.current, {
      state,
      nodeViews: {
        slide_break: (node, v, getPos) => new SlideBreakView(node, v, getPos as () => number | undefined),
        fragment_break: (node, v, getPos) => new FragmentBreakView(node, v, getPos as () => number | undefined),
        section: (node, v, getPos) => new SlideSectionView(node, v, getPos as () => number | undefined),
        citation: (node) => new (createSlideCitationView(sources))(node),
      },
      dispatchTransaction(tr) {
        const newState = view.state.apply(tr)
        view.updateState(newState)
        if (tr.docChanged) {
          onDocChanged?.(newState.doc)
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
    // Only `deck.id` — a new EditorView per deck switch, same reasoning as
    // `PMEssayEditor.tsx`'s own identical effect dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck.id])

  return <div className="pm-slide-editor-root" ref={containerRef} />
}
