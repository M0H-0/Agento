import { createContext, useContext } from 'react'
import { translate } from '../chat/locale'
import type { Locale, StringKey } from '../chat/locale'

// Shared locale binding (no components in this file — react-refresh rule).
// The locale value is owned by App (loaded from settings:get, updated by
// settings:set-locale) and pushed down via <LocaleProvider> — components
// only read via useLocale().t().
export interface LocaleApi {
  locale: Locale
  t: (key: StringKey, params?: Record<string, string | number>) => string
}

export const LocaleContext = createContext<LocaleApi>({
  locale: 'en',
  t: (key) => translate('en', key)
})

export function useLocale(): LocaleApi {
  return useContext(LocaleContext)
}
