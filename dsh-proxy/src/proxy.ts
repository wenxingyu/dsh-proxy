/**
 * The LAN reverse proxy core: an HTTP + WebSocket reverse proxy that forwards
 * to the local DSH service (127.0.0.1:<upstreamPort>) and gates every request
 * behind HTTP Basic Auth — the browser's NATIVE credential dialog. No custom
 * login page, no session cookies:
 * after a successful Basic login the browser caches the credentials for the
 * origin and sends them on every request (including WebSocket handshakes).
 * Pure node — no cordis; the plugin entry in index.ts wires it into the
 * harness lifecycle.
 *
 * Three compatibility fixes make the proxied LAN surface work exactly like
 * loopback access:
 * - `changeOrigin` rewrites Host to the upstream loopback authority, so the
 *   DSH `/api` browser-trust fence sees a loopback Host.
 * - The browser's Origin is aligned to the same upstream authority (the fence
 *   requires Origin to equal the Host it sees), which also covers WebSocket
 *   upgrades.
 * - The `crypto.randomUUID` polyfill is injected into every proxied HTML
 *   document, because LAN pages are a non-secure context where randomUUID is
 *   undefined.
 *
 * A fourth fix (dsh 0.1.1+) patches served JavaScript instead of HTML: the
 * client now computes `connection.isLoopback` from `location.hostname` and
 * keeps settings remote-only on non-loopback pages ("settings are unavailable
 * in this browser"). Since the hostname cannot be spoofed, the proxy rewrites
 * the bundle bytes to restore host-trust — unconditionally, like every other
 * compatibility fix here: the Host/Origin rewrite already presents proxied
 * traffic as loopback to the server-side fence, so withholding only the
 * client-side alignment would leave the UI degraded while the wire stayed
 * fully open. Basic Auth remains the one security barrier for the surface.
 */
import http from 'node:http'
import type { Duplex } from 'node:stream'
import net from 'node:net'
import os from 'node:os'
import httpProxy from 'http-proxy'
import { Authenticator } from './session.ts'
import {
  AuthState,
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  type AuditEntry,
} from './auth.ts'
import { loginFailureMessage, renderLoginPage } from './loginpage.ts'
import { isTrustedProxyPeer, resolveClientAddress, resolveGate, resolveSecureTransport } from './netaccess.ts'
import { injectPolyfill, RANDOM_UUID_POLYFILL } from './polyfill.ts'
import { isJavaScriptContentType, patchClientScript } from './clientpatch.ts'
import { attachBodyTransform } from './compression.ts'

export interface LanProxyOptions {
  /** Interface the proxy binds (0.0.0.0 for LAN access). */
  listenHost: string
  /** Port the proxy listens on; 0 asks the OS for a free port. */
  listenPort: number
  /** Upstream DSH bind host, normally the loopback address. */
  upstreamHost: string
  /** Upstream DSH port (the web app's actual bound port). */
  upstreamPort: number
  /** Basic Auth username; password login is enabled only when both it and `password` are set. */
  username: string
  /** Basic Auth password; password login is enabled only when both it and `username` are set. */
  password: string
  /**
   * Build the host's launch-token URL for one public origin (the origin the
   * BROWSER used, e.g. `http://192.168.1.20:3081`).
   *
   * DSH answers the index with 401 until the browser holds its per-process
   * session cookie, and the cookie is only minted by opening the tokenized URL
   * `dsh web` prints — a loopback address a LAN visitor cannot use. When this
   * hook is provided, an unauthenticated index request is redirected through
   * the token exchange for the caller's own origin, so the LAN URL logs itself
   * in. Omit it when the host offers no launch-token source to pass the
   * upstream 401 through unchanged.
   */
  authenticatedUrl?: (publicOrigin: string) => string | undefined
  /**
   * Session store for the login page. When present, a request that arrived over
   * TLS (or from a loopback browser) is gated by a session cookie and served the
   * login form; a plain-HTTP LAN request keeps the native Basic Auth dialog, so
   * the long-standing LAN workflow is unchanged.
   */
  auth?: AuthState
  /** Addresses whose `X-Forwarded-*` headers are believed (the TLS-terminating proxy in front). */
  trustedProxyAddresses?: readonly string[]
  /**
   * Refuse cleartext altogether instead of authenticating it. Off by default:
   * the LAN-over-HTTP deployment is a supported configuration.
   */
  requireTls?: boolean
  /**
   * How an allowed cleartext visitor authenticates. Defaults to the login page so
   * the gate is one mechanism everywhere; `basic` keeps the native dialog.
   */
  cleartextAuth?: 'login' | 'basic'
  /** Heading/title of the login page. */
  loginTitle?: string
  /** Sink for gate events the session store does not own (e.g. a refused cleartext request). */
  audit?: (entry: AuditEntry) => void
  /** Optional sink for human-readable lifecycle messages. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface LanProxyHandle {
  /** Resolves with the bound port once listening; rejects on bind errors. */
  ready: Promise<number>
  /** Close the listener and every upgraded socket. */
  close: () => Promise<void>
  /** Human-readable access URLs (local + LAN) for the configured port. */
  describeUrls: (boundPort: number) => { local: string; lan: string[] }
}

/** Basic Auth realm presented to unauthenticated clients. */
const AUTH_REALM = 'dsh-proxy'

/**
 * Reserved path prefix for the proxy's own authentication routes.
 *
 * Living inside the proxied origin (rather than a second port) is what lets the
 * session cookie's `Path=/` scope cover the whole app; the prefix belongs to the
 * proxy, so no upstream route is shadowed by it.
 */
const AUTH_PATH_PREFIX = '/__dsh-proxy'
/** GET serves the form; POST submits credentials. */
export const LOGIN_PATH = `${AUTH_PATH_PREFIX}/login`
/** Clears the session cookie and returns to the form. */
export const LOGOUT_PATH = `${AUTH_PATH_PREFIX}/logout`

/**
 * Static files browsers fetch OUTSIDE the authenticated document context
 * (the PWA manifest and the favicon are requested without credentials), so
 * gating them on Basic auth 401s them. They carry no secrets and the
 * upstream serves them unauthenticated anyway.
 */
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg'])

/** Query parameter DSH's index token exchange reads. */
const TOKEN_QUERY = 'token'

/** LAN IPv4 addresses the host currently has, as http URLs on `port`. */
export function lanAddresses(port: number): string[] {
  const ips: string[] = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const entry of ifaces ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) ips.push(entry.address)
    }
  }
  return ips.map((ip) => `http://${ip}:${port}`)
}

export function startLanProxy(options: LanProxyOptions): LanProxyHandle {
  const {
    listenHost,
    listenPort,
    upstreamHost,
    upstreamPort,
    username,
    password,
    log = () => {},
  } = options
  const targetOrigin = `http://${upstreamHost}:${upstreamPort}`
  const auth = new Authenticator({ username, password })

  const proxy = httpProxy.createProxyServer({
    target: targetOrigin,
    ws: true,
    changeOrigin: true,
  })
  proxy.on('error', (err, _req, res) => {
    log('error', `upstream ${targetOrigin} error: ${err.message}`)
    if (res && 'writeHead' in res && !res.headersSent) {
      try {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('502 Bad Gateway')
      } catch {
        /* socket already gone */
      }
    }
  })

  // The browser's own authority, captured before http-proxy rewrites Host to
  // the upstream (changeOrigin) — the token exchange has to send the browser
  // back to the address it actually used.
  const publicOrigins = new WeakMap<http.IncomingMessage, string>()

  /**
   * Send an unauthenticated index request through DSH's launch-token exchange
   * instead of returning its "reopen the URL printed by dsh web" page, which
   * only a loopback browser can act on.
   *
   * Only `GET /` without a token is redirected, so an API/asset 401 stays a
   * 401 and a token the host rejects falls through to the upstream answer
   * rather than looping.
   * @returns whether the response was answered here.
   */
  const redirectIndexToTokenExchange = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    statusCode: number | undefined,
  ): boolean => {
    if (statusCode !== 401 || options.authenticatedUrl === undefined) return false
    if (req.method !== 'GET') return false
    let pathname: string
    let hasToken: boolean
    try {
      const url = new URL(req.url ?? '/', 'http://proxy.local')
      pathname = url.pathname
      hasToken = url.searchParams.has(TOKEN_QUERY)
    } catch {
      return false
    }
    if (pathname !== '/' || hasToken) return false
    const authority = publicOrigins.get(req)
    if (authority === undefined) return false
    let target: string | undefined
    try {
      target = options.authenticatedUrl(`http://${authority}`)
    } catch {
      return false
    }
    if (target === undefined) return false
    res.writeHead(302, {
      location: target,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end()
    return true
  }

  // Inject the randomUUID polyfill into proxied HTML documents, and rewrite
  // served JavaScript so the client treats the authenticated proxy as
  // host-trusted (see clientpatch.ts). The upstream DSH server compresses its
  // responses (gzip by default), so these plain-text rewrites run through a
  // compression-aware pipeline that buffers the response, decompresses by its
  // Content-Encoding, applies the rewrite on the plain text, then recompresses
  // by the original encoding (see compression.ts). content-length is dropped
  // because the rewrite changes the body length; the chunked stream then
  // carries the body.
  proxy.on('proxyRes', (proxyRes, req, res) => {
    if (redirectIndexToTokenExchange(req, res, proxyRes.statusCode)) {
      proxyRes.resume()
      return
    }
    const contentType = String(proxyRes.headers['content-type'] ?? '')
    const isHtml = contentType.includes('text/html')
    const isJs = isJavaScriptContentType(contentType)
    if (!isHtml && !isJs) return

    attachBodyTransform(res, proxyRes, (plain) => {
      const text = plain.toString('utf8')
      // HTML: inject the randomUUID polyfill.
      if (isHtml) {
        return Buffer.from(injectPolyfill(text, RANDOM_UUID_POLYFILL))
      }
      // JS: rewrite the loopback-trust needles (applied unconditionally — the
      // Host/Origin rewrite already lets the server-side fence treat proxied
      // traffic as loopback, so withholding only the client-side alignment
      // would leave the UI degraded). Nothing matched means no rewrite needed:
      // return null to passthrough without recompressing.
      const { code, matched } = patchClientScript(text)
      if (matched.length > 0) {
        log('info', `loopback-trust patch applied: ${matched.join(', ')}`)
        return Buffer.from(code)
      }
      return null
    })
  })

  const alignOrigin = (req: http.IncomingMessage): void => {
    if (req.headers.origin) req.headers.origin = targetOrigin
  }

  /**
   * Challenge with HTTP Basic Auth: the 401 plus WWW-Authenticate makes the
   * browser show its NATIVE credential dialog. No custom login page exists —
   * this is the whole authentication surface. (Browsers cache the credentials
   * per origin after a successful login and silently replay them, including on
   * WebSocket handshakes.)
   */
  const challenge = (res: http.ServerResponse): void => {
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'www-authenticate': `Basic realm="${AUTH_REALM}"`,
    })
    res.end('401 Unauthorized')
  }

  /**
   * Resolve how this request must be gated: sessions over TLS/loopback,
   * Basic Auth on a plain LAN (the compatible path), or a refusal when the
   * operator opted into `requireTls`.
   */
  const gateFor = (req: http.IncomingMessage): ReturnType<typeof resolveGate> => {
    const peerTrusted = isTrustedProxyPeer(req.socket.remoteAddress, {
      addresses: new Set(options.trustedProxyAddresses ?? []),
    })
    const secure = resolveSecureTransport({
      forwardedProto: req.headers['x-forwarded-proto'],
      peerTrusted,
      socketEncrypted: (req.socket as { encrypted?: boolean }).encrypted === true,
    })
    return resolveGate({
      secure,
      host: req.headers.host,
      socketEncrypted: (req.socket as { encrypted?: boolean }).encrypted === true,
      requireTls: options.requireTls === true,
      cleartextAuth: options.cleartextAuth ?? 'login',
    })
  }

  /**
   * Whether the credential gate applies at all. An incomplete credential pair
   * means "no password": the long-standing open behaviour, where the whole surface
   * is reachable without a login — never a redirect to a form nobody can satisfy.
   */
  const gateEnforced = (): boolean => auth.enabled

  /** The per-client key used for throttling and auditing. */
  const clientAddressFor = (req: http.IncomingMessage): string => {
    const peerTrusted = isTrustedProxyPeer(req.socket.remoteAddress, {
      addresses: new Set(options.trustedProxyAddresses ?? []),
    })
    return resolveClientAddress({
      forwardedFor: req.headers['x-forwarded-for'],
      peerAddress: req.socket.remoteAddress,
      peerTrusted,
    })
  }

  /** Headers every login-page response carries: never cached, never a referrer. */
  const loginPageHeaders = (contentType: string): Record<string, string> => ({
    'content-type': contentType,
    'cache-control': 'no-store, must-revalidate',
    'referrer-policy': 'no-referrer',
    // The page is self-contained (one inline style block, no script, no frames),
    // so the policy can be maximally strict.
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  })

  /** Read at most `limit` bytes of a request body (a login form is tiny). */
  const readFormBody = (req: http.IncomingMessage, limit = 8 * 1024): Promise<string> =>
    new Promise((resolve) => {
      let body = ''
      let size = 0
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        size += Buffer.byteLength(chunk)
        if (size > limit) {
          resolve(body)
          req.destroy()
          return
        }
        body += chunk
      })
      req.on('end', () => resolve(body))
      req.on('error', () => resolve(body))
    })

  /**
   * Same-origin check for state-changing plugin routes.
   *
   * The session cookie is already `SameSite=Strict`, which keeps a cross-site
   * form from carrying it; this is the belt to that suspenders, because a
   * same-site-but-different-port page would otherwise submit unnoticed.
   *
   * Two signals are used, in order of reliability:
   * 1. `Sec-Fetch-Site`, which a browser computes itself and a page cannot
   *    forge. `same-origin` is conclusive and `none` means a direct navigation.
   *    This is what keeps the check CORRECT even when a proxy rewrites `Host`
   *    (the browser's `Origin` then legitimately differs from what we see).
   * 2. The `Origin`/`Host` comparison, for clients that do not send
   *    `Sec-Fetch-Site` (curl, older browsers, non-browser clients).
   *
   * @returns a rejection reason, or null when the request may proceed.
   */
  const crossSiteReason = (req: http.IncomingMessage): string | null => {
    const fetchSite = req.headers['sec-fetch-site']
    if (typeof fetchSite === 'string') {
      if (fetchSite === 'same-origin' || fetchSite === 'none') return null
      if (fetchSite === 'same-site' || fetchSite === 'cross-site') {
        return `浏览器报告来源为 ${fetchSite}（仅接受同源提交）`
      }
    }
    const origin = req.headers.origin
    if (origin === undefined) return null
    // `Origin: null` is the browser saying "I have no origin to disclose" (a
    // sandboxed/privacy-hardened context, some in-app browsers, or a redirect
    // chain). It is NOT evidence of a cross-site request, and treating it as one
    // broke a legitimate login. Absence of a positive cross-site signal is the
    // rule here; the credential itself plus SameSite=Strict remain the real
    // barrier against a login-CSRF, which is the only attack this check guards.
    if (origin === 'null') return null
    let host: string
    try {
      host = new URL(origin).host
    } catch {
      // A malformed, non-null Origin is the one case worth refusing: it is not
      // something a well-behaved browser produces.
      return `Origin 头无法解析：${origin}`
    }
    const expected = req.headers.host ?? ''
    if (host !== expected) {
      // State both values: a mismatch here is almost always a proxy rewriting
      // Host, and the operator needs to see that rather than guess.
      return `来源校验失败：Origin=${host} 与 Host=${expected} 不一致`
    }
    return null
  }

  /** Backwards-compatible boolean wrapper around {@link crossSiteReason}. */
  const isCrossSite = (req: http.IncomingMessage): boolean => crossSiteReason(req) !== null

  /** Plain-text refusal shown when the deployment requires TLS and got cleartext. */
  const refuseCleartext = (res: http.ServerResponse): void => {
    res.writeHead(403, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end('403 Forbidden — this proxy requires HTTPS (configure requireTls after putting a TLS reverse proxy in front).')
  }

  /** Serve the login form, carrying an optional already-localized error. */
  const serveLoginPage = (res: http.ServerResponse, gate: { secure: boolean }, error?: string): void => {
    const html = renderLoginPage({
      action: LOGIN_PATH,
      secure: gate.secure,
      ...(options.loginTitle === undefined ? {} : { title: options.loginTitle }),
      ...(error === undefined ? {} : { error }),
    })
    res.writeHead(200, loginPageHeaders('text/html; charset=utf-8'))
    res.end(html)
  }

  /**
   * Handle the plugin's own authentication routes. They live under a reserved
   * path inside the proxied origin so the session cookie's scope (Path=/) is the
   * whole app, and are never forwarded upstream.
   * @returns whether the request was answered here.
   */
  const handleAuthRoutes = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    gate: ReturnType<typeof resolveGate>,
  ): Promise<boolean> => {
    const store = options.auth
    if (store === undefined || gate.mode !== 'session' || !gateEnforced()) return false

    if (pathname === LOGIN_PATH) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveLoginPage(res, gate)
        return true
      }
      if (req.method !== 'POST') {
        res.writeHead(405, loginPageHeaders('text/plain; charset=utf-8')).end('405 Method Not Allowed')
        return true
      }
      const crossSite = crossSiteReason(req)
      if (crossSite !== null) {
        log('warn', `dsh-proxy: rejected a login POST — ${crossSite}`)
        serveLoginPage(res, gate, `请求来源校验失败：${crossSite}。请从登录页直接登录。`)
        return true
      }
      if (req.headers.origin === undefined || req.headers.origin === 'null') {
        // Allowed, but recorded: knowing which clients withhold the origin is how
        // an operator distinguishes an in-app browser from an attack.
        options.audit?.({
          at: Date.now(),
          event: 'login-origin-withheld',
          source: clientAddressFor(req),
          detail: `sec-fetch-site=${String(req.headers['sec-fetch-site'] ?? 'none')} origin=${String(req.headers.origin ?? 'absent')}`,
        })
      }
      const body = await readFormBody(req)
      const form = new URLSearchParams(body)
      const result = store.login({
        username: form.get('username') ?? '',
        password: form.get('password') ?? '',
        source: clientAddressFor(req),
        userAgent: req.headers['user-agent'] ?? '',
        expected: { username, password },
      })
      if (!result.ok) {
        serveLoginPage(res, gate, loginFailureMessage(result.reason, result.retryAfterMs))
        return true
      }
      // 303 so a refresh re-issues the GET instead of re-posting credentials.
      res.writeHead(303, {
        ...loginPageHeaders('text/plain; charset=utf-8'),
        location: '/',
        'set-cookie': sessionCookie(
          result.session.token,
          Math.floor(store.authPolicy.sessionTtlMs / 1000),
          gate.cookieName,
        ),
      })
      res.end()
      return true
    }

    if (pathname === LOGOUT_PATH) {
      // A cross-site GET here would only log the victim out, so it is allowed on
      // both verbs; a cross-site POST is refused for symmetry with login.
      if (req.method === 'POST' && isCrossSite(req)) {
        res.writeHead(403, loginPageHeaders('text/plain; charset=utf-8')).end('403 Forbidden')
        return true
      }
      store.logout(readCookie(req.headers.cookie, gate.cookieName))
      res.writeHead(303, {
        ...loginPageHeaders('text/plain; charset=utf-8'),
        location: LOGIN_PATH,
        'set-cookie': clearedSessionCookie(gate.cookieName),
      })
      res.end()
      return true
    }

    return false
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://proxy.local')
    const pathname = url.pathname
    if (req.headers.host !== undefined) publicOrigins.set(req, req.headers.host)
    const gate = gateFor(req)

    void handleAuthRoutes(req, res, pathname, gate).then((handled) => {
      if (handled) return
      // Public static files (PWA manifest, favicon): fetched without
      // credentials by the browser, so they bypass the auth gate.
      if (PUBLIC_PATHS.has(pathname)) {
        alignOrigin(req)
        proxy.web(req, res)
        return
      }

      if (gate.mode === 'plaintext-blocked' && gateEnforced()) {
        options.audit?.({ at: Date.now(), event: 'insecure-transport-refused', source: clientAddressFor(req), detail: pathname })
        refuseCleartext(res)
        return
      }

      // No password configured: no gate. This is the documented open state the
      // settings page warns about; it must not turn into an unreachable login form.
      if (!gateEnforced()) {
        alignOrigin(req)
        proxy.web(req, res)
        return
      }

      // A session gate accepts a valid cookie; the Basic path (a plain LAN) keeps
      // the native dialog, and BOTH accept Basic credentials so an existing
      // configured client keeps working after an upgrade.
      const session = gate.mode === 'session'
        ? options.auth?.authenticate(readCookie(req.headers.cookie, gate.cookieName))
        : null
      if (session !== null && session !== undefined) {
        alignOrigin(req)
        proxy.web(req, res)
        return
      }
      if (!auth.isAuthenticated(req.headers.authorization)) {
        if (gate.mode === 'session') {
          // No browser dialog here: send the visitor to the form they can use.
          res.writeHead(303, {
            'cache-control': 'no-store',
            location: LOGIN_PATH,
          })
          res.end()
          return
        }
        challenge(res)
        return
      }
      alignOrigin(req)
      proxy.web(req, res)
    })
  })

  const upgradedSockets = new Set<net.Socket>()
  server.on('upgrade', (req, socket, head) => {
    const gate = gateFor(req)
    // A WebSocket cannot be redirected to a login page, so it is admitted only by
    // a valid session cookie (TLS/loopback) or Basic credentials (plain LAN).
    if (!gateEnforced()) {
      upgradedSockets.add(socket as net.Socket)
      ;(socket as net.Socket).once('close', () => upgradedSockets.delete(socket as net.Socket))
      alignOrigin(req)
      proxy.ws(req, socket as Duplex, head)
      return
    }
    const session = gate.mode === 'session'
      ? options.auth?.authenticate(readCookie(req.headers.cookie, gate.cookieName))
      : null
    if (session === null || session === undefined) {
      if (!auth.isAuthenticated(req.headers.authorization)) {
        socket.end(`HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`)
        return
      }
    }
    upgradedSockets.add(socket as net.Socket)
    ;(socket as net.Socket).once('close', () => upgradedSockets.delete(socket as net.Socket))
    alignOrigin(req)
    proxy.ws(req, socket as Duplex, head)
  })

  const ready = new Promise<number>((resolve, reject) => {
    const onListenError = (err: NodeJS.ErrnoException): void => {
      log('error', `cannot listen on ${listenHost}:${listenPort}: ${err.code ?? err.message}`)
      reject(err)
    }
    server.once('error', onListenError)
    server.listen(listenPort, listenHost, () => {
      server.off('error', onListenError)
      server.on('error', (err) => log('error', `proxy server error: ${err.message}`))
      resolve((server.address() as net.AddressInfo).port)
    })
  })

  const close = async (): Promise<void> => {
    for (const socket of upgradedSockets) socket.destroy()
    upgradedSockets.clear()
    await new Promise<void>((resolveClose) => {
      // Stop accepting new connections; the listener is released immediately
      // so a restart can rebind the same port. In-flight responses (e.g. the
      // settings-page update answer travelling back through the proxy) get a
      // short grace before connections are force-closed. The timer stays
      // referenced so it always fires even under a loaded event loop.
      server.close(() => resolveClose())
      const timer = setTimeout(() => {
        server.closeAllConnections()
      }, 250)
    })
  }

  return {
    ready,
    close,
    describeUrls: (boundPort) => ({
      local: `http://127.0.0.1:${boundPort}`,
      lan: lanAddresses(boundPort),
    }),
  }
}
