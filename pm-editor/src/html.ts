/** Tiny shared HTML-escaping helpers, used wherever plain text is spliced into an HTML string being built by hand. */

export function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

/** For text going inside a double-quoted HTML attribute (e.g. an href) rather than element content. */
export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
