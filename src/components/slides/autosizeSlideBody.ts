/**
 * Grows a slide's own body text to fill whatever vertical room it actually
 * has, instead of sitting at one fixed size regardless of how little (or
 * how much) content a given slide holds — "more space available → larger
 * text," the way a real presenter would size each slide by hand.
 *
 * Measures and sets `.slide-body`'s own `font-size` directly (a binary
 * search over candidate sizes, comparing `scrollHeight` against the
 * available `.slide-body-wrap`'s `clientHeight` each time) rather than
 * trying to derive it analytically — `line-height`/margins don't scale
 * perfectly linearly with font-size, so measuring the real rendered height
 * at each candidate size is the only way to land on a size that actually
 * fits, not just one that's close.
 *
 * Fragmentation-safe by construction, not by anything this function does
 * itself: reveal.js's own `.fragment` elements are hidden via `visibility:
 * hidden` (`reveal.css`), never `display: none`, so every fragment already
 * occupies its own real layout space from the moment a slide first
 * mounts — `scrollHeight` here already reflects the slide's *entire*,
 * fully-revealed content, fragments included, so the size this picks never
 * has to change (and the slide's own vertical centering, done in CSS
 * against that same already-full-height block — see `slideTheme.css`'s own
 * `.slide-body-wrap`) never has to shift as later fragments are revealed.
 *
 * Only ever needs to run once per slide, the first time it's actually
 * visible (a `display: none` slide measures a `scrollHeight` of 0, so this
 * can't run eagerly for every slide up front — see `SlidePresenter.tsx`'s
 * own `slidechanged`/initial-slide wiring) — `data-autosized` marks a slide
 * done so a later revisit doesn't needlessly re-measure it.
 */

const MIN_PX = 14
const MAX_PX = 40

export function autosizeSlideBody(slideEl: Element): void {
  const wrap = slideEl.querySelector<HTMLElement>('.slide-body-wrap')
  const body = slideEl.querySelector<HTMLElement>('.slide-body')
  if (!wrap || !body || body.dataset.autosized === 'true') return
  const availableHeight = wrap.clientHeight
  if (availableHeight <= 0) return // not actually laid out yet (shouldn't happen once visible, but cheap to guard)

  body.style.fontSize = `${MIN_PX}px`
  if (body.scrollHeight > availableHeight) {
    // Too much content to fit even at the floor size — leave it at the
    // floor (the same graceful "just overflows a little" outcome a fixed
    // font-size already had) rather than searching for a size that
    // doesn't exist.
    body.dataset.autosized = 'true'
    return
  }

  let lo = MIN_PX
  let hi = MAX_PX
  let best = MIN_PX
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2
    body.style.fontSize = `${mid}px`
    if (body.scrollHeight <= availableHeight) {
      best = mid
      lo = mid
    } else {
      hi = mid
    }
  }
  body.style.fontSize = `${best}px`
  body.dataset.autosized = 'true'
}
