// Cross-component settings-write broadcast (S6-001): any surface that writes
// settings (SettingsDialog refresh, ModelChip's own switch) notifies, and the
// composer model chip reloads live instead of going stale within-session.
// Plain module (no components) so react-refresh's only-export-components
// rule stays green in the component files that use it.
export const SETTINGS_CHANGED_EVENT = 'agento:settings-changed'

export function notifySettingsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT))
  } catch {
    // Non-DOM test harness — readers simply reload on open instead.
  }
}
