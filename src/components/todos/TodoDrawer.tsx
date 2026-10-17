import { useEffect, useState } from 'preact/hooks'
import { activeTodos, addTodo, backlogTodos, deferTodo, deleteTodo, listTodos, setTodoDone, undeferTodo } from '../../models/todosRepo'
import type { TodoItem } from '../../models/types'
import { Icon } from '../Icon'

const OPEN_KEY = 'marginal.todoDrawer.open.v1'

function loadOpen(): boolean {
  try {
    const raw = localStorage.getItem(OPEN_KEY)
    if (raw != null) return JSON.parse(raw)
  } catch {
    /* corrupt value — default to open */
  }
  return true
}

function saveOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(open))
  } catch {
    /* ignore — purely a per-device convenience */
  }
}

/** `<input type="date">`'s value format — local calendar date, no time/timezone. */
function dateInputValue(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Midnight (local time) at the end of the given `<input type="date">` day — "revisit on this date" means any time that day has passed, not the exact instant it started. */
function endOfDay(dateValue: string): number {
  const [y, m, d] = dateValue.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime()
}

/**
 * A collapsible drawer under the top bar, visible alongside whichever tab
 * is active — not a tab itself, since TODOs are deliberately unrelated to
 * any one essay or source (see the feature's own request). Active items
 * are listed oldest-undeferred-first, with the first one highlighted as
 * "the thing to do now" (see `activeTodos` in `todosRepo.ts`); deferred
 * items are hidden here and shown only in the backlog panel until their
 * date passes. A 60s interval re-runs `listTodos` so a long-open tab
 * notices a deferral's expiry without needing a reload — `listTodos`
 * itself is what actually performs the undefer-on-expiry transition.
 */
export function TodoDrawer() {
  const [open, setOpen] = useState(loadOpen)
  const [showBacklog, setShowBacklog] = useState(false)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [text, setText] = useState('')
  const [deferringId, setDeferringId] = useState<string | null>(null)
  const [deferDate, setDeferDate] = useState('')

  async function refresh() {
    setTodos(await listTodos())
  }

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 60_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => saveOpen(open), [open])

  const active = activeTodos(todos)
  const backlog = backlogTodos(todos)

  async function handleAdd(e: Event) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    await addTodo(trimmed)
    setText('')
    await refresh()
  }

  async function handleDone(todo: TodoItem) {
    await setTodoDone(todo, true)
    await refresh()
  }

  async function handleDelete(todo: TodoItem) {
    await deleteTodo(todo.id)
    await refresh()
  }

  function startDefer(todo: TodoItem) {
    setDeferringId(todo.id)
    setDeferDate(dateInputValue(Date.now()))
  }

  async function confirmDefer(todo: TodoItem) {
    if (!deferDate) return
    await deferTodo(todo, endOfDay(deferDate))
    setDeferringId(null)
    await refresh()
  }

  async function handleUndefer(todo: TodoItem) {
    await undeferTodo(todo)
    await refresh()
  }

  return (
    <div className="todo-drawer">
      <button className="todo-drawer-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} TODO{active.length > 0 ? ` (${active.length})` : ''}
      </button>
      {open && (
        <div className="todo-drawer-body">
          <form className="todo-add-form" onSubmit={handleAdd}>
            <input type="text" placeholder="Add a TODO item…" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
            <button type="submit" className="btn btn-sm" disabled={!text.trim()}>
              Add
            </button>
          </form>

          <ul className="todo-list">
            {active.map((todo, i) => (
              <li key={todo.id} className={`todo-item${i === 0 ? ' todo-item-now' : ''}`}>
                <span className="todo-text">{todo.text}</span>
                <div className="todo-item-actions">
                  {deferringId === todo.id ? (
                    <>
                      <input type="date" value={deferDate} onInput={(e) => setDeferDate((e.target as HTMLInputElement).value)} />
                      <button className="btn btn-sm" onClick={() => confirmDefer(todo)}>
                        Defer
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setDeferringId(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => startDefer(todo)}>
                        Defer…
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleDone(todo)}>
                        Done
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(todo)}>
                        <Icon name="trash" />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
            {active.length === 0 && <li className="todo-empty muted">Nothing active — add one above.</li>}
          </ul>

          <button className="todo-backlog-toggle" onClick={() => setShowBacklog(!showBacklog)}>
            Backlog{backlog.length > 0 ? ` (${backlog.length})` : ''} {showBacklog ? '▾' : '▸'}
          </button>
          {showBacklog && (
            <ul className="todo-list todo-backlog">
              {backlog.map((todo) => (
                <li key={todo.id} className="todo-item">
                  <span className="todo-text">{todo.text}</span>
                  <span className="todo-defer-date muted">until {new Date(todo.deferredUntil!).toLocaleDateString()}</span>
                  <div className="todo-item-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => handleUndefer(todo)}>
                      Undefer now
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(todo)}>
                      <Icon name="trash" />
                    </button>
                  </div>
                </li>
              ))}
              {backlog.length === 0 && <li className="todo-empty muted">Nothing deferred.</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
