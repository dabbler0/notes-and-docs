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
import { SlideView } from './pmSlideNodeViews'
import { createSlideCitationView } from './pmSlideCitationView'
import { insertSlideAfter, findEnclosingSlide } from './slideCommands'
import type { Slideshow, Source } from '../../models/types'

/**
 * The slide-deck counterpart of `PMEssayEditor.tsx` — same "mount/tear down
 * a real `EditorView` imperatively, debounced whole-doc save" shape, scaled
 * down to what a first prototype actually needs: no comments, no commit
 * history, no footnotes/math. Those are essay-only concerns this deck
 * schema deliberately never grew (see `slideSchema.ts`'s own doc comment);
 * if slide decks turn out to want any of them later, they can be added the
 * same way the essay editor already has them, not by sharing this component
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
        deck.doc = newDoc.toJSON()
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
          'Mod-Enter': (editorState, dispatch, view) => {
            if (!view) return false
            const enclosing = findEnclosingSlide(view)
            insertSlideAfter(view, enclosing?.pos ?? null)
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
        slide: (node, v, getPos) => new SlideView(node, v, getPos as () => number | undefined),
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

  return <div className="pm-editor-root pm-slide-editor-root" ref={containerRef} />
}
