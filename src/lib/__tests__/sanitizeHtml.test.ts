import { describe, expect, it } from 'vitest'
import { sanitizePageHtml } from '../sanitizeHtml'

describe('sanitizePageHtml', () => {
  it('passes through the plain extractor shape untouched', () => {
    expect(sanitizePageHtml('<p>Hello world.</p><p>Second paragraph.<br>With a line break.</p>')).toBe(
      '<p>Hello world.</p><p>Second paragraph.<br>With a line break.</p>',
    )
  })

  it('passes through positioned/colored spans and a data: image', () => {
    const html =
      '<div style="position:relative;width:400px;height:300px;"><img src="data:image/png;base64,aGVsbG8=" alt="" style="position:absolute;left:10px;top:20px;width:5px;height:5px;"><span style="position:absolute;left:0;top:0;color:rgb(1, 2, 3);">Hi</span></div>'
    expect(sanitizePageHtml(html)).toBe(html)
  })

  it('strips <script> tags entirely', () => {
    const out = sanitizePageHtml('<p>Before</p><script>alert(1)</script><p>After</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('Before')
    expect(out).toContain('After')
  })

  it('strips event handler attributes', () => {
    const out = sanitizePageHtml('<img src="data:image/png;base64,aGVsbG8=" onerror="alert(1)" onload="alert(2)">')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onload')
    expect(out).not.toContain('alert')
  })

  it('strips a network-loading img src (http/https/protocol-relative)', () => {
    expect(sanitizePageHtml('<img src="https://evil.example/track.png">')).not.toContain('evil.example')
    expect(sanitizePageHtml('<img src="http://evil.example/track.png">')).not.toContain('evil.example')
    expect(sanitizePageHtml('<img src="//evil.example/track.png">')).not.toContain('evil.example')
  })

  it('strips a javascript: URL', () => {
    expect(sanitizePageHtml('<img src="javascript:alert(1)">')).not.toContain('javascript')
  })

  it('keeps a data: URL image src intact', () => {
    const out = sanitizePageHtml('<img src="data:image/png;base64,aGVsbG8=" alt="">')
    expect(out).toContain('data:image/png;base64,aGVsbG8=')
  })

  it('strips disallowed tags like <iframe>, <link>, <meta>, <style>, <object>', () => {
    const out = sanitizePageHtml(
      '<p>Text</p><iframe src="https://evil.example"></iframe><link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example"><style>body{background:url(https://evil.example)}</style><object data="https://evil.example"></object>',
    )
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('link')
    expect(out).not.toContain('meta')
    expect(out).not.toContain('object')
    expect(out).not.toContain('evil.example')
    expect(out).toContain('Text')
  })

  it('strips a style attribute trying to load a background image over the network', () => {
    const out = sanitizePageHtml('<span style="background:url(https://evil.example/track.png)">Hi</span>')
    expect(out).not.toContain('evil.example')
  })

  it('keeps a style attribute whose only url() is a data: URI', () => {
    const html = '<span style="background:url(data:image/png;base64,aGVsbG8=)">Hi</span>'
    expect(sanitizePageHtml(html)).toBe(html)
  })

  it('returns an empty string for empty input', () => {
    expect(sanitizePageHtml('')).toBe('')
  })
})
