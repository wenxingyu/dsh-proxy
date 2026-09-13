/**
 * The launch-token redirect: DSH answers the index with 401 until the browser
 * holds its per-process session cookie, and mints that cookie only through the
 * tokenized URL `dsh web` prints (a loopback address). With the host hook wired
 * in, a LAN visitor's `GET /` is redirected through the exchange for the
 * authority the BROWSER used, so the printed loopback URL is never needed.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startLanProxy, type LanProxyHandle } from '../src/proxy.ts'

const AUTH_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.'
const TOKEN = 'good-token'

let upstream: http.Server | null = null
let proxy: LanProxyHandle | null = null

afterEach(async () => {
  if (proxy !== null) await proxy.close()
  if (upstream !== null) {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream?.close(() => resolve()))
  }
  upstream = null
  proxy = null
})

/** An upstream shaped like DSH's index gate. */
async function boot(authHook: (origin: string) => string | undefined): Promise<{ port: number; port0: number }> {
  upstream = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://up')
    const token = url.searchParams.get('token')
    if (url.pathname === '/') {
      if (token === TOKEN) {
        res.writeHead(303, { location: '/', 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(AUTH_BODY)
      return
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(AUTH_BODY)
  })
  await new Promise<void>((resolve) => upstream?.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  proxy = startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort,
    username: '',
    password: '',
    authenticatedUrl: authHook,
  })
  return { port: await proxy.ready, port0: upstreamPort }
}

/** Raw GET carrying an explicit browser authority. */
function get(port: number, path: string, authority?: string): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: authority === undefined ? {} : { host: authority } },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('index launch-token redirect', () => {
  it('sends an unauthenticated index request to the token exchange for the browser authority', async () => {
    const world = await boot((origin) => `${origin}/?token=${TOKEN}`)
    const answer = await get(world.port, '/', '192.168.200.130:3081')
    expect(answer.status).toBe(302)
    expect(answer.location).toBe(`http://192.168.200.130:3081/?token=${TOKEN}`)
  })

  it('lets the redirected request complete the exchange', async () => {
    const world = await boot((origin) => `${origin}/?token=${TOKEN}`)
    const first = await get(world.port, '/', '192.168.200.130:3081')
    const target = new URL(first.location ?? '')
    const second = await get(world.port, `${target.pathname}${target.search}`, '192.168.200.130:3081')
    expect(second.status).toBe(303)
    expect(second.location).toBe('/')
  })

  it('never redirects a request that already carries a token (no loop)', async () => {
    const world = await boot((origin) => `${origin}/?token=${TOKEN}`)
    const answer = await get(world.port, '/?token=stale', '192.168.200.130:3081')
    expect(answer.status).toBe(401)
    expect(answer.body).toContain('authentication required')
  })

  it('leaves non-index 401s untouched', async () => {
    const world = await boot((origin) => `${origin}/?token=${TOKEN}`)
    const answer = await get(world.port, '/api/dsh-proxy', '192.168.200.130:3081')
    expect(answer.status).toBe(401)
    expect(answer.location).toBeUndefined()
  })

  it('passes the upstream 401 through when no host hook is wired', async () => {
    const world = await boot(() => undefined)
    const answer = await get(world.port, '/', '192.168.200.130:3081')
    expect(answer.status).toBe(401)
    expect(answer.body).toContain('authentication required')
  })

  it('survives a hook that throws', async () => {
    const world = await boot(() => {
      throw new Error('no host context')
    })
    const answer = await get(world.port, '/', '192.168.200.130:3081')
    expect(answer.status).toBe(401)
  })
})
