import { useEffect, useRef, useState } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import 'reveal.js/dist/reveal.css'
import './slideTheme.css'
import { getSlideshow, saveSlideshow } from '../../models/slideshowsRepo'
import { listSources } from '../../models/sourcesRepo'
import { insertCitation } from './slideCommands'
import { SlideDeckEditor } from './SlideDeckEditor'
import { SlidePresenter } from './SlidePresenter'
import { CitationPickerDialog } from '../essays/CitationPickerDialog'
import { Icon } from '../Icon'
import type { EditorView } from 'prosemirror-view'
import type { Slideshow, Source } from '../../models/types'

/**
 * Prototype slideshow editing surface — the slide-deck sibling of
 * `EssayWorkspace.tsx`, trimmed to what this first pass actually needs:
 * a title bar, the editor itself, "Cite a source," and "Present." No
 * comment mode, history panel, split view, or graveyard — see
 * `SlideDeckEditor.tsx`'s own doc comment on why those are deliberately
 * out of scope here for now. Reuses `EssayWorkspace.tsx`'s own topbar/
 * layout class names (`essay-workspace-root`, `topbar essay-header`, …)
 * rather than inventing parallel ones, so a slide deck's workspace reads
 * as the same app, not a visually separate tool bolted on.
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

  function run(command: (view: EditorView) => void) {
    const view = viewRef.current
    if (!view) return
    command(view)
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
            <button className="btn btn-sm icon-btn-toolbar" title="Cite a source (Mod-Shift-K)" onMouseDown={(e) => e.preventDefault()} onClick={() => setShowCitation(true)}>
              <Icon name="cite" />
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
            run((view) => insertCitation(view, source, note))
          }}
        />
      )}

      {presenting && doc && <SlidePresenter doc={doc} sources={sources.current} onClose={() => setPresenting(false)} />}
    </div>
  )
}
