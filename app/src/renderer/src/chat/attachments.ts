// Composer file references (gap 1): attached workspace files ride the
// outgoing user message as reference text — the model fetches content via
// its own read_file tool. No UIMessage/IPC contract change; relative paths
// only (the absolute root never crosses the bridge).

export function formatContextBlock(paths: string[]): string {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))].slice(0, 20)
  if (unique.length === 0) return ''
  return `\n\nContext files:\n${unique.map((p) => `- @${p}`).join('\n')}`
}

/** Append the context block to the last user text part, if any. Pure so the
 * transport stays trivially testable by inspection. */
export function withAttachments(text: string, paths: string[]): string {
  const block = formatContextBlock(paths)
  if (!block) return text
  return `${text}${block}`
}
