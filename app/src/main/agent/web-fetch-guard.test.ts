import { describe, expect, it } from 'vitest'
import { assertPublicHttpUrl, isBlockedIp } from './web-fetch-guard'

// SSRF guard (docs/06 §6 backstop): IP literals are classified without DNS;
// DNS-dependent hostnames are covered by assertPublicHttpUrl's lookup path
// and are not exercised here (no network in unit tests).

describe('web-fetch-guard — SSRF IP blocking', () => {
  it('blocks loopback, private, link-local, and multicast IPv4', () => {
    expect(isBlockedIp('127.0.0.1')).toBe(true)
    expect(isBlockedIp('10.1.2.3')).toBe(true)
    expect(isBlockedIp('172.16.5.4')).toBe(true)
    expect(isBlockedIp('172.31.255.1')).toBe(true)
    expect(isBlockedIp('192.168.0.1')).toBe(true)
    expect(isBlockedIp('169.254.10.20')).toBe(true)
    expect(isBlockedIp('0.0.0.0')).toBe(true)
    expect(isBlockedIp('224.0.0.1')).toBe(true)
  })

  it('allows public IPv4', () => {
    expect(isBlockedIp('8.8.8.8')).toBe(false)
    expect(isBlockedIp('1.1.1.1')).toBe(false)
    expect(isBlockedIp('172.15.0.1')).toBe(false)
    expect(isBlockedIp('172.32.0.1')).toBe(false)
  })

  it('blocks IPv6 loopback, link-local, unique-local, and mapped private', () => {
    expect(isBlockedIp('::1')).toBe(true)
    expect(isBlockedIp('fe80::1')).toBe(true)
    expect(isBlockedIp('fc00::1')).toBe(true)
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedIp('::ffff:10.0.0.1')).toBe(true)
  })

  it('rejects IP-literal URLs inside the local network without DNS', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/')).rejects.toThrow(/local network/)
    await expect(assertPublicHttpUrl('http://10.0.0.5/file')).rejects.toThrow(/local network/)
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toThrow(/local network/)
  })

  it('rejects non-http(s) schemes before any network use', async () => {
    await expect(assertPublicHttpUrl('file:///C:/Windows/win.ini')).rejects.toThrow(/http/)
  })
})
