import { useEffect, useState } from 'preact/hooks'
import { SourcesView } from './components/sources/SourcesView'
import { PdfSearchView } from './components/sources/PdfSearchView'
import { EssaysView } from './components/essays/EssaysView'
import { SyncSettingsDialog } from './components/sync/SyncSettingsDialog'
import { startAutoSyncLoop } from './sync/autoSync'

type Tab = 'essays' | 'sources' | 'search'

export function App() {
  const [tab, setTab] = useState<Tab>('essays')
  const [showSync, setShowSync] = useState(false)

  // A no-op until a Firebase project and an account are both configured —
  // see startAutoSyncLoop's own doc comment. Started once, here, rather
  // than from inside the sync dialog, so a device keeps syncing on its
  // 30s interval even while that dialog isn't open.
  useEffect(() => {
    startAutoSyncLoop()
  }, [])

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
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setShowSync(true)}>
          🔄 Sync
        </button>
      </div>
      <div className="main-area">
        {tab === 'essays' && <EssaysView />}
        {tab === 'sources' && <SourcesView />}
        {tab === 'search' && <PdfSearchView />}
      </div>
      {showSync && <SyncSettingsDialog onClose={() => setShowSync(false)} />}
    </div>
  )
}
