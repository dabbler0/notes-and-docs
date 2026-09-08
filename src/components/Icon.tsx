/**
 * One small, hand-drawn icon set used everywhere a toolbar button used to
 * rely on an emoji or a text label — cite/quote/link/subsection in the
 * editor toolbar, and comment/export/backup/sync wherever they appear.
 * Deliberately plain inline SVG (stroke-based, `currentColor`) rather than
 * an icon font or a CDN-hosted set: this app has to keep working from a
 * downloaded `file://` HTML page with no network at all (see
 * `build:onefile`), so anything pulled in at runtime is a non-starter —
 * this costs nothing to inline and never has a loading flash.
 */
export type IconName = 'cite' | 'quote' | 'link' | 'subsection' | 'comment' | 'export' | 'backup' | 'sync' | 'bold' | 'italic' | 'underline' | 'list-ul' | 'list-ol'

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
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
    case 'link':
      return (
        <svg {...props} {...STROKE}>
          <path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3" />
          <path d="M9 17H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      )
    case 'subsection':
      return (
        <svg {...props} {...STROKE}>
          <polyline points="10 5 15 10 10 15" />
          <path d="M3 3v6a4 4 0 0 0 4 4h8" />
        </svg>
      )
    case 'comment':
      return (
        <svg {...props} {...STROKE}>
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
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
    case 'list-ol':
      // Small filled squares instead of list-ul's circles — legible at
      // toolbar-icon size in a way actual "1 2 3" digits weren't (they
      // came out an illegible smudge that small); paired with list-ul
      // right next to it and the button's own "Numbered list" tooltip,
      // the dots-vs-squares contrast reads as bulleted-vs-ordered clearly
      // enough without needing real numerals.
      return (
        <svg {...props} {...STROKE}>
          <line x1="11" y1="6" x2="21" y2="6" />
          <line x1="11" y1="12" x2="21" y2="12" />
          <line x1="11" y1="18" x2="21" y2="18" />
          <rect x="3" y="4.5" width="3" height="3" fill="currentColor" stroke="none" />
          <rect x="3" y="10.5" width="3" height="3" fill="currentColor" stroke="none" />
          <rect x="3" y="16.5" width="3" height="3" fill="currentColor" stroke="none" />
        </svg>
      )
  }
}
