import { useEffect, useState } from 'preact/hooks'
import { getEssay, loadNodeMap, saveEssay } from '../../models/essaysRepo'
import type { Essay, EssayNode } from '../../models/types'
import { NodeTree } from './NodeTree'
import { NodeEditor } from './NodeEditor'

export function EssayWorkspace({ essayId, onBack }: { essayId: string; onBack: () => void }) {
  const [essay, setEssay] = useState<Essay | null>(null)
  const [nodeMap, setNodeMap] = useState<Map<string, EssayNode>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [essayTitle, setEssayTitle] = useState('')

  async function reload(keepSelection = true) {
    const e = await getEssay(essayId)
    if (!e) return
    setEssay(e)
    setEssayTitle(e.title)
    const map = await loadNodeMap(e)
    setNodeMap(new Map(map))
    if (!keepSelection || !selectedId || !map.has(selectedId)) {
      setSelectedId(e.rootNodeId)
    }
  }

  useEffect(() => {
    reload(false)
  }, [essayId])

  async function saveEssayTitle() {
    if (!essay) return
    essay.title = essayTitle || 'Untitled essay'
    await saveEssay(essay)
  }

  if (!essay) return <div className="page-pad">Loading…</div>

  const selectedNode = selectedId ? nodeMap.get(selectedId) : undefined

  return (
    <div>
      <div className="topbar" style={{ borderBottom: '1px solid var(--border)', padding: '10px 20px' }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          ← All drafts
        </button>
        <input
          value={essayTitle}
          onInput={(e) => setEssayTitle((e.target as HTMLInputElement).value)}
          onBlur={saveEssayTitle}
          style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 16, fontWeight: 700, flex: 1 }}
        />
      </div>
      <div className="workspace">
        <div className="tree-panel">
          <NodeTree nodeMap={nodeMap} rootId={essay.rootNodeId} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        {selectedNode ? (
          <NodeEditor essay={essay} node={selectedNode} nodeMap={nodeMap} onChanged={() => reload(true)} onSelectNode={setSelectedId} />
        ) : (
          <div className="editor-panel">
            <p className="empty-state">Select a section on the left.</p>
          </div>
        )}
      </div>
    </div>
  )
}
