import { InputRule, inputRules, wrappingInputRule } from 'prosemirror-inputrules'
import type { Plugin } from 'prosemirror-state'
import { essaySchema } from '../../lib/pmSchema'

/**
 * The PM-native counterpart of the old app's own `autoMathify` — typing
 * `$$` creates an inline equation, `\[` a full-line one, exactly the same
 * two triggers, checked the same way (only firing once the just-typed
 * character actually completes one of them). A real `InputRule`
 * transaction replacing the matched text with the new node does this in
 * one step, with no manual `Range`/text-node splitting the way the old
 * `contentEditable`-based version needed — `pmNodeViews.ts`'s own
 * `MathView` picks up from there, starting open for editing automatically
 * since the node it just created is still empty.
 *
 * `math_block` is a real block-level schema node (unlike the old model's
 * own `\[` marker, which was always an *inline* span mid-paragraph, just
 * styled to look block-level) — `tr.replaceWith` here goes through the
 * same step-fitting machinery `pmCommands.ts`'s own `insertQuoteBlock`
 * already relies on, which splits the surrounding paragraph around the
 * insertion point automatically whenever the replaced content needs to be
 * a block, exactly the way pressing Enter mid-paragraph does.
 */
export function createMathInputRules(): Plugin {
  return inputRules({
    rules: [
      new InputRule(/\$\$$/, (state, _match, start, end) => {
        return state.tr.replaceWith(start, end, essaySchema.nodes.math_inline.create({ latex: '' }))
      }),
      new InputRule(/\\\[$/, (state, _match, start, end) => {
        return state.tr.replaceWith(start, end, essaySchema.nodes.math_block.create({ latex: '' }))
      }),
    ],
  })
}

/**
 * The PM-native counterpart of the old app's own `autoListify` — typing
 * `- ` (or `* `/`+ `) at the start of a line wraps the current textblock
 * in a `bullet_list`, `1. ` (any starting number) wraps it in an
 * `ordered_list` starting at that number, same two triggers as before.
 * `wrappingInputRule` (from `prosemirror-inputrules`, the same package
 * `createMathInputRules` above already depends on) is the standard
 * ProseMirror recipe for exactly this — it also handles the "typing `2. `
 * right after an existing ordered-list item" case, extending that list
 * instead of starting a new nested one, via its own join-predicate
 * argument.
 */
export function createListInputRules(): Plugin {
  return inputRules({
    rules: [
      wrappingInputRule(/^\s*([-+*])\s$/, essaySchema.nodes.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        essaySchema.nodes.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + node.attrs.order === Number(match[1]),
      ),
    ],
  })
}
