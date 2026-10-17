import { backend } from '../storage'
import { id } from '../lib/id'
import type { TodoItem } from './types'

const COLLECTION = 'todos'

/**
 * All non-deleted todos, with any item whose `deferredUntil` has already
 * passed lazily brought back to active (cleared `deferredUntil`,
 * `undeferredAt` stamped to now) and persisted right here — the same
 * mutate-and-persist-on-read pattern `essaysRepo.ts` uses for its own
 * lazy migrations, so nothing needs a background job or a page reload to
 * notice a deferral has expired.
 */
export async function listTodos(): Promise<TodoItem[]> {
  const entries = await backend.docs.list<TodoItem>(COLLECTION)
  const now = Date.now()
  const live: TodoItem[] = []
  for (const entry of entries) {
    if (entry.deleted) continue
    if (entry.deferredUntil != null && entry.deferredUntil <= now) {
      entry.deferredUntil = undefined
      entry.undeferredAt = now
      entry.updatedAt = now
      await backend.docs.put(COLLECTION, entry)
    }
    live.push(entry)
  }
  return live
}

/** Active items only, oldest-`undeferredAt`-first — the first element is "the thing to do now." */
export function activeTodos(todos: TodoItem[]): TodoItem[] {
  return todos
    .filter((t) => !t.done && t.deferredUntil == null)
    .sort((a, b) => a.undeferredAt - b.undeferredAt)
}

/** Deferred, not-yet-due items, soonest-due-first. */
export function backlogTodos(todos: TodoItem[]): TodoItem[] {
  return todos
    .filter((t) => !t.done && t.deferredUntil != null)
    .sort((a, b) => (a.deferredUntil ?? 0) - (b.deferredUntil ?? 0))
}

export async function addTodo(text: string): Promise<TodoItem> {
  const now = Date.now()
  const entry: TodoItem = { id: id(), text: text.trim(), undeferredAt: now, createdAt: now, updatedAt: now }
  await backend.docs.put(COLLECTION, entry)
  return entry
}

/** Snoozes an item until `until` — hidden from the active list, visible in the backlog, until that time passes. */
export async function deferTodo(todo: TodoItem, until: number): Promise<void> {
  todo.deferredUntil = until
  todo.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, todo)
}

/** Ends a deferral early, same as letting `deferredUntil` pass on its own — see `listTodos`. */
export async function undeferTodo(todo: TodoItem): Promise<void> {
  const now = Date.now()
  todo.deferredUntil = undefined
  todo.undeferredAt = now
  todo.updatedAt = now
  await backend.docs.put(COLLECTION, todo)
}

export async function setTodoDone(todo: TodoItem, done: boolean): Promise<void> {
  todo.done = done
  todo.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, todo)
}

/** Tombstones the entry — see the matching note on sourcesRepo.deleteSource. */
export async function deleteTodo(todoId: string): Promise<void> {
  const entry = await backend.docs.get<TodoItem>(COLLECTION, todoId)
  if (!entry) return
  entry.deleted = true
  entry.updatedAt = Date.now()
  await backend.docs.put(COLLECTION, entry)
}
