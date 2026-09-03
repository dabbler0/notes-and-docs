import type { BibtexEntry } from '../models/types'

/**
 * Small, permissive BibTeX parser: supports `{ }` and `" "` delimited field
 * values, nested braces, and `@comment`/blank-line separated entries. Good
 * enough for pasted-in entries from Google Scholar / Zotero / etc.; not a
 * full BibTeX-grammar implementation.
 */
export function parseBibtex(src: string): BibtexEntry[] {
  const entries: BibtexEntry[] = []
  let i = 0
  const n = src.length

  const skipWs = () => {
    while (i < n && /\s/.test(src[i])) i++
  }

  while (i < n) {
    const at = src.indexOf('@', i)
    if (at === -1) break
    i = at + 1
    const typeStart = i
    while (i < n && /[a-zA-Z]/.test(src[i])) i++
    const type = src.slice(typeStart, i).toLowerCase()
    skipWs()
    if (src[i] !== '{' && src[i] !== '(') continue
    const closeChar = src[i] === '{' ? '}' : ')'
    i++
    skipWs()
    const keyStart = i
    while (i < n && src[i] !== ',' && src[i] !== closeChar) i++
    const key = src.slice(keyStart, i).trim()
    if (src[i] === ',') i++

    const fields: Record<string, string> = {}
    skipWs()
    while (i < n && src[i] !== closeChar) {
      skipWs()
      const nameStart = i
      while (i < n && /[a-zA-Z0-9_-]/.test(src[i])) i++
      const name = src.slice(nameStart, i).toLowerCase()
      skipWs()
      if (src[i] !== '=') {
        // malformed field, bail to next comma to avoid infinite loop
        while (i < n && src[i] !== ',' && src[i] !== closeChar) i++
        if (src[i] === ',') i++
        continue
      }
      i++ // '='
      skipWs()
      let value = ''
      if (src[i] === '{') {
        i++ // consume the opening brace (not part of the value)
        let depth = 1
        while (i < n && depth > 0) {
          if (src[i] === '{') {
            depth++
            value += src[i]
          } else if (src[i] === '}') {
            depth--
            if (depth > 0) value += src[i]
          } else {
            value += src[i]
          }
          i++
        }
      } else if (src[i] === '"') {
        i++
        while (i < n && src[i] !== '"') {
          value += src[i]
          i++
        }
        i++
      } else {
        const vStart = i
        while (i < n && src[i] !== ',' && src[i] !== closeChar) i++
        value = src.slice(vStart, i).trim()
      }
      if (name) fields[name] = value.replace(/\s+/g, ' ').trim()
      skipWs()
      if (src[i] === ',') {
        i++
        skipWs()
      }
    }
    i++ // closing brace/paren
    if (type && type !== 'comment' && key) {
      entries.push({ type, key, fields })
    }
  }

  return entries
}

export function formatBibtex(entry: BibtexEntry): string {
  const fieldOrder = [
    'title',
    'author',
    'year',
    'journal',
    'booktitle',
    'publisher',
    'volume',
    'number',
    'pages',
    'doi',
    'url',
    'note',
  ]
  const keys = [...fieldOrder.filter((f) => f in entry.fields), ...Object.keys(entry.fields).filter((f) => !fieldOrder.includes(f))]
  const body = keys.map((k) => `  ${k} = {${entry.fields[k]}}`).join(',\n')
  return `@${entry.type}{${entry.key},\n${body}\n}`
}

/** Short inline citation label, e.g. "(Smith, 2020)" or "(Smith & Lee, 2020)". */
export function citationLabel(entry: BibtexEntry): string {
  const authors = entry.fields.author
  const year = entry.fields.year ?? 'n.d.'
  if (!authors) return `(${entry.key}, ${year})`
  const names = authors.split(' and ').map((a) => a.split(',')[0].trim())
  if (names.length === 1) return `(${names[0]}, ${year})`
  if (names.length === 2) return `(${names[0]} & ${names[1]}, ${year})`
  return `(${names[0]} et al., ${year})`
}

export function displayTitle(entry: BibtexEntry): string {
  return entry.fields.title || entry.key
}

export function displayAuthors(entry: BibtexEntry): string {
  return entry.fields.author || ''
}

export function emptyEntry(key: string): BibtexEntry {
  return { type: 'article', key, fields: {} }
}
