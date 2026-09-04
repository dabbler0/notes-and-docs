import { useEffect, useState } from 'preact/hooks'

/**
 * Below this width, dialogs become full-screen views and side panels (the
 * outline, comments) become separate screens instead of persistent columns
 * — there isn't room for them to coexist with the document the way desktop
 * lays them out.
 */
const QUERY = '(max-width: 720px)'

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(QUERY).matches : false))
  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isMobile
}
