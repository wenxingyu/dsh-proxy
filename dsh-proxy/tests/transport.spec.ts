/**
 * The browser transport: one POST to `/api/dsh-proxy`, and every outcome —
 * envelope, carrier rejection, or network failure — folded into a rendered
 * result so the section never has to catch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LAN_PROXY_PATH } from '../src/contract.ts'
import { callLanProxy } from '../src/client/transport.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** Install a fetch stub and return the mock. */
function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl)
  globalThis.fetch = mock as unknown as typeof fetch
  return mock
}

describe('callLanProxy', () => {
  it('POSTs the endpoint envelope to the plugin route and returns the result', async () => {
    const mock = stubFetch(async () =>
      Response.json({ ok: true, value: { listenPort: 3081 } }),
    )
    const result = await callLanProxy('status', {})

    expect(result).toEqual({ ok: true, value: { listenPort: 3081 } })
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(LAN_PROXY_PATH)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: 'status', payload: {} })
  })

  it('defaults a missing payload to an empty object', async () => {
    const mock = stubFetch(async () => Response.json({ ok: true, value: null }))
    await callLanProxy('stop', undefined)
    const [, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: 'stop', payload: {} })
  })

  it('returns the plugin envelope even when the carrier status is not 2xx', async () => {
    stubFetch(async () =>
      Response.json({ ok: false, error: { code: 'bad-request', message: 'body is not JSON', details: {} } }, { status: 400 }),
    )
    const result = await callLanProxy('status', {})
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.message).toBe('body is not JSON')
  })

  it('renders a carrier rejection without an envelope as a transport failure', async () => {
    stubFetch(async () => new Response('nope', { status: 502, statusText: 'Bad Gateway' }))
    const result = await callLanProxy('status', {})
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe('transport')
    expect(result.ok === false && result.error.message).toBe('502 Bad Gateway')
  })

  it('renders an unreadable success body as a transport failure', async () => {
    stubFetch(async () => new Response('<html>', { status: 200 }))
    const result = await callLanProxy('status', {})
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe('transport')
  })

  it('renders a network rejection as a transport failure', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await callLanProxy('status', {})
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.message).toBe('Failed to fetch')
  })
})
