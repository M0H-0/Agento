import type { ReactNode } from 'react'
import { translate } from '../chat/locale'
import type { Locale } from '../chat/locale'
import { LocaleContext } from './locale-context'

// Provider half of the locale binding (components-only file — react-refresh
// rule). App owns the locale state and renders this around the whole tree
// (plus the standalone Onboarding return).
export function LocaleProvider({
  locale,
  children
}: {
  locale: Locale
  children: ReactNode
}): React.JSX.Element {
  return (
    <LocaleContext.Provider value={{ locale, t: (key, params) => translate(locale, key, params) }}>
      {children}
    </LocaleContext.Provider>
  )
}
