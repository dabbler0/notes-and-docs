import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import type { EditorState, Transaction } from 'prosemirror-state'
import { toggleMark } from 'prosemirror-commands'
import 'reveal.js/dist/reveal.css'
import './slideTheme.css'
import { getSlideshow, saveSlideshow } from '../../models/slideshowsRepo'
import { listSources } from '../../models/sourcesRepo'
import { essaySchema } from '../../lib/pmSchema'
import { getAuthorName } from '../../lib/authorPreference'
import { insertCitation, insertQuoteBlock, insertQuoteInline, insertSlideBreak, insertFragmentBreak, splitIntoSection } from '../essays/pmCommands'
import { PMEssayEditor } from '../essays/PMEssayEditor'
import { SlidePresenter } from './SlidePresenter'
import { CitationPickerDialog } from '../essays/CitationPickerDialog'
import { QuoteInsertDialog } from '../essays/QuoteInsertDialog'
import { Icon } from '../Icon'
import type { EditorView } from 'prosemirror-view'
import type { Essay, Slideshow, Source } from '../../models/types'

/**
 * The slideshow editing surface — literally the real essay editor
 * (`PMEssayEditor.tsx`) reused directly, per the "slideshow format is a
 * strict extension of the essay format" rewrite: a slideshow's own `doc` is
 * `essaySchema`-shaped, so the same editing surface that works for essays
 * already works for it, plus only two extra toolbar operations (insert
 * slide/fragment divider) that essay's own toolbar doesn't have. No comment
 * mode, history panel, or split view — a slideshow has no comment feature at
 * all (`commentsHolder` below is always `null`), and this first pass has no
 * history/split-view support either.
 */
export function SlideshowWorkspace({ slideshowId, onBack }: { slideshowId: string; onBack: () => void }) {
  const [deck, setDeck] = useState<Slideshow | null>(null)
  const [title, setTitle] = useState('')
  // A stable Map *instance*, never replaced — same reason and same shape as
  // `EssayWorkspace.tsx`'s own `sources` ref: the `citation` NodeView closes
  // over this object once, at mount, and only ever re-renders a chip's own
  // label when the *document* changes, not when `sources` does.
  const sources = useRef<Map<string, Source>>(new Map())
  // `PMEssayEditor` needs a holder shaped like an essay's comment source —
  // a slideshow has no comments at all, so this just always stays `null`.
  const commentsHolder = useRef<Essay | null>(null)
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

  /** For `view`-taking commands (`insertCitation`, `insertSlideBreak`, …), which already manage focus/selection themselves. */
  function runView(command: (view: EditorView) => void) {
    const view = viewRef.current
    if (!view) return
    command(view)
  }

  /** For plain PM `Command`s (`toggleMark`, `splitIntoSection`, …) — same shape as `EssayWorkspace.tsx`'s own `run`. */
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
            <button className="btn btn-sm icon-btn-toolbar" title="Bold (Mod-B)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(essaySchema.marks.strong))}>
              <Icon name="bold" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Italic (Mod-I)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(essaySchema.marks.em))}>
              <Icon name="italic" />
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Underline (Mod-U)" onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(toggleMark(essaySchema.marks.underline))}>
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
              title="Split into subsection: select some text first — it becomes that subsection's own title, with the rest of the selection as its body"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runCommand(splitIntoSection)}
            >
              <Icon name="outline" /> <span className="btn-label">Section</span>
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Slide change" onMouseDown={(e) => e.preventDefault()} onClick={() => runView((view) => insertSlideBreak(view))}>
              <Icon name="subsection" /> <span className="btn-label">Slide</span>
            </button>
            <button className="btn btn-sm icon-btn-toolbar" title="Fragmented reveal" onMouseDown={(e) => e.preventDefault()} onClick={() => runView((view) => insertFragmentBreak(view))}>
              <span className="btn-label">⋯ Fragment</span>
            </button>
          </div>

          <div className="editor-scroll doc-scroll">
            <PMEssayEditor
              key={deck.id}
              record={deck}
              sources={sources.current}
              commentsHolder={commentsHolder}
              onCiteShortcut={() => setShowCitation(true)}
              onSave={(r) => saveSlideshow(r as Slideshow)}
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
