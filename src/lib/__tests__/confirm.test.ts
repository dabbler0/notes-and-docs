import { afterEach, describe, expect, it } from 'vitest'
import { confirmDialog, subscribeConfirm } from '../confirm'

describe('confirmDialog / subscribeConfirm', () => {
  afterEach(() => {
    // Drain any request a failed assertion left pending, so one test's
    // leftover state can't bleed into the next.
    let current: unknown
    const unsub = subscribeConfirm((req) => (current = req))
    unsub()
    if (current) (current as { resolve: (v: boolean) => void }).resolve(false)
  })

  it('notifies subscribers of a new pending request, and resolves the promise once answered', async () => {
    const seen: (string | null)[] = []
    const unsub = subscribeConfirm((req) => seen.push(req?.message ?? null))
    expect(seen).toEqual([null])

    const promise = confirmDialog('Delete this?')
    expect(seen).toEqual([null, 'Delete this?'])
    unsub()

    let latest: { resolve: (v: boolean) => void } | null = null
    const unsub2 = subscribeConfirm((req) => (latest = req))
    latest!.resolve(true)
    unsub2()
    expect(await promise).toBe(true)
  })

  it('resolves false when the pending request is resolved with false', async () => {
    const promise = confirmDialog('Discard changes?')
    const unsub = subscribeConfirm((req) => req?.resolve(false))
    unsub()
    // subscribeConfirm fires immediately with the current (already-pending) request.
    expect(await promise).toBe(false)
  })

  it('passes through the options object (label, danger) unchanged', () => {
    confirmDialog('Delete?', { confirmLabel: 'Delete', danger: true })
    let seenOptions: unknown
    const unsub = subscribeConfirm((req) => {
      if (req) seenOptions = req.options
    })
    unsub()
    expect(seenOptions).toEqual({ confirmLabel: 'Delete', danger: true })
  })

  it('clears the pending request once resolved, so a later subscriber sees null', async () => {
    const promise = confirmDialog('Proceed?')
    const unsub = subscribeConfirm((req) => req?.resolve(true))
    unsub()
    await promise
    let after: unknown = 'unset'
    const unsub2 = subscribeConfirm((req) => (after = req))
    unsub2()
    expect(after).toBeNull()
  })
})
