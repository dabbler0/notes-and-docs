/**
 * Formats the date shown beneath the author line on a title page/slide —
 * either a specific date the author picked (`Essay.date`/`Slideshow.date`,
 * an `<input type="date">`'s own "YYYY-MM-DD" value), or, when none is
 * set, today's own date at render time — the "defaults to the date of the
 * render, and can be unset back to that" behavior both `ExportDialog.tsx`
 * (essays) and `SlideshowWorkspace.tsx`/`slideSerializer.ts` (slideshows)
 * want, from one shared place rather than two copies of the same
 * `toLocaleDateString` call drifting apart later.
 *
 * Parses `date` as a local calendar date by hand (splitting on `-`) rather
 * than `new Date(date)`, which parses a bare "YYYY-MM-DD" string as UTC
 * midnight — correct in UTC, but shifted a day earlier in every
 * negative-UTC-offset timezone (all of the Americas) once displayed with
 * the reader's own local `toLocaleDateString`. A date someone explicitly
 * picked should never silently show up as the day before.
 */
export function attributionDateText(date?: string): string {
  let d: Date
  if (date) {
    const [year, month, day] = date.split('-').map(Number)
    d = new Date(year, (month || 1) - 1, day || 1)
  } else {
    d = new Date()
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}
