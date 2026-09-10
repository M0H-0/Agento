import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

// SSRF guard for web_fetch (docs/06 §6 backstop): loopback / private /
// link-local / multicast destinations are refused after DNS resolution, and
// every redirect target is revalidated. Plain Node — unit-tested in vitest.

export function isBlockedIp(ip: string): boolean {
  const ver = isIP(ip)
  if (ver === 4) {
    const parts = ip.split('.').map(Number)
    const [a, b] = parts as [number, number]
    if (a === 127) return true
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 0) return true
    if (a >= 224) return true
    return false
  }
  if (ver === 6) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe80:')) return true
    if (lower.startsWith('fc00:') || lower.startsWith('fd00:')) return true
    if (lower.startsWith('ff00:')) return true
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/)
    if (mapped?.[1] && isBlockedIp(mapped[1])) return true
    return false
  }
  return true
}

export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('That does not look like a web address.')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('I can only open web addresses starting with http:// or https://.')
  }
  const host = parsed.hostname
  if (isIP(host)) {
    if (isBlockedIp(host)) {
      throw new Error('I will not open addresses inside your local network.')
    }
    return parsed
  }
  try {
    const addrs = await dnsLookup(host, { all: true })
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        throw new Error('I will not open addresses inside your local network.')
      }
    }
  } catch (error) {
    if (error instanceof Error && /local network/.test(error.message)) throw error
    throw new Error(
      `That page could not be fetched — ${error instanceof Error ? error.message : String(error)}.`
    )
  }
  return parsed
}
