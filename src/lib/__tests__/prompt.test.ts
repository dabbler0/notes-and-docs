import { afterEach, describe, expect, it } from 'vitest'
import { promptDialog, subscribePrompt } from '../prompt'

describe('promptDialog / subscribePrompt', () => {
  afterEach(() => {
    // Drain any request a failed assertion left pending, so one test's
    // leftover state can't bleed into the next.
    let current: unknown
    const unsub = subscribePrompt((req) => (current = req))
    unsub()
    if (current) (current as { resolve: (v: string | null) => void }).resolve(null)
  })

  it('notifies subscribers of a new pending request, and resolves the promise with the entered text', async () => {
    const seen: (string | null)[] = []
    const unsub = subscribePrompt((req) => seen.push(req?.message ?? null))
    expect(seen).toEqual([null])

    const promise = promptDialog('Title?')
    expect(seen).toEqual([null, 'Title?'])
    unsub()

    let latest: { resolve: (v: string | null) => void } | null = null
    const unsub2 = subscribePrompt((req) => (latest = req))
    latest!.resolve('My Essay')
    unsub2()
    expect(await promise).toBe('My Essay')
  })

  it('resolves to null when cancelled', async () => {
    const promise = promptDialog('Title?')
    const unsub = subscribePrompt((req) => req?.resolve(null))
    unsub()
    expect(await promise).toBeNull()
  })

  it('passes through the options object (defaultValue, placeholder, labels) unchanged', () => {
    promptDialog('Title?', { defaultValue: 'Draft', placeholder: 'Untitled essay', confirmLabel: 'Create', cancelLabel: 'Never mind' })
    let seenOptions: unknown
    const unsub = subscribePrompt((req) => {
      if (req) seenOptions = req.options
    })
    unsub()
    expect(seenOptions).toEqual({ defaultValue: 'Draft', placeholder: 'Untitled essay', confirmLabel: 'Create', cancelLabel: 'Never mind' })
  })

  it('clears the pending request once resolved, so a later subscriber sees null', async () => {
    const promise = promptDialog('Title?')
    const unsub = subscribePrompt((req) => req?.resolve('Something'))
    unsub()
    await promise
    let after: unknown = 'unset'
    const unsub2 = subscribePrompt((req) => (after = req))
    unsub2()
    expect(after).toBeNull()
  })

  it('resolves to an empty string when confirmed with nothing typed, distinct from cancel', async () => {
    const promise = promptDialog('Title?')
    const unsub = subscribePrompt((req) => req?.resolve(''))
    unsub()
    const result = await promise
    expect(result).toBe('')
    expect(result).not.toBeNull()
  })
})
