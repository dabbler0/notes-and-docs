import { beforeEach, describe, expect, it } from 'vitest'
import { activeTodos, addTodo, backlogTodos, deferTodo, deleteTodo, listTodos, setTodoDone, undeferTodo } from '../todosRepo'

interface FakeStorageModule {
  createFakeBackend(): unknown
  __setActiveBackend(b: unknown): void
}

beforeEach(async () => {
  const storageMod = (await import('../../storage')) as unknown as FakeStorageModule
  storageMod.__setActiveBackend(storageMod.createFakeBackend())
})

describe('addTodo / listTodos', () => {
  it('lists added items, excluding a deleted one', async () => {
    const a = await addTodo('first')
    await addTodo('second')
    await deleteTodo(a.id)

    const todos = await listTodos()
    expect(todos.map((t) => t.text)).toEqual(['second'])
  })

  it('trims the entered text', async () => {
    const todo = await addTodo('  padded  ')
    expect(todo.text).toBe('padded')
  })
})

describe('activeTodos / backlogTodos', () => {
  it('sorts active items oldest-undeferred-first', async () => {
    const a = await addTodo('a')
    await new Promise((r) => setTimeout(r, 2))
    const b = await addTodo('b')
    await new Promise((r) => setTimeout(r, 2))
    const c = await addTodo('c')

    // Undeferring b bumps its undeferredAt to now, so it should sort last
    // even though it was created before c.
    await undeferTodo(b)

    const todos = await listTodos()
    expect(activeTodos(todos).map((t) => t.text)).toEqual(['a', 'c', 'b'])
  })

  it('hides a deferred item from the active list and surfaces it in the backlog', async () => {
    const todo = await addTodo('snoozed')
    await deferTodo(todo, Date.now() + 100_000)

    const todos = await listTodos()
    expect(activeTodos(todos).map((t) => t.text)).toEqual([])
    expect(backlogTodos(todos).map((t) => t.text)).toEqual(['snoozed'])
  })

  it('excludes a done item from both the active list and the backlog', async () => {
    const todo = await addTodo('finished')
    await setTodoDone(todo, true)

    const todos = await listTodos()
    expect(activeTodos(todos)).toEqual([])
    expect(backlogTodos(todos)).toEqual([])
  })
})

describe('listTodos expiry', () => {
  it('automatically undefers an item whose deferredUntil has passed, refreshing undeferredAt', async () => {
    const todo = await addTodo('due')
    await deferTodo(todo, Date.now() - 1000)

    const todos = await listTodos()
    const refreshed = todos.find((t) => t.id === todo.id)!
    expect(refreshed.deferredUntil).toBeUndefined()
    expect(refreshed.undeferredAt).toBeGreaterThanOrEqual(todo.undeferredAt)
    expect(activeTodos(todos).map((t) => t.text)).toEqual(['due'])
  })

  it('persists the undefer so a second read sees it already active', async () => {
    const todo = await addTodo('due-again')
    await deferTodo(todo, Date.now() - 1000)
    await listTodos()

    const todos2 = await listTodos()
    expect(backlogTodos(todos2)).toEqual([])
    expect(activeTodos(todos2).map((t) => t.text)).toEqual(['due-again'])
  })

  it('leaves an item whose deferredUntil is still in the future alone', async () => {
    const todo = await addTodo('not yet')
    await deferTodo(todo, Date.now() + 100_000)

    const todos = await listTodos()
    const found = todos.find((t) => t.id === todo.id)!
    expect(found.deferredUntil).toBeDefined()
  })
})
