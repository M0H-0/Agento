// Pure HTML wrapper for the convert_document `.pdf` path (docs/02 §2.6).
// Plain Node — no Electron imports (AGENTS.md rule 1), so both the agent tool
// (which builds the HTML) and `ipc/pdf-export.ts` (which prints it) share it.
// Wrapping + pagination CSS fixes the cut-off-lines class of bug; `dir=rtl`
// auto-detection keeps Arabic documents readable with system fonts.

const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function wrapTextAsHtml(title: string, text: string): string {
  const rtl = ARABIC_RE.test(`${title}\n${text}`)
  const paragraphs = escapeHtml(text)
    .split(/\r?\n\r?\n/)
    .map((block) => `<p>${block.replace(/\r?\n/g, '<br>')}</p>`)
    .join('\n')
  return `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><style>
@page{size:A4;margin:18mm 15mm}
body{font-family:"Segoe UI",Tahoma,Arial,sans-serif;font-size:12pt;line-height:1.7;color:#111;word-wrap:break-word;overflow-wrap:break-word}
h1{font-size:20pt;line-height:1.3;margin:0 0 16px}
p{margin:0 0 12px;white-space:pre-wrap}
</style></head><body><h1>${escapeHtml(title)}</h1>${paragraphs}</body></html>`
}
