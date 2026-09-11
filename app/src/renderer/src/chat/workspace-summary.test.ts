import { describe, expect, it } from 'vitest'
import { summarizeWorkspaceFiles, workspaceTail } from './workspace-summary'

// Workspace Overview contract: the snapshot strip derives only from the
// capped list-files result — counts stay honest, folders never count as
// files, unknown extensions land in Others.
describe('summarizeWorkspaceFiles', () => {
  it('counts an empty folder as all zeros', () => {
    expect(summarizeWorkspaceFiles([])).toEqual({
      fileCount: 0,
      folderCount: 0,
      documents: 0,
      images: 0,
      spreadsheets: 0,
      others: 0
    })
  })

  it('splits files by product group and counts folders separately', () => {
    expect(
      summarizeWorkspaceFiles([
        { relativePath: 'report.pdf', isDir: false },
        { relativePath: 'notes/note.md', isDir: false },
        { relativePath: 'img/photo.jpg', isDir: false },
        { relativePath: 'data/budget.xlsx', isDir: false },
        { relativePath: 'archive.zip', isDir: false },
        { relativePath: 'notes', isDir: true }
      ])
    ).toEqual({
      fileCount: 5,
      folderCount: 1,
      documents: 2,
      images: 1,
      spreadsheets: 1,
      others: 1
    })
  })

  it('matches extensions case-insensitively and treats extensionless files as other', () => {
    expect(
      summarizeWorkspaceFiles([
        { relativePath: 'PHOTO.PNG', isDir: false },
        { relativePath: 'README', isDir: false }
      ])
    ).toMatchObject({ fileCount: 2, images: 1, others: 1 })
  })
})

describe('workspaceTail', () => {
  it('keeps short paths whole', () => {
    expect(workspaceTail('D:\\Work\\invoices')).toBe('D:\\Work\\invoices')
  })

  it('keeps the last two segments of long paths', () => {
    expect(workspaceTail('D:\\very\\long\\path\\with\\many\\segments\\Projects\\agency')).toBe(
      '…\\Projects\\agency'
    )
  })
})
