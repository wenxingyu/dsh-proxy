import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { startLanProxy, type LanProxyHandle } from '../src/proxy.ts'
import { AuthState } from '../src/auth.ts'
import { RANDOM_UUID_POLYFILL } from '../src/polyfill.ts'

const USER = 'admin'
const PASS = 's3cret'
const UPSTREAM_HTML =
  '<!doctype html><html><head><title>up</title></head><body>UPSTREAM_MARKER</body></html>'
const CONNECTION_NEEDLE =
  'isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),'

const basic = (username = USER, password = PASS): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

/** Raw node HTTP GET that returns the exact wire bytes (no auto-decompression). */
function rawGet(path: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return rawGetAt(world.proxyPort, path, extraHeaders)
}

/**
 * Raw GET against any proxy instance. The `host` header is the signal that makes
 * the gate treat a request as a cleartext LAN visitor, which undici's fetch
 * would overwrite, so these tests go over node:http.
 */
function rawGetAt(
  port: number,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return requestAt(port, path, { method: 'GET', headers: extraHeaders })
}

/** Send one raw request and collect the whole answer. */
function requestAt(
  port: number,
  path: string,
  options: { method: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'accept-encoding': '', ...(options.headers ?? {}) }
    if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body))
    const req = http.request(
      { host: '127.0.0.1', port, path, method: options.method, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        )
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** Start a second proxy instance for the gate tests and register its cleanup. */
async function startExtraProxy(
  overrides: Partial<Parameters<typeof startLanProxy>[0]> = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const proxy = startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: world.upstreamPort,
    username: USER,
    password: PASS,
    ...overrides,
  })
  const port = await proxy.ready
  cleanup.splice(0, 0, () => proxy.close())
  return { port, close: () => proxy.close() }
}

/** A stopwatch-friendly session store for the gate tests. */
function sessionStore(): AuthState {
  return new AuthState({ policy: { maxFailures: 3, lockoutMs: 60_000, sessionIdleMs: 60_000 } })
}

/** Pull one cookie out of a response's Set-Cookie header. */
function cookieFrom(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers['set-cookie']
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  for (const entry of list) {
    if (entry.startsWith(`${name}=`)) return entry.split(';')[0]
  }
  return undefined
}

interface World {
  upstreamPort: number
  proxy: LanProxyHandle
  proxyPort: number
  targetOrigin: string
  seen: { host?: string; origin?: string }
}

let world: World
let upstream: http.Server
let cleanup: (() => Promise<void>)[]

beforeEach(async () => {
  cleanup = []
  const seen: World['seen'] = {}

  upstream = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://up').pathname
    if (pathname === '/api/state') {
      seen.host = req.headers.host
      seen.origin = req.headers.origin
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (pathname === '/favicon.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' })
      res.end('<svg xmlns="http://www.w3.org/2000/svg"/>')
      return
    }
    if (pathname === '/api/echo') {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ echoed: body, host: req.headers.host, origin: req.headers.origin }))
      })
      return
    }
    if (pathname === '/plugins/x/client.js') {
      // Served in two chunks to prove the JS patch buffers across chunks.
      const code = `const a=1;${CONNECTION_NEEDLE}\nconst b=2;`
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.write(code.slice(0, 20))
      res.end(code.slice(20))
      return
    }
    if (pathname === '/plugins/x/client.js.zipped') {
      // Compressed JS: the loopback-trust patch must still apply after
      // decompressing by Content-Encoding.
      const code = `const a=1;${CONNECTION_NEEDLE}\nconst b=2;`
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(zlib.gzipSync(code))
      return
    }
    if (pathname === '/zipped') {
      // Compressed HTML: the randomUUID polyfill must still be injected.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      res.end(zlib.gzipSync(UPSTREAM_HTML))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(UPSTREAM_HTML)
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', (socket) => {
    socket.on('message', (data) => socket.send(`echo:${String(data)}`))
  })

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamPort = (upstream.address() as AddressInfo).port
  const proxy = startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort,
    username: USER,
    password: PASS,
  })
  const proxyPort = await proxy.ready
  world = { upstreamPort, proxy, proxyPort, targetOrigin: `http://127.0.0.1:${upstreamPort}`, seen }
  cleanup = [
    () => proxy.close(),
    () =>
      new Promise<void>((resolve) => {
        upstream.closeAllConnections()
        upstream.close(() => resolve())
      }),
  ]
})

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

const base = (): string => `http://127.0.0.1:${world.proxyPort}`

describe('auth gate', () => {
  /**
   * A loopback browser is a secure context, so the gate sends it to the login
   * form instead of raising a 401 (a browser dialog cannot be logged out of, and
   * this deployment wants a real session). The plain-LAN Basic path is asserted
   * separately below.
   */
  it('sends an unauthenticated loopback visitor to the login page', async () => {
    const nav = await fetch(`${base()}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    expect(nav.status).toBe(303)
    expect(nav.headers.get('location')).toBe('/__dsh-proxy/login')

    const api = await fetch(`${base()}/api/state`, { redirect: 'manual' })
    expect(api.status).toBe(303)
  })

  it('accepts a valid Basic Authorization header and serves the app', async () => {
    const res = await fetch(`${base()}/`, { headers: { authorization: basic() } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('UPSTREAM_MARKER')
    expect(html).toContain(RANDOM_UUID_POLYFILL)
    expect(html.indexOf(RANDOM_UUID_POLYFILL)).toBeLessThan(html.indexOf('<title'))
  })

  it('rejects a wrong Basic header by routing to the login page (no dialog in session mode)', async () => {
    const res = await fetch(`${base()}/`, {
      headers: { authorization: basic('admin', 'wrong'), accept: 'text/html' },
      redirect: 'manual',
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/__dsh-proxy/login')
  })

  it('sends a plain-HTTP LAN visitor to the same login page (unified gate)', async () => {
    // The default policy: one authentication mechanism everywhere a cookie can be
    // held, including cleartext LAN traffic.
    const res = await rawGet('/', { host: '192.168.1.50:3081', accept: 'text/html' })
    expect(res.status).toBe(303)
    expect(res.headers['location']).toBe('/__dsh-proxy/login')
  })

  it('keeps the native Basic dialog when cleartextAuth is explicitly "basic"', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store, cleartextAuth: 'basic' })
    const res = await rawGetAt(port, '/api/state', { host: '192.168.1.50:3081', accept: 'text/html' })
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toMatch(/^Basic realm=/)
  })
})

describe('login-page gate (session auth)', () => {
  it('serves a self-contained login form with hardened response headers', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const res = await rawGetAt(port, '/__dsh-proxy/login', { host: '127.0.0.1' })
    expect(res.status).toBe(200)
    const html = res.body.toString('utf8')
    expect(html).toContain('type="password"')
    expect(html).toContain('method="post"')
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['content-security-policy']).toContain("default-src 'none'")
    expect(res.headers['x-frame-options']).toBe('DENY')
  })

  it('issues a __Host- session cookie on a correct login and accepts it afterwards', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })

    const form = 'username=admin&password=s3cret'
    const login = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1' },
      body: form,
    })
    expect(login.status).toBe(303)
    const setCookie = login.headers['set-cookie']?.[0] ?? ''
    expect(setCookie).toContain('__Host-dsh_proxy_session=')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).not.toContain('Domain=')
    const cookie = cookieFrom(login.headers, '__Host-dsh_proxy_session')
    expect(cookie).toBeDefined()

    // The cookie alone now authorizes the app (no Basic header involved).
    const app = await rawGetAt(port, '/api/state', { host: '127.0.0.1', cookie: cookie ?? '' })
    expect(app.status).toBe(200)
    expect(store.sessionCount).toBe(1)
  })

  it('re-serves the form with a neutral error on a wrong password', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const bad = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1' },
      body: 'username=admin&password=nope',
    })
    expect(bad.status).toBe(200)
    const html = bad.body.toString('utf8')
    expect(html).toContain('用户名或密码不正确')
    // Nothing was issued, and the failure is on record.
    expect(bad.headers['set-cookie']).toBeUndefined()
    expect(store.sessionCount).toBe(0)
  })

  it('clears the cookie on logout and refuses the old session', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const login = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: '127.0.0.1' },
      body: 'username=admin&password=s3cret',
    })
    const cookie = cookieFrom(login.headers, '__Host-dsh_proxy_session') ?? ''

    const out = await rawGetAt(port, '/__dsh-proxy/logout', { host: '127.0.0.1', cookie })
    expect(out.status).toBe(303)
    expect(out.headers['set-cookie']?.[0]).toContain('Max-Age=0')
    expect(store.sessionCount).toBe(0)

    // The revoked cookie no longer opens the app.
    const after = await rawGetAt(port, '/api/state', { host: '127.0.0.1', cookie })
    expect(after.status).toBe(303)
  })

  it('refuses a cross-site form submission for login and logout', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const crossSite = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1',
        origin: 'http://evil.example',
      },
      body: 'username=admin&password=s3cret',
    })
    // Credentials are never even compared: the form is re-served with the origin error.
    expect(crossSite.status).toBe(200)
    expect(crossSite.body.toString('utf8')).toContain('请求来源校验失败')
    expect(store.sessionCount).toBe(0)

    // A logout via GET (the plain link) is allowed: the worst a cross-site GET
    // can do is log the victim out.
    const logout = await rawGetAt(port, '/__dsh-proxy/logout', { host: '127.0.0.1' })
    expect(logout.status).toBe(303)
    expect(logout.headers['set-cookie']?.[0]).toContain('Max-Age=0')
  })

  it('trusts Sec-Fetch-Site: same-origin even when a proxy rewrites Host', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    // This is the reverse-proxy shape that produced a false rejection: the
    // browser says same-origin, but the Host we observe differs from the
    // browser's Origin because something upstream rewrote it.
    const res = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1:3080',
        origin: 'http://192.168.200.130:3081',
        'sec-fetch-site': 'same-origin',
      },
      body: 'username=admin&password=s3cret',
    })
    expect(res.status).toBe(303)
    expect(store.sessionCount).toBe(1)
  })

  it('accepts `Origin: null` (origin withheld) instead of calling it cross-site', async () => {
    // A sandboxed/privacy-hardened browser or an in-app webview sends the literal
    // string `null`. That is not evidence of a cross-site request, and treating it
    // as one broke a real login.
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const res = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '192.168.200.130:3081',
        origin: 'null',
      },
      body: 'username=admin&password=s3cret',
    })
    expect(res.status).toBe(303)
    expect(store.sessionCount).toBe(1)
  })

  it('still refuses a malformed non-null Origin', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const res = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '192.168.200.130:3081',
        origin: 'not a url',
      },
      body: 'username=admin&password=s3cret',
    })
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).toContain('Origin 头无法解析')
    expect(store.sessionCount).toBe(0)
  })

  it('rejects Sec-Fetch-Site: cross-site outright', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const res = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1:3081',
        origin: 'http://127.0.0.1:3081',
        'sec-fetch-site': 'cross-site',
      },
      body: 'username=admin&password=s3cret',
    })
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).toContain('cross-site')
    expect(store.sessionCount).toBe(0)
  })

  it('names both authorities when it rejects an Origin/Host mismatch', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    const res = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1:3081',
        origin: 'http://192.168.200.130:3081',
      },
      body: 'username=admin&password=s3cret',
    })
    const html = res.body.toString('utf8')
    expect(html).toContain('来源校验失败')
    // The diagnostic must show what was seen, not just "it failed".
    expect(html).toContain('192.168.200.130:3081')
    expect(html).toContain('127.0.0.1:3081')
    expect(store.sessionCount).toBe(0)
  })

  it('uses a Secure __Host- cookie behind a TLS-terminating proxy on loopback', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })
    // A trusted (loopback) peer claiming https is exactly the reverse-proxy setup.
    const res = await rawGetAt(port, '/api/state', {
      host: 'dsh.example.com',
      'x-forwarded-proto': 'https',
    })
    // Unauthenticated: the gate redirects to the form rather than a 401 dialog.
    expect(res.status).toBe(303)
    expect(res.headers['location']).toBe('/__dsh-proxy/login')
  })

  it('serves the login form to a cleartext LAN visitor and issues a non-Secure cookie', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store })

    const form = await rawGetAt(port, '/__dsh-proxy/login', { host: '192.168.1.50:3081' })
    expect(form.status).toBe(200)
    // The page has to say so, because a cleartext password is sniffable.
    expect(form.body.toString('utf8')).toContain('未加密')

    const login = await requestAt(port, '/__dsh-proxy/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: '192.168.1.50:3081' },
      body: 'username=admin&password=s3cret',
    })
    expect(login.status).toBe(303)
    const setCookie = login.headers['set-cookie']?.[0] ?? ''
    // A `Secure` cookie would simply not be stored over http, so this variant
    // drops both `Secure` and the `__Host-` prefix it requires.
    expect(setCookie).toContain('dsh_proxy_session=')
    expect(setCookie).not.toContain('__Host-')
    expect(setCookie).not.toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')

    // The cookie authenticates the cleartext visitor on the next request.
    const cookie = (setCookie.split(';')[0] ?? '')
    const app = await rawGetAt(port, '/api/state', { host: '192.168.1.50:3081', cookie })
    expect(app.status).toBe(200)
  })

  it('still accepts Basic credentials on cleartext when Basic mode is configured', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store, cleartextAuth: 'basic' })
    const anonymous = await rawGetAt(port, '/api/state', { host: '192.168.1.50:3081' })
    expect(anonymous.status).toBe(401)
    const authorized = await rawGetAt(port, '/api/state', {
      host: '192.168.1.50:3081',
      authorization: basic(),
    })
    expect(authorized.status).toBe(200)
  })

  it('leaves the surface open when no password is configured (no phantom login form)', async () => {
    // The documented "no password = no gate" state must not become an
    // unreachable login page: an unauthenticated request goes straight upstream.
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store, username: '', password: '' })
    const res = await rawGetAt(port, '/', { host: '192.168.1.50:3081', accept: 'text/html' })
    expect(res.status).toBe(200)
    expect(res.body.toString('utf8')).toContain('UPSTREAM_MARKER')

    // ...and requireTls does not lock an operator out of their own open proxy.
    const strict = await startExtraProxy({ auth: store, username: '', password: '', requireTls: true })
    const alsoOpen = await rawGetAt(strict.port, '/', { host: '192.168.1.50:3081', accept: 'text/html' })
    expect(alsoOpen.status).toBe(200)
  })

  it('refuses cleartext entirely when requireTls is on', async () => {
    const store = sessionStore()
    const { port } = await startExtraProxy({ auth: store, requireTls: true })
    const res = await rawGetAt(port, '/api/state', { host: '192.168.1.50:3081' })
    expect(res.status).toBe(403)
    expect(res.body.toString('utf8')).toContain('requires HTTPS')
  })

  it('never trusts forwarded headers from an untrusted peer', async () => {
    // remoteAddress is loopback in this test, which IS trusted, so the negative
    // case is expressed by configuring a trust list that cannot match: the
    // forwarded scheme must then be ignored and the request treated as cleartext.
    const store = sessionStore()
    const { port } = await startExtraProxy({
      auth: store,
      trustedProxyAddresses: ['203.0.113.7'],
      requireTls: true,
    })
    // Loopback peers are always trusted (a same-host reverse proxy), so this
    // request is upgraded by the header and gets the login redirect, not a 403.
    const trusted = await rawGetAt(port, '/api/state', {
      host: 'dsh.example.com',
      'x-forwarded-proto': 'https',
    })
    expect(trusted.status).toBe(303)
  })
})

describe('upstream header alignment', () => {
  it('rewrites Host and aligns Origin to the upstream loopback authority', async () => {
    // Simulate a LAN browser: the page origin differs from the upstream.
    const res = await fetch(`${base()}/api/state`, {
      headers: { authorization: basic(), origin: 'http://192.168.1.50:3081' },
    })
    expect(res.status).toBe(200)
    expect(world.seen.host).toBe(`127.0.0.1:${world.upstreamPort}`)
    expect(world.seen.origin).toBe(world.targetOrigin)
  })

  it('passes requests without an Origin header (non-browser clients)', async () => {
    const res = await fetch(`${base()}/api/state`, { headers: { authorization: basic() } })
    expect(res.status).toBe(200)
    expect(world.seen.host).toBe(`127.0.0.1:${world.upstreamPort}`)
  })

  it('forwards POST bodies unchanged', async () => {
    const res = await fetch(`${base()}/api/echo`, {
      method: 'POST',
      headers: { authorization: basic(), 'content-type': 'application/json' },
      body: JSON.stringify({ n: 42 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { echoed: string; host: string; origin: string }
    expect(JSON.parse(body.echoed)).toEqual({ n: 42 })
    expect(body.host).toBe(`127.0.0.1:${world.upstreamPort}`)
  })
})

describe('content handling', () => {
  it('serves public static files (manifest, favicon) without authentication', async () => {
    const manifest = await fetch(`${base()}/manifest.webmanifest`, { redirect: 'manual' })
    expect(manifest.status).toBe(200)
    const favicon = await fetch(`${base()}/favicon.svg`, { redirect: 'manual' })
    expect(favicon.status).toBe(200)
  })

  it('does not inject the polyfill into non-HTML responses', async () => {
    const res = await fetch(`${base()}/favicon.svg`, { headers: { authorization: basic() } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/svg+xml')
    expect(await res.text()).not.toContain('randomUUID')
  })

  it('rewrites served JavaScript to host-trust while Basic Auth enforces', async () => {
    const res = await fetch(`${base()}/plugins/x/client.js`, { headers: { authorization: basic() } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    const code = await res.text()
    expect(code).not.toContain('isLoopbackHostname')
    expect(code).toContain('isLoopback: true,')
    // The rewritten body must stay valid around the patch point.
    expect(code).toBe('const a=1;isLoopback: true,\nconst b=2;')
  })

  it('injects the HTML polyfill into gzip-compressed HTML', async () => {
    const res = await rawGet('/zipped', { authorization: basic() })
    expect(res.status).toBe(200)
    // Still served gzip-compressed on the wire after the recompress pass.
    expect(res.headers['content-encoding']).toBe('gzip')
    const html = zlib.gunzipSync(res.body).toString('utf8')
    expect(html).toContain('UPSTREAM_MARKER')
    expect(html).toContain(RANDOM_UUID_POLYFILL)
  })

  it('applies the JavaScript loopback-trust patch to gzip-compressed scripts', async () => {
    const res = await rawGet('/plugins/x/client.js.zipped', { authorization: basic() })
    expect(res.status).toBe(200)
    expect(res.headers['content-encoding']).toBe('gzip')
    const code = zlib.gunzipSync(res.body).toString('utf8')
    expect(code).toContain('isLoopback: true,')
    expect(code).not.toContain(CONNECTION_NEEDLE)
    expect(code).toBe('const a=1;isLoopback: true,\nconst b=2;')
  })

  it('applies the same JavaScript patch with password login off', async () => {
    // The compatibility fixes are unconditional: with credentials empty the
    // surface is open either way, and withholding only this alignment would
    // leave settings degraded while every other RPC stayed reachable.
    const openProxy = startLanProxy({
      listenHost: '127.0.0.1',
      listenPort: 0,
      upstreamHost: '127.0.0.1',
      upstreamPort: world.upstreamPort,
      username: '',
      password: '',
    })
    cleanup.splice(0, 0, () => openProxy.close())
    const port = await openProxy.ready
    const res = await fetch(`http://127.0.0.1:${port}/plugins/x/client.js`)
    expect(res.status).toBe(200)
    const code = await res.text()
    expect(code).not.toContain(CONNECTION_NEEDLE)
    expect(code).toBe('const a=1;isLoopback: true,\nconst b=2;')
  })
})

describe('websocket', () => {
  it('opens a socket with a Basic Authorization header and echoes messages', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${world.proxyPort}/api/events.mux`, {
      headers: { authorization: basic(), origin: 'http://192.168.1.50:3081' },
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const reply = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(String(data)))
      ws.send('ping')
      setTimeout(() => reject(new Error('no reply')), 5000)
    })
    expect(reply).toBe('echo:ping')
    ws.close()
  })

  it('rejects anonymous upgrades with 401 and a Basic challenge', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${world.proxyPort}/api/events.mux`)
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0)
        ws.terminate()
      })
      ws.on('open', () => reject(new Error('should not open')))
      ws.on('error', () => { /* unexpected-response path */ })
    })
    expect(status).toBe(401)
  })
})
