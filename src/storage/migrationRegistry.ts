/**
 * Every migration this app knows about, from every domain module that
 * owns a piece of local storage — `localBackend.ts` imports only this one
 * list, rather than reaching into `models/` itself (which would invert
 * the usual dependency direction: `models/` already depends on
 * `storage/`, not the other way around). A future domain with its own
 * storage-shape history (say, an `essaysMigrations.ts`) adds its own list
 * next to `sourcesMigrations` here, the same way.
 */
import type { Migration } from './migrations'
import { sourcesMigrations } from '../models/sourcesMigrations'

export const ALL_MIGRATIONS: Migration[] = [...sourcesMigrations]
