// Plain-language header for fenced code blocks (docs/04 §8.3: "code —
// JavaScript · copy"). Tags that name no real language (the model sometimes
// writes ```Unknown / ```text) fall back to a bare "code" instead of
// parroting "code — Unknown".
const LANGUAGE_LABELS: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  jsx: 'JSX',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  py: 'Python',
  python: 'Python',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  shell: 'Shell',
  powershell: 'PowerShell',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  xml: 'XML',
  md: 'Markdown',
  markdown: 'Markdown',
  diff: 'Diff'
}

const LANGUAGELESS = new Set(['unknown', 'text', 'txt', 'plain', 'plaintext'])

export function codeHeaderText(language: string | undefined, codeWord: string): string {
  if (!language || LANGUAGELESS.has(language.toLowerCase())) return codeWord
  const lower = language.toLowerCase()
  return `${codeWord} — ${LANGUAGE_LABELS[lower] ?? language.charAt(0).toUpperCase() + language.slice(1)}`
}
