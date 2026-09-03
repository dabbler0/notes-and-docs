import { useEffect, useState } from 'preact/hooks'
import { listSources, matchesSourceQuery } from '../../models/sourcesRepo'
import type { Source } from '../../models/types'
import { SourceCard } from './SourceCard'
import { AddSourceDialog } from './AddSourceDialog'
import { SourceDetailDialog } from './SourceDetailDialog'

export function SourcesView() {
  const [sources, setSources] = useState<Source[]>([])
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<Source | null>(null)

  async function reload() {
    setSources(await listSources())
  }

  useEffect(() => {
    reload()
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

      {filtered.length === 0 ? (
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
