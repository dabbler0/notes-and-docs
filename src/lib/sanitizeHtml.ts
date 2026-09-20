/**
 * The one place `Source.pageHtml` ever gets sanitized — called twice, by
 * design: once at *extract time* (`plainTextToHtml`/`extractLayoutPageHtml`
 * in `lib/textExtraction.ts`, right before a freshly-extracted page is
 * handed back to be stored) and again at *render time* (`TextViewer`,
 * right before a stored page is handed to the sandboxed iframe it renders
 * into — see that component's own doc comment for the iframe half of this
 * defense). Sanitizing only at extraction would trust every other way a
 * page's HTML can end up in local storage — synced in from another device,
 * restored from a backup, migrated from an old plain-text source — to have
 * gone through the same code path; sanitizing only at render would leave
 * whatever's actually *stored* one bug away from being dangerous. Neither
 * on its own is enough; both together mean a script or a network load
 * can't reach a real browser context even if one of the two passes has a
 * bug or gets bypassed.
 *
 * The allowlist is deliberately exactly what the two extractors ever
 * produce and nothing else: `<p>`/`<br>` structure, `<span>`/`<div>` for
 * layout mode's positioned runs, `<img>` for its recovered images, `style`
 * for position/size/color, `src`/`alt` for the image. No `<script>`, no
 * event handler attributes (`onerror`, `onload`, ...), no `<link>`/
 * `<meta>`/`<iframe>`/`<object>`/`<style>` tags — DOMPurify strips anything
 * not on the allowlist rather than trying to blocklist everything
 * dangerous.
 *
 * `ALLOWED_URI_REGEXP` is the network-load half of this for a `src`/`href`
 * -style attribute (in practice, just `img src` here): it restricts every
 * URL-bearing attribute to `data:` URIs — exactly what the layout
 * extractor's own recovered images already are — so an
 * `http(s):`/`//`-relative/`javascript:` URL there is stripped outright.
 * That regexp only ever applies to attributes DOMPurify itself already
 * treats as URI-bearing (`src`, `href`, and the like) — it does nothing for
 * a URL sitting inside a `style` attribute's own *value* (e.g.
 * `style="background:url(https://evil.example/track.png)"`), which
 * DOMPurify's default config doesn't inspect at all (confirmed directly:
 * without the hook below, that URL sails straight through untouched).
 * Since neither extractor ever legitimately needs `url()` in an inline
 * style — every property either one sets (position, size, font, color) has
 * no use for one — the `uponSanitizeAttribute` hook below drops a `style`
 * attribute outright if any `url(...)` inside it doesn't point at a
 * `data:` URI, rather than trying to surgically rewrite the CSS (easy to
 * get subtly wrong; simply refusing the whole attribute isn't).
 */
import DOMPurify, { type Config } from 'dompurify'

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: ['p', 'br', 'div', 'span', 'img'],
  ALLOWED_ATTR: ['style', 'src', 'alt'],
  ALLOWED_URI_REGEXP: /^data:/,
}

const STYLE_URL_RE = /url\s*\(\s*(['"]?)\s*([^'")]*)/gi

function styleHasNetworkUrl(value: string): boolean {
  STYLE_URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STYLE_URL_RE.exec(value))) {
    if (!/^data:/i.test(m[2].trim())) return true
  }
  return false
}

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style' && styleHasNetworkUrl(data.attrValue)) {
    data.keepAttr = false
  }
})

export function sanitizePageHtml(html: string): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, SANITIZE_CONFIG)
}
