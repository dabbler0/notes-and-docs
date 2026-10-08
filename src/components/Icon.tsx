/**
 * One small, hand-drawn icon set used everywhere a toolbar button, badge,
 * or inline marker used to rely on an emoji or a text label — cite/quote/
 * link/subsection in the editor toolbar, comment/export/backup/sync
 * wherever they appear, the search box's magnifying glass, a source's
 * PDF/text-only badge, the bookmark toggle, and so on. Deliberately plain
 * inline SVG (stroke-based, `currentColor`) rather than an icon font, a
 * CDN-hosted set, or actual emoji: this app has to keep working from a
 * downloaded `file://` HTML page with no network at all (see
 * `build:onefile`), so anything pulled in at runtime is a non-starter; an
 * emoji's own look is also entirely out of this app's hands — a different
 * font, OS, or browser renders the exact same character as a different
 * size, weight, and (for a full-color emoji) a clashing set of colors none
 * of which are this app's own palette. A `currentColor` stroke costs
 * nothing to inline, never has a loading flash, and always matches
 * whatever text color surrounds it, light or dark theme alike.
 */
export type IconName =
  | 'cite'
  | 'quote'
  | 'quote-inline'
  | 'link'
  | 'subsection'
  | 'footnote'
  | 'comment'
  | 'graveyard'
  | 'export'
  | 'import'
  | 'backup'
  | 'sync'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'list-ul'
  | 'list-ol'
  | 'clear-format'
  | 'search'
  | 'file'
  | 'text'
  | 'bookmark'
  | 'bookmark-filled'
  | 'history'
  | 'camera'
  | 'qrcode'
  | 'fullscreen'
  | 'chevron-left'
  | 'chevron-right'
  | 'trash'
  | 'word-count'

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const props = { width: size, height: size, viewBox: '0 0 24 24', className, 'aria-hidden': true }
  switch (name) {
    case 'cite':
      return (
        <svg {...props} {...STROKE}>
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'quote':
      return (
        <svg {...props} fill="currentColor" stroke="none">
          <path d="M4.6 8.4c0-1.9 1.1-3.4 3.4-4.4l.7 1.2c-1.5.8-2.1 1.7-2.1 2.7.1 0 .2 0 .3 0 1 0 1.8.8 1.8 1.9 0 1.1-.9 2-2 2-1.3 0-2.1-1-2.1-3.4z" />
          <path d="M12.6 8.4c0-1.9 1.1-3.4 3.4-4.4l.7 1.2c-1.5.8-2.1 1.7-2.1 2.7.1 0 .2 0 .3 0 1 0 1.8.8 1.8 1.9 0 1.1-.9 2-2 2-1.3 0-2.1-1-2.1-3.4z" />
        </svg>
      )
    case 'quote-inline':
      // The plain 'quote' icon (two big quotation-mark glyphs) reads as a
      // standalone block quote. This variant sits the same two glyphs, at
      // half size, on a line flanked by two short dashes — meant to read
      // as "a quote sitting in the middle of a run of text" rather than
      // "a quote set off on its own."
      return (
        <svg {...props} {...STROKE}>
          <line x1="2" y1="12" x2="8" y2="12" />
          <line x1="16" y1="12" x2="22" y2="12" />
          <g fill="currentColor" stroke="none">
            <path d="M9.3 9.5c0-1.3.8-2.3 2.3-3l.5.8c-1 .6-1.4 1.1-1.4 1.8.1 0 .1 0 .2 0 .7 0 1.2.5 1.2 1.3 0 .7-.6 1.3-1.3 1.3-.9 0-1.5-.7-1.5-2.2z" />
            <path d="M14.3 9.5c0-1.3.8-2.3 2.3-3l.5.8c-1 .6-1.4 1.1-1.4 1.8.1 0 .1 0 .2 0 .7 0 1.2.5 1.2 1.3 0 .7-.6 1.3-1.3 1.3-.9 0-1.5-.7-1.5-2.2z" />
          </g>
        </svg>
      )
    case 'link':
      return (
        <svg {...props} {...STROKE}>
          <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3" />
          <path d="M9 17H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      )
    case 'subsection':
      // A single connected "corner down, then right" arrow — the standard
      // shorthand for "this becomes a child of the thing above it." An
      // earlier version drew the arrowhead and the curve as two separate
      // strokes that didn't actually meet, leaving a visible gap that read
      // as two unrelated marks rather than one arrow.
      return (
        <svg {...props} {...STROKE}>
          <path d="M6 4v8a4 4 0 0 0 4 4h7" />
          <polyline points="13 12 17 16 13 20" />
        </svg>
      )
    case 'comment':
      return (
        <svg {...props} {...STROKE}>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      )
    case 'graveyard':
      // A grave marker (cross + ground line) — "Send to graveyard" removes
      // text from the document without discarding it outright, so this
      // needed to read as "laid to rest, not destroyed" rather than the
      // trash-can most editors use for an actual delete. An earlier
      // headstone-arch version read as a padlock at toolbar size; a plain
      // cross reads unambiguously even at 18px. Proportions tightened from
      // the first pass (a too-long top arm made it read as top-heavy) to a
      // more classic 1:2 top-arm/bottom-arm split.
      return (
        <svg {...props} {...STROKE}>
          <line x1="12" y1="4" x2="12" y2="16" />
          <line x1="8" y1="8" x2="16" y2="8" />
          <line x1="5" y1="20" x2="19" y2="20" />
        </svg>
      )
    case 'footnote':
      // A baseline (a line of text) with a small raised digit beside it —
      // the same visual shorthand word processors use for "insert a
      // footnote reference here." Pulled the two closer together from the
      // first pass, where the wide gap between them read as two unrelated
      // marks rather than "a footnote marker sitting right after some text."
      return (
        <svg {...props} {...STROKE}>
          <line x1="3" y1="15" x2="12" y2="15" />
          <text x="17" y="11" fontSize="10" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" strokeWidth="0">
            1
          </text>
        </svg>
      )
    case 'import':
      // The 'export' icon flipped vertically: an arrow into a tray instead
      // of out of one.
      return (
        <svg {...props} {...STROKE}>
          <path d="M21 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v4" />
          <polyline points="7 12 12 17 17 12" />
          <line x1="12" y1="17" x2="12" y2="5" />
        </svg>
      )
    case 'export':
      return (
        <svg {...props} {...STROKE}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      )
    case 'backup':
      return (
        <svg {...props} {...STROKE}>
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <polyline points="17 21 17 13 7 13 7 21" />
          <polyline points="7 3 7 8 15 8" />
        </svg>
      )
    case 'sync':
      return (
        <svg {...props} {...STROKE}>
          <polyline points="23 4 23 10 17 10" />
          <polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      )
    case 'bold':
      return (
        <svg {...props} {...STROKE}>
          <path d="M6 4h6a3.5 3.5 0 0 1 0 7H6z" />
          <path d="M6 11h7a3.5 3.5 0 0 1 0 7H6z" />
        </svg>
      )
    case 'italic':
      return (
        <svg {...props} {...STROKE}>
          <line x1="19" y1="4" x2="10" y2="4" />
          <line x1="14" y1="20" x2="5" y2="20" />
          <line x1="15" y1="4" x2="9" y2="20" />
        </svg>
      )
    case 'underline':
      return (
        <svg {...props} {...STROKE}>
          <path d="M6 3v7a6 6 0 0 0 12 0V3" />
          <line x1="4" y1="21" x2="20" y2="21" />
        </svg>
      )
    case 'list-ul':
      return (
        <svg {...props} {...STROKE}>
          <line x1="9" y1="6" x2="20" y2="6" />
          <line x1="9" y1="12" x2="20" y2="12" />
          <line x1="9" y1="18" x2="20" y2="18" />
          <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'clear-format':
      // A plain "T" (for "text") with a diagonal strike through it — the
      // same shorthand Google Docs/Word use for "Clear formatting," distinct
      // enough from 'bold'/'italic'/'underline' (all of which draw a glyph
      // that stays intact) that it reads as "undo/remove" rather than
      // "apply" at a glance.
      return (
        <svg {...props} {...STROKE}>
          <text x="10" y="16" fontSize="15" fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" strokeWidth="0">
            T
          </text>
          <line x1="4" y1="20" x2="20" y2="6" />
        </svg>
      )
    case 'list-ol': {
      // Real digits, not a font-rendering illusion at 16px CSS size.
      // `dominant-baseline: central` (the "correct" way to vertically
      // center SVG text) turned out unreliable to get through Preact's
      // inline-style diffing in practice — text kept anchoring to the
      // ordinary alphabetic baseline regardless, stacking every digit's
      // ascender on the row above it. Placing the text at a baseline
      // offset *below* each row's visual center (a standard trick: a
      // digit's cap sits roughly 0.35×font-size above its baseline) works
      // the same on every renderer, no special baseline property needed.
      // Rows sit at the exact same y-positions as 'list-ul's own bullets
      // (6/12/18, not the first pass's uneven 4.5/12/19.5) so the two
      // icons read as a matched pair rather than subtly misaligned twins.
      const FONT_SIZE = 7.5
      const BASELINE_OFFSET = FONT_SIZE * 0.35
      const digit = (n: number, centerY: number) => (
        <text x="4.5" y={centerY + BASELINE_OFFSET} fontSize={FONT_SIZE} fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" strokeWidth="0">
          {n}
        </text>
      )
      return (
        <svg {...props} {...STROKE}>
          <line x1="11" y1="6" x2="20" y2="6" />
          <line x1="11" y1="12" x2="20" y2="12" />
          <line x1="11" y1="18" x2="20" y2="18" />
          {digit(1, 6)}
          {digit(2, 12)}
          {digit(3, 18)}
        </svg>
      )
    }
    case 'search':
      return (
        <svg {...props} {...STROKE}>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <line x1="20" y1="20" x2="15.3" y2="15.3" />
        </svg>
      )
    case 'file':
      // Same page-with-folded-corner shape as 'backup' (minus its tray),
      // used wherever something is plainly "a file" — a source stored as a
      // PDF, a key exported to/imported from a file on disk — rather than
      // needing a format-specific glyph for each.
      return (
        <svg {...props} {...STROKE}>
          <path d="M7 2h8l5 5v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" />
          <polyline points="15 2 15 7 20 7" />
        </svg>
      )
    case 'text':
      // A page's worth of extracted plain text, not a file format — three
      // ragged text lines (the last one short, like a paragraph's end)
      // rather than 'file's page outline, so a "text only" source reads as
      // distinct from a "PDF" one at a glance, not just a relabeled file.
      return (
        <svg {...props} {...STROKE}>
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="13" y2="18" />
        </svg>
      )
    case 'bookmark':
      return (
        <svg {...props} {...STROKE}>
          <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
        </svg>
      )
    case 'bookmark-filled':
      // The exact same ribbon as 'bookmark', filled solid rather than
      // outlined — "this page already has a bookmark" vs. "add one here,"
      // the same filled/outline pairing a star rating or a favorite toggle
      // usually uses, without switching to a different shape altogether.
      return (
        <svg {...props} fill="currentColor" stroke="none">
          <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
        </svg>
      )
    case 'history':
      // A plain clock face — "Version history" is literally "look back
      // through this section's past states over time."
      return (
        <svg {...props} {...STROKE}>
          <circle cx="12" cy="12" r="9" />
          <polyline points="12 7 12 12 16 14" />
        </svg>
      )
    case 'camera':
      return (
        <svg {...props} {...STROKE}>
          <path d="M4 8h3.5l1.8-2.6a1 1 0 0 1 .8-.4h3.8a1 1 0 0 1 .8.4L16.5 8H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
          <circle cx="12" cy="13.5" r="3.5" />
        </svg>
      )
    case 'qrcode':
      // The three big corner "finder" squares every real QR code has,
      // plus a scattering of small filled modules in the remaining
      // quadrant — enough to read as "a QR code" at a glance without
      // trying to render one that would actually scan.
      return (
        <svg {...props} {...STROKE}>
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <g fill="currentColor" stroke="none">
            <rect x="14.5" y="14.5" width="2.5" height="2.5" />
            <rect x="18.5" y="14.5" width="2.5" height="2.5" />
            <rect x="14.5" y="18.5" width="2.5" height="2.5" />
            <rect x="18.5" y="18.5" width="2.5" height="2.5" />
          </g>
        </svg>
      )
    case 'fullscreen':
      // Four open corner brackets — the standard "expand to fill the
      // screen" shorthand, distinct from an X-shaped "maximize window"
      // icon (which this app's fullscreen reader mode isn't: closing it
      // returns to this same page, not another window).
      return (
        <svg {...props} {...STROKE}>
          <path d="M4 9V5a1 1 0 0 1 1-1h4" />
          <path d="M15 4h4a1 1 0 0 1 1 1v4" />
          <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
          <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
        </svg>
      )
    case 'chevron-left':
      return (
        <svg {...props} {...STROKE}>
          <polyline points="15 4 7 12 15 20" />
        </svg>
      )
    case 'chevron-right':
      return (
        <svg {...props} {...STROKE}>
          <polyline points="9 4 17 12 9 20" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...props} {...STROKE}>
          <polyline points="4 7 20 7" />
          <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          <path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
      )
    case 'word-count':
      // A plain "#" (the same shorthand most word processors' own word-count
      // tool uses) — same real-digits-not-font-illusion reasoning as
      // 'list-ol' above, rather than relying on a font to render a glyph
      // crisply at 16px CSS size.
      return (
        <svg {...props} {...STROKE}>
          <text x="12" y="17" fontSize="17" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" strokeWidth="0">
            #
          </text>
        </svg>
      )
  }
}
