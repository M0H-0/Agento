import { describe, expect, it } from 'vitest'
import { fill, isLocale, plural, relativeTime, translate } from './locale'

// Locale dictionary: every key resolves in both languages, placeholders
// fill, plurals pick the right form. Pure module — node env, no DOM.
describe('locale dictionary', () => {
  it('translates a static key in both locales', () => {
    expect(translate('en', 'settings.title')).toBe('Settings')
    expect(translate('ar', 'settings.title')).toBe('الإعدادات')
  })

  it('fills {placeholders}', () => {
    expect(translate('en', 'plan.progress', { done: 2, total: 5 })).toBe('2 of 5 steps done')
    expect(translate('ar', 'plan.progress', { done: 2, total: 5 })).toBe('2 من 5 خطوات مكتملة')
    expect(fill('a {x} b')).toBe('a {x} b')
  })

  it('picks one/two/many forms, with Arabic dual', () => {
    const forms = { one: '{n} one', two: '{n} two', many: '{n} many' }
    expect(plural('en', 1, forms)).toBe('1 one')
    expect(plural('en', 2, forms)).toBe('2 many')
    expect(plural('ar', 2, forms)).toBe('2 two')
    expect(plural('ar', 5, forms)).toBe('5 many')
  })

  it('guards locale values', () => {
    expect(isLocale('ar')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fr')).toBe(false)
  })

  it('formats relative time in both locales', () => {
    const now = new Date().toISOString()
    expect(relativeTime('en', now)).toBe('just now')
    expect(relativeTime('ar', now)).toBe('الآن')
    expect(relativeTime('en', 'bogus')).toBe('')
  })
})
