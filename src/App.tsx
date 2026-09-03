import { useState } from 'preact/hooks'
import { SourcesView } from './components/sources/SourcesView'
import { PdfSearchView } from './components/sources/PdfSearchView'
import { EssaysView } from './components/essays/EssaysView'

type Tab = 'essays' | 'sources' | 'search'

export function App() {
  const [tab, setTab] = useState<Tab>('essays')

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">Marginal</div>
        <div className="tabs">
          <button className={`tab${tab === 'essays' ? ' active' : ''}`} onClick={() => setTab('essays')}>
            Drafts
          </button>
          <button className={`tab${tab === 'sources' ? ' active' : ''}`} onClick={() => setTab('sources')}>
            Sources
          </button>
          <button className={`tab${tab === 'search' ? ' active' : ''}`} onClick={() => setTab('search')}>
            Search PDFs
          </button>
        </div>
      </div>
      <div className="main-area">
        {tab === 'essays' && <EssaysView />}
        {tab === 'sources' && <SourcesView />}
        {tab === 'search' && <PdfSearchView />}
      </div>
    </div>
  )
}
