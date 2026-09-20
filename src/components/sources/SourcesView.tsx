import { useEffect, useState } from 'preact/hooks'
import { listSources, matchesSourceQuery } from '../../models/sourcesRepo'
import { onSyncApplied } from '../../sync/syncEvents'
import type { Source } from '../../models/types'
import { SourceCard } from './SourceCard'
import { AddSourceDialog } from './AddSourceDialog'
import { SourceDetailDialog } from './SourceDetailDialog'

export function SourcesView() {
  const [sources, setSources] = useState<Source[]>([])
  // Distinct from "sources is empty" — `listSources` decompresses every
  // source's own extracted text on the way out (see `sourcesRepo.ts`'s own
  // doc comment on `StoredSource`), which for a real-sized library is real,
  // measurable work, not instant. Without this, the very first render
  // (before that first `reload()` resolves) was indistinguishable from a
  // genuinely empty library, so a library that just hadn't loaded yet
  // flashed "No sources yet" — misleading, since the two look identical.
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<Source | null>(null)

  async function reload() {
    setSources(await listSources())
    setLoading(false)
  }

  useEffect(() => {
    reload()
    // See the matching note in EssaysView — a background sync writes
    // straight into IndexedDB, so this needs its own nudge to refetch.
    return onSyncApplied(reload)
  }, [])

  const filtered = sources.filter((s) => matchesSourceQuery(s, query))

  return (
    <div className="page-pad">
      <div className="page-header">
        <h1>Sources</h1>
        <div className="search-bar">
          <span>🔎</span>
          <input placeholder="Search by title, author, year, notes…" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          + Add source
        </button>
      </div>

      {loading ? (
        <p className="muted">Loading sources…</p>
      ) : filtered.length === 0 ? (
        <p className="empty-state">{sources.length === 0 ? 'No sources yet. Add a PDF or a BibTeX entry to get started.' : 'No sources match your search.'}</p>
      ) : (
        <div className="card-grid">
          {filtered.map((s) => (
            <SourceCard key={s.id} source={s} onClick={() => setSelected(s)} />
          ))}
        </div>
      )}

      {adding && (
        <AddSourceDialog
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false)
            reload()
          }}
        />
      )}
      {selected && <SourceDetailDialog source={selected} onClose={() => setSelected(null)} onChanged={reload} />}
    </div>
  )
}
