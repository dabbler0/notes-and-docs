import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { essaySchema } from '../../../lib/pmSchema'
import { findAllMatches, replaceAllMatches, replaceNextMatch, selectNextMatch } from '../findReplace'

function parse(json: unknown): PMNode {
  return PMNode.fromJSON(essaySchema, json)
}

function section(id: string, title: string, children: unknown[]) {
  return { type: 'section', attrs: { id }, content: [{ type: 'section_title', content: title ? [{ type: 'text', text: title }] : [] }, ...children] }
}

function paragraph(content: unknown[]) {
  return { type: 'paragraph', content }
}

function text(str: string, marks?: unknown[]) {
  return marks ? { type: 'text', text: str, marks } : { type: 'text', text: str }
}

/** A real, live-updating stand-in: unlike the single-shot `fakeView` other command tests use, `state` is reassigned on every `dispatch`, so a sequence of calls (Find Next, then Replace, then Find Next again) each see the result of the one before — needed here since this tool is meant to be driven as a sequence, not one isolated action. */
function fakeView(doc: PMNode, selectionFrom = 1): EditorView {
  let state = EditorState.create({ doc, selection: TextSelection.create(doc, selectionFrom, selectionFrom) })
  const view = {
    get state() {
      return state
    },
    dispatch(tr: Transaction) {
      state = state.apply(tr)
    },
    focus() {},
  } as unknown as EditorView
  return view
}

describe('findAllMatches', () => {
  it('finds a literal substring, Unicode-exact — a curly quote is never treated as the same character as a straight one', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('She said “hi” and “bye” too.')])])] })
    const curly = findAllMatches(doc, '“', true)
    expect(curly).toHaveLength(2)
    const straight = findAllMatches(doc, '"', true)
    expect(straight).toHaveLength(0)
  })

  it('never matches across a paragraph boundary', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [paragraph([text('end of a')]), paragraph([text('start of b')])])],
    })
    // "a" immediately followed by "s" would be a match if paragraphs were
    // concatenated with nothing between them — it must not be.
    expect(findAllMatches(doc, 'as', true)).toHaveLength(0)
  })

  it('respects caseSensitive', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('Hello hello HELLO')])])] })
    expect(findAllMatches(doc, 'hello', true)).toHaveLength(1)
    expect(findAllMatches(doc, 'hello', false)).toHaveLength(3)
  })

  it('counts a multi-character query only once per occurrence, not once per character', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('abcabc')])])] })
    expect(findAllMatches(doc, 'abc', true)).toHaveLength(2)
  })

  it('returns nothing for an empty query', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('anything')])])] })
    expect(findAllMatches(doc, '', true)).toHaveLength(0)
  })

  it('finds matches across multiple sections, each its own textblock', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [{ type: 'section', attrs: { id: 'a' }, content: [{ type: 'section_title', content: [{ type: 'text', text: 'quote “here”' }] }, paragraph([text('and “here”')])] }])],
    })
    expect(findAllMatches(doc, '“', true)).toHaveLength(2)
  })
})

describe('replaceAllMatches', () => {
  it('replaces every match and reports how many', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('“hi” and “bye”')])])] })
    const view = fakeView(doc)
    const count = replaceAllMatches(view, '“', '"', true)
    expect(count).toBe(2)
    expect(view.state.doc.textContent).toBe('"hi” and "bye”') // only “ replaced, ” left alone — a second call handles that one
  })

  it('replaces both quote characters in two calls, ending with a plain straight-quoted string', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('“hi”')])])] })
    const view = fakeView(doc)
    replaceAllMatches(view, '“', '"', true)
    replaceAllMatches(view, '”', '"', true)
    expect(view.state.doc.textContent).toBe('"hi"')
  })

  it('preserves the mark on a single-character match that sits entirely inside a marked run', () => {
    const doc = parse({
      type: 'doc',
      content: [section('root', '', [paragraph([text('before '), text('“quoted”', [{ type: 'em' }]), text(' after')])])],
    })
    const view = fakeView(doc)
    replaceAllMatches(view, '“', '"', true)
    replaceAllMatches(view, '”', '"', true)

    let marked = ''
    view.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'em')) marked += node.text
    })
    expect(marked).toBe('"quoted"')
  })

  it('is a no-op (returns 0, dispatches nothing that changes the doc) when there are no matches', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('nothing to find here')])])] })
    const view = fakeView(doc)
    const count = replaceAllMatches(view, 'xyz', 'abc', true)
    expect(count).toBe(0)
    expect(view.state.doc.textContent).toBe('nothing to find here')
  })

  it('handles a replacement shorter or longer than the query without corrupting later matches', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('aa bb aa bb aa')])])] })
    const view = fakeView(doc)
    const count = replaceAllMatches(view, 'aa', 'LONGER', true)
    expect(count).toBe(3)
    expect(view.state.doc.textContent).toBe('LONGER bb LONGER bb LONGER')
  })
})

describe('selectNextMatch / replaceNextMatch', () => {
  it('selects the first match after the cursor, wrapping around once the end is passed', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('x A x A x')])])] })
    const view = fakeView(doc, doc.content.size - 1) // cursor at the very end
    expect(selectNextMatch(view, 'A', true)).toBe(true)
    // Wrapped around to the first "A", not stuck with nothing after the last one.
    const { from, to } = view.state.selection
    expect(view.state.doc.textBetween(from, to)).toBe('A')
    expect(from).toBeLessThan(doc.content.size - 4) // the *first* A's position, not the second
  })

  it('returns false when nothing matches', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('nothing')])])] })
    const view = fakeView(doc)
    expect(selectNextMatch(view, 'zzz', true)).toBe(false)
  })

  it('replaces one match at a time, advancing to the next on each call', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph([text('A A A')])])] })
    const view = fakeView(doc, 1)
    expect(replaceNextMatch(view, 'A', 'B', true)).toBe(true)
    expect(view.state.doc.textContent).toBe('B A A')
    expect(replaceNextMatch(view, 'A', 'B', true)).toBe(true)
    expect(view.state.doc.textContent).toBe('B B A')
    expect(replaceNextMatch(view, 'A', 'B', true)).toBe(true)
    expect(view.state.doc.textContent).toBe('B B B')
    expect(replaceNextMatch(view, 'A', 'B', true)).toBe(false)
  })
})
