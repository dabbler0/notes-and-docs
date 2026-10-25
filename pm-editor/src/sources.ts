/**
 * A tiny stand-in for the real app's `Source` records — just enough for
 * the `citation` NodeView to demonstrate "always re-render fresh from the
 * current source," the actual point being prototyped (see `schema.ts`'s
 * own doc comment on why `citation` carries no cached label at all). The
 * real migration wires this NodeView up to the real `sourcesRepo.ts`
 * instead.
 */
export interface FakeSource {
  id: string
  label: string
}

export const fakeSources: Record<string, FakeSource> = {
  src1: { id: 'src1', label: 'Smith (2020)' },
  src2: { id: 'src2', label: 'Doe & Lee (2019)' },
}
