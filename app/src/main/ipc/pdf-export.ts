import { writeFileSync } from 'node:fs'
import { BrowserWindow } from 'electron'

// PDF export (docs/02 §2.6): render HTML in a hidden Electron window and print
// to PDF. This is the `.txt/.md/.html/.docx → .pdf` path for convert_document.
// Lives in `ipc/` (not `agent/`) so the agent tree stays Electron-free
// (AGENTS.md rule 1) — chat.ts injects it as `ctx.pdf.exportHtml`. The HTML
// wrapper itself is pure and shared from `agent/document-html.ts`.

/** Render `html` to `outAbsPath` (absolute, sandbox-resolved by the caller). */
export async function exportHtmlToPdf(outAbsPath: string, html: string): Promise<number> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const data = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: false })
    writeFileSync(outAbsPath, data)
    return data.length
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `That PDF could not be created — ${error.message}.`
        : 'That PDF could not be created.'
    )
  } finally {
    try {
      win.destroy()
    } catch {
      // noop — export already settled
    }
  }
}
