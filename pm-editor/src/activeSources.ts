import type { Source } from './types'

/**
 * The one source map the whole app currently renders against — swappable at
 * runtime (`setActiveSources`) rather than a static import, so loading a
 * real backup's own sources can take over from `fakeSourcesMap` without
 * restarting the editor. `nodeViews.ts`'s `CitationView` and `main.ts`'s
 * export panel both read through this, never `fakeSources`/`fakeSourcesMap`
 * directly, so both automatically follow whichever map is active.
 */
export let activeSources: Map<string, Source> = new Map()

export function setActiveSources(sources: Map<string, Source>): void {
  activeSources = sources
}
