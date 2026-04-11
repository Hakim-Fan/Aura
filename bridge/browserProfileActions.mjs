import { clearAuraProfileAllCookies, clearAuraProfileSiteCookies } from './browserRuntime.mjs'

async function runAction(payload) {
  if (payload?.action === 'clear-site-cookies') {
    if (!payload.settings?.browser) {
      throw new Error('Missing browser settings.')
    }
    if (!payload.domain || typeof payload.domain !== 'string') {
      throw new Error('Missing import domain.')
    }

    return clearAuraProfileSiteCookies(payload.settings, payload.domain)
  }

  if (payload?.action === 'clear-all-cookies') {
    if (!payload.settings?.browser) {
      throw new Error('Missing browser settings.')
    }

    return clearAuraProfileAllCookies(payload.settings)
  }

  throw new Error(`Unsupported browser profile action: ${payload?.action || 'unknown'}`)
}

const rawPayload = process.argv[2]

if (!rawPayload) {
  process.stderr.write('Missing browser profile action payload.\n')
  process.exit(1)
}

try {
  const payload = JSON.parse(rawPayload)
  const result = await runAction(payload)
  process.stdout.write(JSON.stringify(result))
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
