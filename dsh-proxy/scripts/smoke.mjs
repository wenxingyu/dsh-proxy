/**
 * Live smoke test for dsh-proxy against a RUNNING DSH web app.
 *
 * Starts the bundled proxy (lib/index.js — the same artifact the profile
 * loads) on 127.0.0.1:0, then verifies the full LAN story against the real
 * app: login flow, cookie-gated proxying, trust-fence header rewriting,
 * randomUUID polyfill injection, and WebSocket handshakes.
 *
 * Usage: pnpm run smoke   (requires the web app on 127.0.0.1:3080)
 */
import net from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthState, startLanProxy } from '../lib/index.cjs'

const UPSTREAM = Number(process.env.DSH_SMOKE_UPSTREAM_PORT ?? 3080)
const USER = process.env.DSH_SMOKE_USER ?? 'admin'
const PASS = process.env.DSH_SMOKE_PASS ?? 'admin'
/** Optional DSH launch token: set it to exercise the full app flow (polyfill, WS). */
const TOKEN = process.env.DSH_SMOKE_TOKEN ?? ''

let passed = 0
let failed = 0
let skipped = 0

/** Record an environment-dependent check as not applicable (never as a failure). */
function skip(name, why) {
  skipped++
  console.log(`  SKIP  ${name} — ${why}`)
}

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}`)
  } else {
    failed++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function rawUpgrade(port, path, headers) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ]
      socket.write(lines.join('\r\n'))
    })
    let data = ''
    const timer = setTimeout(() => {
      socket.destroy()
      resolve({ status: 0, text: data })
    }, 8000)
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8')
      if (data.includes('\r\n\r\n')) {
        clearTimeout(timer)
        socket.destroy()
        const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(data)?.[1] ?? 0)
        resolve({ status, text: data })
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve({ status: 0, text: data })
    })
  })
}

async function main() {
  const upstream = `http://127.0.0.1:${UPSTREAM}`
  console.log(`dsh-proxy smoke — upstream ${upstream}, auth ${USER}/***`)
  // A real session store, exactly like the controller passes in: the gate is
  // session-based now, with Basic kept as the compatibility path.
  const auth = new AuthState()
  const handle = startLanProxy({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamHost: '127.0.0.1',
    upstreamPort: UPSTREAM,
    username: USER,
    password: PASS,
    auth,
    log: (level, message) => console.log(`  [proxy:${level}] ${message}`),
  })
  const port = await handle.ready
  const base = `http://127.0.0.1:${port}`
  const origin = `http://127.0.0.1:${port}`
  const authorization = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`

  try {
    // 1. anonymous navigation → the login page (one gate everywhere)
    let res = await fetch(`${base}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    check(
      'anonymous / → 303 to the login page',
      res.status === 303 && res.headers.get('location') === '/__dsh-proxy/login',
      `status=${res.status} location=${res.headers.get('location')}`,
    )

    // 1b. the login page itself is served and hardened
    res = await fetch(`${base}/__dsh-proxy/login`, { redirect: 'manual' })
    const loginHtml = await res.text()
    check(
      'login page served with a credential form and hardened headers',
      res.status === 200
        && loginHtml.includes('type="password"')
        && (res.headers.get('content-security-policy') ?? '').includes("default-src 'none'")
        && res.headers.get('x-frame-options') === 'DENY',
      `status=${res.status} csp=${res.headers.get('content-security-policy')}`,
    )

    // 2. anonymous /api → the login page too
    res = await fetch(`${base}/api/state`, { redirect: 'manual' })
    check('anonymous /api → 303 to the login page', res.status === 303, `status=${res.status}`)

    // 2b. public static files (PWA manifest, favicon) need no auth
    res = await fetch(`${base}/manifest.webmanifest`, { redirect: 'manual' })
    check('public manifest served without auth', res.status === 200, `status=${res.status}`)
    res = await fetch(`${base}/favicon.svg`, { redirect: 'manual' })
    check('public favicon served without auth', res.status === 200, `status=${res.status}`)

    // 3. wrong Basic credentials → back to the login page (no dialog in session mode)
    res = await fetch(`${base}/`, { redirect: 'manual', headers: { authorization: `Basic ${Buffer.from(`${USER}:wrong`).toString('base64')}` } })
    check('wrong Basic credentials → 303 to the login page', res.status === 303, `status=${res.status}`)

    // 4. with Basic credentials the gate lets the request through to DSH: what
    // comes back is DSH's own 401 (or a token redirect), never our login page.
    res = await fetch(`${base}/`, { redirect: 'manual', headers: { authorization } })
    check(
      'Basic credentials pass the gate (upstream answers, not the login page)',
      res.status !== 303 || res.headers.get('location') !== '/__dsh-proxy/login',
      `status=${res.status} location=${res.headers.get('location')}`,
    )

    // 5. static asset through the proxy
    res = await fetch(`${base}/favicon.svg`, { headers: { authorization } })
    check('favicon served through the proxy', res.status === 200 && (res.headers.get('content-type') ?? '').includes('svg'), `status=${res.status}`)

    // 5b. the real browser flow: log in through the login page, then complete
    // DSH's own launch-token exchange so the upstream session cookie exists.
    // (Basic alone passes OUR gate, but DSH itself still wants its own cookie.)
    res = await fetch(`${base}/__dsh-proxy/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(USER)}&password=${encodeURIComponent(PASS)}`,
    })
    const proxyCookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    check('login page issues a session cookie', res.status === 303 && proxyCookie.includes('session='), `status=${res.status} cookie=${proxyCookie.slice(0, 40)}`)

    // DSH keeps its OWN browser session behind a per-process launch token that
    // only the in-process host knows. With DSH_SMOKE_TOKEN we complete that
    // exchange; without it the app-level checks below are SKIPPED (not failed),
    // because the gate itself has already been proven above.
    let upstreamCookie = ''
    if (TOKEN !== '') {
      const exchange = await fetch(`${base}/?token=${encodeURIComponent(TOKEN)}`, {
        redirect: 'manual',
        headers: { cookie: proxyCookie },
      })
      upstreamCookie = (exchange.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
      check('DSH launch-token exchange completed', upstreamCookie !== '', `status=${exchange.status}`)
    }
    const cookies = [proxyCookie, upstreamCookie].filter((c) => c !== '').join('; ')

    if (upstreamCookie === '') {
      skip('DSH app index + polyfill injection', 'set DSH_SMOKE_TOKEN to exercise the full app flow')
      skip('/api/events.mux trust-fence check', 'needs the DSH session cookie')
      skip('WS handshake with credentials → 101', 'needs the DSH session cookie')
    } else {
      // 6. trust fence passes: GET /api/events.mux reaches the route, not 403
      res = await fetch(`${base}/api/events.mux`, { headers: { authorization, cookie: cookies } })
      check('/api/events.mux reaches the route (426, fence passed)', res.status === 426, `status=${res.status} (403 would mean the Host/Origin rewrite failed)`)

      // 7. the real app index through the proxy, with the polyfill injected
      res = await fetch(`${base}/`, { headers: { cookie: cookies } })
      const appHtml = await res.text()
      const polyfillAt = appHtml.indexOf('randomUUID=function')
      const moduleAt = appHtml.indexOf('<script type="module"')
      check('authenticated / serves the DSH app', res.status === 200 && appHtml.includes('<div id="root">'), `status=${res.status}`)
      check('randomUUID polyfill injected before the app script', polyfillAt !== -1 && polyfillAt < moduleAt, `polyfillAt=${polyfillAt} moduleAt=${moduleAt}`)

      // 8. websocket with the session cookie + Basic credentials → 101
      const open = await rawUpgrade(port, '/api/events.mux', {
        Origin: origin,
        Authorization: authorization,
        Cookie: cookies,
      })
      check('WS handshake with credentials → 101', open.status === 101, `status=${open.status}`)
    }

    // 8. websocket without credentials → 401
    const denied = await rawUpgrade(port, '/api/events.mux', { Origin: origin })
    check('WS handshake without credentials → 401', denied.status === 401, `status=${denied.status}`)
  } finally {
    await handle.close()
  }

  await pluginContractPhase()

  console.log(`\nsmoke: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * Plugin-contract phase: drive the BUNDLED apply() (lib/index.cjs — the same
 * artifact the profile loads) against a fake cordis ctx, exercising the
 * /api/dsh-proxy Fetch route, the settings persistence, and the restart path
 * end to end without the web app. $DSH_HOME is redirected to a temp dir so
 * the smoke never touches the user's real persisted config.
 */
async function pluginContractPhase() {
  console.log('\ndsh-proxy plugin contract — bundled apply() with a fake ctx')
  const plugin = await import('../lib/index.cjs')
  check(
    'plugin exports name/inject/Config/apply',
    ['name', 'inject', 'Config', 'apply'].every((key) => key in plugin)
      && plugin.name === '@wenxingyu/dsh-proxy'
      && plugin.inject.includes('webServer')
      && plugin.inject.includes('connection'),
  )

  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-proxy-smoke-'))
  process.env.DSH_HOME = tempHome
  try {
    let registered = null
    const effectFns = []
    const fakeCtx = {
      webServer: { port: UPSTREAM, host: '127.0.0.1' },
      connection: {
        fetch: {
          register: (route) => {
            registered = route
            return async () => {}
          },
        },
      },
      logger: {
        info: (message) => console.log(`  [plugin:info] ${message}`),
        warn: (message) => console.log(`  [plugin:warn] ${message}`),
        error: (message) => console.log(`  [plugin:error] ${message}`),
      },
      effect: (fn) => {
        effectFns.push(fn)
        return () => {}
      },
    }
    plugin.apply(fakeCtx, { listenHost: '127.0.0.1', listenPort: 0 })
    const proxyDisposer = await effectFns[0]()
    const rpcCleanup = effectFns[1]()
    check(
      'settings route registered as POST /api/dsh-proxy with a buffered body',
      registered?.path === '/api/dsh-proxy'
        && registered?.methods?.includes('POST') === true
        && registered?.requestBody === 'buffered'
        && typeof registered?.fetch === 'function',
    )

    /** POST one endpoint through the registered route and decode the envelope. */
    const callRoute = async (endpoint, payload = {}) => {
      const response = await registered.fetch(new Request('http://127.0.0.1/api/dsh-proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
      }))
      return response.json()
    }

    const status1 = await callRoute('status')
    check(
      'status returns ok with a bound port and green lights',
      status1?.ok === true
        && typeof status1.value?.listenPort === 'number'
        && status1.value?.listenPort > 0
        && status1.value?.proxyListening === true
        && status1.value?.upstreamReachable === true,
      JSON.stringify(status1),
    )

    const updated = await callRoute('update', { username: 'smoke-user', password: 'smoke-pass' })
    check(
      'update rotates credentials and restarts',
      updated?.ok === true && updated.value?.status?.username === 'smoke-user',
      JSON.stringify(updated),
    )

    const status2 = await callRoute('status')
    check(
      'status reflects the new username and persisted flag',
      status2?.ok === true && status2.value?.username === 'smoke-user' && status2.value?.persisted === true,
    )

    const persisted = JSON.parse(readFileSync(join(tempHome, 'dsh-proxy.json'), 'utf8'))
    check(
      'patch persisted to $DSH_HOME/dsh-proxy.json',
      persisted.username === 'smoke-user' && persisted.password === 'smoke-pass',
    )

    const conflict = await callRoute('update', { listenPort: status2.value.upstreamPort })
    check('listen port equal to the default service port rejected', conflict?.ok === false, JSON.stringify(conflict))

    const cleared = await callRoute('update', { username: '', password: '' })
    check(
      'clearing credentials disables password login (set-empty semantics)',
      cleared?.ok === true && cleared.value?.status?.authEnabled === false && cleared.value?.status?.password === '',
      JSON.stringify(cleared),
    )
    // The host runs on loopback here, so a password-free listener is NOT an
    // open LAN surface: the exposure flag that drives the red warning must stay
    // off (unit tests cover the LAN-exposed branch).
    check(
      'a password-free loopback listener is not flagged as LAN-exposed',
      cleared.value?.status?.lanExposed === false,
      JSON.stringify(cleared.value?.status),
    )
    const reopened = await callRoute('update', { username: 'smoke-user', password: 'smoke-pass' })
    check(
      're-setting both credentials re-enables password login',
      reopened?.ok === true && reopened.value?.status?.authEnabled === true,
    )

    const stopped = await callRoute('stop')
    check(
      'stop answers with the proxy stopped',
      stopped?.ok === true && stopped.value?.proxyListening === false,
      JSON.stringify(stopped),
    )
    // Let the deferred listener close, then bring it back up.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const started = await callRoute('start')
    check(
      'start brings the proxy back up',
      started?.ok === true && started.value?.proxyListening === true,
      JSON.stringify(started),
    )

    rpcCleanup()
    await proxyDisposer()
  } finally {
    delete process.env.DSH_HOME
    rmSync(tempHome, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('smoke crashed:', err)
  process.exit(1)
})
