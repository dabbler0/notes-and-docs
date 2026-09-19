import type { PageSearchState } from '../../lib/usePageSearch'

/** The search box + "N of M" + step buttons shared by `PdfViewer` and
 * `TextViewer`, sitting above whichever page-rendering they each do. */
export function PageSearchBar({ search, placeholder }: { search: PageSearchState; placeholder: string }) {
  const { searchQuery, setSearchQuery, matches, matchIndex, jumpToMatch } = search
  return (
    <div className="pdf-search-row">
      <input
        className="pdf-search-input"
        placeholder={placeholder}
        value={searchQuery}
        onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          jumpToMatch(matchIndex + (e.shiftKey ? -1 : 1))
        }}
      />
      {searchQuery.trim() && (
        <>
          <span className="muted pdf-search-count">{matches.length === 0 ? 'No matches' : `${matchIndex + 1} of ${matches.length}`}</span>
          <button type="button" className="btn btn-sm" disabled={matches.length === 0} onClick={() => jumpToMatch(matchIndex - 1)}>
            ↑
          </button>
          <button type="button" className="btn btn-sm" disabled={matches.length === 0} onClick={() => jumpToMatch(matchIndex + 1)}>
            ↓
          </button>
        </>
      )}
    </div>
  )
}
