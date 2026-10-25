/**
 * Hand-written sample content exercising every schema node/mark at once —
 * nested sections, a footnote whose body is real document content, a
 * citation atom, a comment anchor, lists, a blockquote, and math — so the
 * prototype has something immediately worth clicking around in. This is
 * also, deliberately, the literal JSON shape a real migration script would
 * produce from one essay's old HTML (see `schema.ts`'s own doc comment) —
 * reading this file is a reasonable preview of what that script's output
 * looks like.
 */
export const sampleDocJson = {
  type: 'doc',
  content: [
    {
      type: 'section',
      attrs: { id: 'root' },
      content: [
        { type: 'section_title', content: [{ type: 'text', text: 'On the Migration of Structured Text' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'This is a ' },
            { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
            { type: 'text', text: ', ' },
            { type: 'text', text: 'italic', marks: [{ type: 'em' }] },
            { type: 'text', text: ', and ' },
            { type: 'text', text: 'underlined', marks: [{ type: 'underline' }] },
            { type: 'text', text: ' sentence, with a ' },
            { type: 'text', text: 'link to an example', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
            { type: 'text', text: '.' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Here is a claim worth citing' },
            { type: 'citation', attrs: { sourceId: 'src1', note: null } },
            { type: 'text', text: '. Here is another, with a page note' },
            { type: 'citation', attrs: { sourceId: 'src2', note: 'p. 12' } },
            { type: 'text', text: '.' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'This sentence has a footnote' },
            {
              type: 'footnote',
              content: [{ type: 'text', text: 'The footnote body is real document content now, not a side record.' }],
            },
            { type: 'text', text: ' sitting right in the flow.' },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A reviewer might leave a ' },
            { type: 'text', text: 'comment on this exact phrase', marks: [{ type: 'comment_anchor', attrs: { commentId: 'c1' } }] },
            { type: 'text', text: ' — the anchor is a mark, same as before.' },
          ],
        },
        {
          type: 'blockquote',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A quoted block of text, same as a real blockquote always was.' }] }],
        },
        {
          type: 'bullet_list',
          content: [
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First point' }] }] },
            { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Second point' }] }] },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'An inline equation ' },
            { type: 'math_inline', attrs: { latex: 'e^{i\\pi} + 1 = 0' } },
            { type: 'text', text: ' sits mid-sentence.' },
          ],
        },
        { type: 'math_block', attrs: { latex: '\\int_0^1 x^2 \\, dx = \\tfrac{1}{3}' } },
        {
          type: 'section',
          attrs: { id: 'child-a' },
          content: [
            { type: 'section_title', content: [{ type: 'text', text: 'A Nested Section' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Sections nest as real document structure now — no marker divs, no separate records.' }] },
            {
              type: 'section',
              attrs: { id: 'child-a-1' },
              content: [
                { type: 'section_title', content: [{ type: 'text', text: 'And One Level Deeper' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Nesting is unlimited, same as before, just structurally real instead of marker-simulated.' }] },
              ],
            },
          ],
        },
        {
          type: 'section',
          attrs: { id: 'child-b' },
          content: [
            { type: 'section_title', content: [{ type: 'text', text: 'A Second Top-Level Sibling' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Try the toolbar: bold/italic/underline, lists, citations, footnotes, new sections.' }] },
          ],
        },
      ],
    },
  ],
}
