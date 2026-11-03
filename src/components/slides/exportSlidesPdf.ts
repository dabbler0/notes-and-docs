import type { Node as PMNode } from 'prosemirror-model'
import type { Source } from '../../models/types'
import { escapeHtml } from '../../lib/html'
import { serializeDeck } from './slideSerializer'
// Raw CSS/JS text, not the ordinary side-effect imports `SlideshowWorkspace.tsx`/
// `SlidePresenter.tsx` use — the print-preview window below is a whole
// separate document (`win.document.write(...)`), which has no access to
// this page's own stylesheets, scripts, or same-origin asset URLs at all
// (same reasoning `ExportDialog.tsx`'s own `exportPdf` already follows for
// essays) — so everything the print view needs gets inlined directly into
// that document's own `<style>`/`<script>` instead.
import revealCss from 'reveal.js/dist/reveal.css?inline'
import revealJsSource from 'reveal.js/dist/reveal.js?raw'
import slideThemeCss from './slideTheme.css?inline'

/** Same defensive escaping `ExportDialog.tsx`'s own `scriptSafe` uses, for the same reason: a literal `</script` substring inside reveal.js's own bundled source would otherwise end that inline `<script>` element early, before any of its own JS syntax is considered. */
function scriptSafe(s: string): string {
  return s.replace(/<\/script/gi, '<\\/script')
}

/**
 * Opens a new tab with every slide laid out as its own full page — reveal.js's
 * own built-in `view: 'print'` mode (its `PrintView` controller computes
 * real `@page` sizing and positions every slide as a sequential page,
 * rather than the live presenter's one-slide-at-a-time, `display: none`-
 * the-rest layout `SlidePresenter.tsx` uses) — then opens the browser's own
 * print dialog once that layout is actually done (the `pdf-ready` event),
 * same "render it, then let the browser's own print-to-PDF do the rest"
 * shape `ExportDialog.tsx`'s own `exportPdf` already uses for essays.
 *
 * Each slide's own body text is autosized to fill its available vertical
 * room, same algorithm (and same floor/ceiling) as the live presenter's own
 * `autosizeSlideBody.ts` — duplicated here as plain JS inside the injected
 * script rather than imported, since that script runs in the new window's
 * own separate JS context, with no access to this page's modules at all.
 * Unlike the live presenter (where only the current slide ever has real
 * layout, so autosizing has to happen lazily, once per slide, as each one
 * first becomes current), reveal.js's print view lays out every slide at
 * once, so this just runs over all of them in a single pass.
 */
export function exportSlideshowPdf(doc: PMNode, sources: Map<string, Source>, deckTitle: string, authorName: string): void {
  const slides = serializeDeck(doc, sources, deckTitle, authorName)
  const win = window.open('', '_blank')
  if (!win) {
    alert('Your browser blocked the print preview pop-up — allow pop-ups for this page and try again.')
    return
  }

  const slidesHtml = slides.map((s) => `<section>${s.html}</section>`).join('')

  const bootScript = `
    var deck = new Reveal(document.querySelector('.reveal'), {
      embedded: false,
      view: 'print',
      hash: false,
      controls: false,
      progress: false,
      slideNumber: false,
      center: false,
      width: 1280,
      height: 720,
      margin: 0,
    });
    deck.initialize();
    deck.on('pdf-ready', function () {
      var MIN_PX = 14, MAX_PX = 40;
      document.querySelectorAll('.reveal .slides section').forEach(function (section) {
        var wrap = section.querySelector('.slide-body-wrap');
        var body = section.querySelector('.slide-body');
        if (!wrap || !body) return;
        var availableHeight = wrap.clientHeight;
        if (availableHeight <= 0) return;
        body.style.fontSize = MIN_PX + 'px';
        if (body.scrollHeight > availableHeight) return;
        var lo = MIN_PX, hi = MAX_PX, best = MIN_PX;
        for (var i = 0; i < 8; i++) {
          var mid = (lo + hi) / 2;
          body.style.fontSize = mid + 'px';
          if (body.scrollHeight <= availableHeight) { best = mid; lo = mid; } else { hi = mid; }
        }
        body.style.fontSize = best + 'px';
      });
      window.print();
    });
  `

  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(deckTitle)}</title>
<style>
${revealCss}
${slideThemeCss}
html, body { margin: 0; background: #fff; }
</style>
</head>
<body>
<div class="reveal">
  <div class="slides">${slidesHtml}</div>
</div>
<script>${scriptSafe(revealJsSource)}</script>
<script>${scriptSafe(bootScript)}</script>
</body>
</html>`)
  win.document.close()
}
