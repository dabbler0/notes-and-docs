import { useEffect, useRef } from 'preact/hooks'
import type { Node as PMNode } from 'prosemirror-model'
import Reveal from 'reveal.js'
import { serializeDeck } from './slideSerializer'
import { autosizeSlideBody } from './autosizeSlideBody'
import type { Source } from '../../models/types'

/**
 * Full-screen reveal.js presentation of a slide deck's current document —
 * mounted fresh every time (no incremental reveal.js `sync()` calls against
 * live edits; this prototype only ever presents a point-in-time snapshot,
 * reopened after any further editing), via the same imperative
 * mount/destroy-in-an-effect shape `PMEssayEditor.tsx` already uses for its
 * own underlying library instance.
 */
export function SlidePresenter({
  doc,
  sources,
  deckTitle,
  authorName,
  onClose,
}: {
  doc: PMNode
  sources: Map<string, Source>
  deckTitle: string
  authorName: string
  onClose: () => void
}) {
  const revealRootRef = useRef<HTMLDivElement>(null)
  const slidesRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!revealRootRef.current || !slidesRef.current) return
    const slides = serializeDeck(doc, sources, deckTitle, authorName)
    slidesRef.current.innerHTML = slides.map((s) => `<section>${s.html}</section>`).join('')

    const deck = new Reveal(revealRootRef.current, {
      // Embedded, not a full takeover of `<html>`/`<body>` — this overlay
      // div (`.slide-presenter-overlay`, `position: fixed; inset: 0`) is
      // already a full-viewport box we fully control; reveal.js's non-
      // embedded mode expects to own the real page body/viewport itself
      // (adding its own `reveal-viewport`/`reveal-full-page` classes up at
      // the `<html>` level), which fights rather than cooperates with
      // mounting it inside our own app shell.
      embedded: true,
      hash: false,
      controls: true,
      progress: true,
      center: false,
      width: 1280,
      height: 720,
      margin: 0,
      transition: 'fade',
      keyboard: true,
    })
    // Each slide's own text is autosized to fill its available vertical
    // room (`autosizeSlideBody`'s own doc comment) — but a slide only has
    // real layout while reveal.js is actually showing it (every other
    // slide sits `display: none`, reveal.css's own default), so this can't
    // run for every slide up front at mount time; it runs lazily, once per
    // slide, the moment each one first becomes current. `deck.initialize()`
    // itself doesn't fire `slidechanged` for the slide it opens on — that
    // event is only for subsequent navigation — so the very first slide is
    // sized explicitly once initialization resolves.
    deck.initialize().then(() => {
      const current = deck.getCurrentSlide()
      if (current) autosizeSlideBody(current)
    })
    deck.on('slidechanged', (event) => {
      const currentSlide = (event as unknown as { currentSlide?: Element }).currentSlide
      if (currentSlide) autosizeSlideBody(currentSlide)
    })

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      deck.destroy()
    }
    // Presents a snapshot of `doc` as it was when "Present" was clicked —
    // deliberately not re-synced against further edits while open (see this
    // component's own doc comment), so this effect intentionally only runs
    // once per mount regardless of later `doc` changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="slide-presenter-overlay">
      <button className="slide-presenter-close" onClick={onClose} title="Close presentation (Esc)">
        ✕
      </button>
      <div className="reveal" ref={revealRootRef}>
        <div className="slides" ref={slidesRef} />
      </div>
    </div>
  )
}
