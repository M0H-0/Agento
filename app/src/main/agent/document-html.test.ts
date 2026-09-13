import { describe, expect, it } from 'vitest'
import { escapeHtml, wrapTextAsHtml } from './document-html'

describe('document-html — pdf wrapper', () => {
  it('escapes markup and wraps lines without cutting them', () => {
    const html = wrapTextAsHtml('Title <x>', 'a & b\nsecond line\n\nnew para')
    expect(html).toContain('Title &lt;x&gt;')
    expect(html).toContain('a &amp; b<br>second line')
    expect(html).toContain('white-space:pre-wrap')
    expect(html).toContain('@page')
    expect(html).toContain('dir="ltr"')
  })

  it('detects arabic and flips to rtl', () => {
    const html = wrapTextAsHtml('تقرير الأداء', 'نص عربي هنا')
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('lang="ar"')
  })

  it('escapeHtml covers all three metacharacters', () => {
    expect(escapeHtml('<a>&')).toBe('&lt;a&gt;&amp;')
  })
})
