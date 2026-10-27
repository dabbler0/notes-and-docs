import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import 'reveal.js/dist/reveal.css'
import './slideTheme.css'
import { getSlideshow, saveSlideshow } from '../../models/slideshowsRepo'
import { listSources } from '../../models/sourcesRepo'
import { slideSchema } from '../../lib/slideSchema'
import { getAuthorName } from '../../lib/authorPreference'
import { insertCitation, insertQuoteBlock, insertQuoteInline, insertSlideBreak, insertFragmentBreak, insertSection } from './slideCommands'
import { SlideDeckEditor } from './SlideDeckEditor'
import { SlidePresenter } from './SlidePresenter'
import { CitationPickerDialog } from '../essays/CitationPickerDialog'
import { QuoteInsertDialog } from '../essays/QuoteInsertDialog'
import { Icon } from '../Icon'
import type { EditorView } from 'prosemirror-view'
import type { Slideshow, Source } from '../../models/types'

/**
 * Prototype slideshow editing surface — the slide-deck sibling of
 * `EssayWorkspace.tsx`, trimmed to what this first pass actually needs: a
 * title bar, the editor itself, rich-text/quote/citation/slide-structure
 * toolbar buttons, and "Present." No comment mode, history panel, split
 * view, or graveyard — see `SlideDeckEditor.tsx`'s own doc comment on why
 * those are deliberately out of scope here for now. Reuses
 * `EssayWorkspace.tsx`'s own topbar/toolbar class names
 * (`essay-workspace-root`, `editor-toolbar doc-toolbar`, …) rather than
 * inventing parallel ones, so a slide deck's workspace reads as the same
 * app, not a visually separate tool bolted on.
 */
export function SlideshowWorkspace({ slideshowId, onBack }: { slideshowId: string; onBack: () => void }) {
  const [deck, setDeck] = useState<Slideshow | null>(null)
  const [title, setTitle] = useState('')
  // A stable Map *instance*, never replaced — same reason and same shape as
  // `EssayWorkspace.tsx`'s own `sources` ref: `SlideDeckEditor.tsx`'s
  // `citation` NodeView closes over this object once, at mount, and only
  // ever re-renders a chip's own label when the *document* changes, not
  // when `sources` does — so a later `setSources(new Map(...))` would
  // leave any already-mounted citation chip pointing at a stale, now-
  // disconnected Map forever. Populated *before* `setDeck` below (which is
  // what actually mounts `SlideDeckEditor`), not concurrently with it, so
  // first mount never races an empty Map either.
  const sources = useRef<Map<string, Source>>(new Map())
  const [doc, setDoc] = useState<PMNode | null>(null)
  const [showCitation, setShowCitation] = useState(false)
  const [showQuoteDialog, setShowQuoteDialog] = useState(false)
  const [presenting, setPresenting] = useState(false)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    async function load() {
      const list = await listSources()
      sources.current.clear()
      for (const s of list) sources.current.set(s.id, s)
      const d = await getSlideshow(slideshowId)
      if (!d) return
      setDeck(d)
      setTitle(d.title)
    }
    load()
  }, [slideshowId])

  async function saveTitle() {
    if (!deck) return
    deck.title = title
    await saveSlideshow(deck)
  }

  /** For this component's own `insert*(view, ...)` commands (`slideCommands.ts`), which already manage focus/selection themselves. */
  function runView(command: (view: EditorView) => void) {
    const view = viewRef.current
    if (!view) return
    command(view)
  }

  /** For plain PM `Command`s (`toggleMark`, …) — same shape as `EssayWorkspace.tsx`'s own `run`. */
  function runCommand(command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean) {
    const view = viewRef.current
    if (!view) return
    command(view.state, view.dispatch)
    view.focus()
  }

  function handleInsertQuoteBlock(source: Source, quote: string, page: number) {
    setShowQuoteDialog(false)
    sources.current.set(source.id, source)
    runView((view) => insertQuoteBlock(view, source, quote, page))
  }

  function handleInsertQuoteInline(source: Source, quote: string, page: number) {
    setShowQuoteDialog(false)
    sources.current.set(source.id, source)
    runView((view) => insertQuoteInline(view, source, quote, page))
  }

  if (!deck) return <div className="page-pad">Loading…</div>

  return (
    <div className="essay-workspace-root">
      <div className="topbar essay-header" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← <span className="btn-label">All drafts</span>
        </button>
        <input
          value={title}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          onBlur={saveTitle}
          style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, flex: 1, minWidth: 0 }}
        />
        <button className="btn btn-primary btn-sm" disabled={!doc} onClick={() => setPresenting(true)}>
          ▶ <span className="btn-label">Present</span>
        </button>
      </div>

      <div className="workspace">
        <div className="editor-panel">
          <div className="editor-toolbar doc-toolbar">
            <button className="btn btn-sm icon-btn-toolbar" title="Bold (Mod-B)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(slideSchema.marks.strong))}>
              <Icon name="bold" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Italic (Mod-I)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(slideSchema.marks.em))}>
              <Icon name="italic" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Underline (Mod-U)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(slideSchema.marks.underline))}>
              <Icon name="underline" />
            </button>
            <span className="toolbar-divider" />
            <button className="btn btn-sm icon-btn-toolbar" title="Cite a source (Mod-Shift-K)" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowCitation(true)}>
              <Icon name="cite" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Insert a quote from a source" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowQuoteDialog(true)}>
              <Icon name="quote" />
            </button>
            <span className="toolbar-divider" />
            <button
              className="btn btn-sm icon-btn-toolbar"
              title="New section: select some text first — it becomes that section's own title, with the rest of the selection as its body"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runView((view) => insertSection(view))}
            >
              <Icon name="outline" /> <span className="btn-label">Section</span>
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Slide change (Mod-Enter)" onMouseDown={(e) => e.preventDefault()} onClick={() => runView((view) => insertSlideBreak(view))}>
              <Icon name="subsection" /> <span className="btn-label">Slide</span>
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Fragmented reveal (Mod-Shift-Enter)" onMouseDown={(e) => e.preventDefault()} onClick={() => runView((view) => insertFragmentBreak(view))}>
              <span className="btn-label">⋯ Fragment</span>
            </button>
          </div>

          <div className="editor-scroll doc-scroll">
            <SlideDeckEditor
              deck={deck}
              sources={sources.current}
              onCiteShortcut={() => setShowCitation(true)}
              onViewReady={(view) => {
                viewRef.current = view
              }}
              onViewDestroyed={() => {
                viewRef.current = null
              }}
              onDocChanged={setDoc}
            />
          </div>
        </div>
      </div>

      {showCitation && (
        <CitationPickerDialog
          onClose={() => setShowCitation(false)}
          onSelect={(source, note) => {
            setShowCitation(false)
            sources.current.set(source.id, source)
            runView((view) => insertCitation(view, source, note))
          }}
        />
      )}

      {showQuoteDialog && <QuoteInsertDialog onClose={() => setShowQuoteDialog(false)} onInsertBlock={handleInsertQuoteBlock} onInsertInline={handleInsertQuoteInline} />}

      {presenting && doc && <SlidePresenter doc={doc} sources={sources.current} deckTitle={title} authorName={getAuthorName()} onClose={() => setPresenting(false)} />}
    </div>
  )
}
