import { afterEach, describe, expect, it } from 'vitest'
import { reconstructContent } from '../childMarkers'

/** Builds the exact DOM shape `reconstructContent` walks — see its own
 * doc comment — with one `.node-content` shard holding `shardHtml`. */
function mountShard(nodeId: string, shardHtml: string): HTMLDivElement {
  const root = document.createElement('div')
  root.setAttribute('data-node-id', nodeId)
  root.innerHTML = `<div class="section-content-row"><div class="live-pane"><div class="section-body"><div class="node-content">${shardHtml}</div></div></div></div>`
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('reconstructContent and math equation markers', () => {
  it('strips a math marker’s portal-rendered children before saving, keeping only its data attributes', () => {
    mountShard(
      'n1',
      '<span class="math-inline" data-math-id="m1" data-latex="a+b" contenteditable="false"><span class="math-rendered math-rendered-inline"><span class="katex">rendered</span></span></span>',
    )
    const html = reconstructContent('n1')
    expect(html).toBe('<span class="math-inline" data-math-id="m1" data-latex="a+b" contenteditable="false"></span>')
  })

  it('strips a block math marker’s rendered children too, leaving its surrounding content untouched', () => {
    mountShard(
      'n1',
      'Before.<div><span class="math-block" data-math-id="m1" data-latex="x^2" contenteditable="false"><span class="math-rendered math-rendered-block"><span class="katex-display">rendered</span></span></span></div>',
    )
    const html = reconstructContent('n1')
    expect(html).toBe('Before.<div><span class="math-block" data-math-id="m1" data-latex="x^2" contenteditable="false"></span></div>')
  })

  it('leaves ordinary content with no math markers untouched', () => {
    mountShard('n1', 'Just <strong>some</strong> text.')
    const html = reconstructContent('n1')
    expect(html).toBe('Just <strong>some</strong> text.')
  })

  it('strips a trailing zero-width space left by the emphasis auto-formatter', () => {
    mountShard('n1', 'Some <strong>bold</strong>​ text.')
    const html = reconstructContent('n1')
    expect(html).toBe('Some <strong>bold</strong> text.')
  })
})
