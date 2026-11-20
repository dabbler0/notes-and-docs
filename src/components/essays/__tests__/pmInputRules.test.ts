import { describe, expect, it } from 'vitest'
import { Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection } from 'prosemirror-state'
import type { InputRule } from 'prosemirror-inputrules'
import type { Transaction } from 'prosemirror-state'
import { essaySchema } from '../../../lib/pmSchema'
import { listInputRules } from '../pmInputRules'

/**
 * `InputRule`'s `match`/`handler` fields are real, public fields at runtime
 * (confirmed by reading `prosemirror-inputrules`'s own source) but marked
 * `@internal` in its `.d.ts`, so TypeScript hides them from the public
 * `InputRule` type. This is the same shape with those two fields exposed,
 * used only to access them here without an `any` cast.
 */
type InspectableInputRule = InputRule & {
  match: RegExp
  handler: (state: EditorState, match: RegExpExecArray, start: number, end: number) => Transaction | null
}

function paragraph(text = '') {
  return { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }
}

function section(id: string, title: string, children: unknown[]) {
  return { type: 'section', attrs: { id }, content: [{ type: 'section_title', content: title ? [{ type: 'text', text: title }] : [] }, ...children] }
}

function parse(json: unknown): PMNode {
  return PMNode.fromJSON(essaySchema, json)
}

/** Position right after the first text node matching `text`, wherever it sits in the doc. */
function posAfterText(doc: PMNode, text: string): number {
  let found: number | null = null
  doc.descendants((node, pos) => {
    if (found !== null) return false
    if (node.isText && node.text === text) {
      found = pos + node.nodeSize
      return false
    }
    return true
  })
  if (found === null) throw new Error(`text "${text}" not found in doc`)
  return found
}

/**
 * The exact same match-then-handle recipe `prosemirror-inputrules`' own
 * plugin runs from `handleTextInput` (see that package's own `run`
 * function) — reimplemented here, over a plain `EditorState`, so a rule
 * can be exercised directly without needing a real `EditorView`/DOM to
 * drive actual keystrokes through. `typedChar` is the one character whose
 * typing would complete the shortcut (a trailing space, for both list
 * rules this file tests) — `cursorPos` must already sit right after
 * whatever text precedes it (the "- "/"1. " marker, minus that final
 * space).
 */
function tryRule(rule: InputRule, state: EditorState, cursorPos: number, typedChar: string): EditorState {
  const inspectable = rule as InspectableInputRule
  const $from = state.doc.resolve(cursorPos)
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼') + typedChar
  const match = inspectable.match.exec(textBefore)
  if (!match) throw new Error(`rule did not match "${textBefore}"`)
  const startPos = cursorPos - (match[0].length - typedChar.length)
  const tr = inspectable.handler(state, match, startPos, cursorPos)
  if (!tr) throw new Error('rule declined to handle a match')
  return state.apply(tr)
}

const [bulletRule, orderedRule] = listInputRules

describe('list input rules inside a blockquote', () => {
  it('"- " wraps the blockquote\'s own paragraph in a bullet list', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [{ type: 'blockquote', content: [paragraph('-')] }])] })
    const cursorPos = posAfterText(doc, '-') // right after the "-" inside the blockquote's paragraph
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursorPos, cursorPos) })

    const result = tryRule(bulletRule, state, cursorPos, ' ')

    const bq = result.doc.firstChild!.child(1)
    expect(bq.type.name).toBe('blockquote')
    expect(bq.firstChild!.type.name).toBe('bullet_list')
  })

  it('"1. " wraps the blockquote\'s own paragraph in an ordered list', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [{ type: 'blockquote', content: [paragraph('1.')] }])] })
    const cursorPos = posAfterText(doc, '1.')
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursorPos, cursorPos) })

    const result = tryRule(orderedRule, state, cursorPos, ' ')

    const bq = result.doc.firstChild!.child(1)
    expect(bq.type.name).toBe('blockquote')
    expect(bq.firstChild!.type.name).toBe('ordered_list')
  })

  it('still wraps a plain (non-blockquote) paragraph the same as ever', () => {
    const doc = parse({ type: 'doc', content: [section('root', '', [paragraph('-')])] })
    const cursorPos = posAfterText(doc, '-')
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, cursorPos, cursorPos) })

    const result = tryRule(bulletRule, state, cursorPos, ' ')

    expect(result.doc.firstChild!.child(1).type.name).toBe('bullet_list')
  })
})
