// Launch/onboarding readiness (docs/03 §10): custom profiles may be keyless
// local servers (key optional), so a keyless custom provider must not trap
// the user behind the key step. Built-ins always need a key.
export function canStartChat(providerId: string, hasKey: boolean): boolean {
  if (hasKey) return true
  return providerId.startsWith('custom:')
}
