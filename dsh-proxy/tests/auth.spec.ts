/**
 * The authentication core: session lifecycle, throttling/lockout, cookie
 * construction, and the login page document.
 *
 * Time is injected, so every expiry and lockout rule is exercised without
 * sleeping; the audit trail writes to a temp directory.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AuthState,
  DEFAULT_AUTH_POLICY,
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  sessionIdOf,
  verifyCredentials,
  type AuditEntry,
} from '../src/auth.ts'
import { AuditTrail } from '../src/audit.ts'
import { loginFailureMessage, renderLoginPage } from '../src/loginpage.ts'

const CREDS = { username: 'admin', password: 's3cret' }
const dirs: string[] = []

function tempFile(name = 'audit.jsonl'): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-proxy-auth-'))
  dirs.push(dir)
  return join(dir, name)
}

/** A controllable clock. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms) => { current += ms } }
}

function stateWith(sink?: (entry: AuditEntry) => void, now?: () => number): AuthState {
  return new AuthState({
    ...(now === undefined ? {} : { now }),
    ...(sink === undefined ? {} : { audit: sink }),
    policy: { maxFailures: 3, lockoutMs: 60_000, failureDelayMs: 0 },
  })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('verifyCredentials', () => {
  it('accepts the exact pair and rejects either half being wrong', () => {
    expect(verifyCredentials(CREDS, CREDS)).toBe(true)
    expect(verifyCredentials({ username: 'admin', password: 'nope' }, CREDS)).toBe(false)
    expect(verifyCredentials({ username: 'nope', password: 's3cret' }, CREDS)).toBe(false)
    expect(verifyCredentials({ username: '', password: '' }, CREDS)).toBe(false)
    // Length mismatch must not throw (timingSafeEqual requires equal lengths).
    expect(() => verifyCredentials({ username: 'a', password: 'b' }, CREDS)).not.toThrow()
  })
})

describe('AuthState sessions', () => {
  it('issues a session on a correct login and accepts its token', () => {
    const state = stateWith()
    const result = state.login({ ...CREDS, source: '10.0.0.5', expected: CREDS })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session.token.length).toBeGreaterThanOrEqual(32)
    expect(state.authenticate(result.session.token)?.source).toBe('10.0.0.5')
    expect(state.sessionCount).toBe(1)
  })

  it('rejects an unknown or empty token', () => {
    const state = stateWith()
    expect(state.authenticate(undefined)).toBeNull()
    expect(state.authenticate('')).toBeNull()
    expect(state.authenticate('made-up-token')).toBeNull()
  })

  it('expires a session after the idle timeout', () => {
    const c = clock()
    const state = stateWith(undefined, c.now)
    const result = state.login({ ...CREDS, source: 's', expected: CREDS })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Touching it keeps it alive across a span longer than the idle window.
    c.advance(DEFAULT_AUTH_POLICY.sessionIdleMs - 1)
    expect(state.authenticate(result.session.token)).not.toBeNull()
    c.advance(DEFAULT_AUTH_POLICY.sessionIdleMs + 1)
    expect(state.authenticate(result.session.token)).toBeNull()
  })

  it('expires a session after the absolute lifetime even when it is used', () => {
    const c = clock()
    const state = stateWith(undefined, c.now)
    const result = state.login({ ...CREDS, source: 's', expected: CREDS })
    if (!result.ok) return
    // Keep it active, but walk past the absolute lifetime.
    const step = DEFAULT_AUTH_POLICY.sessionIdleMs - 1000
    for (let t = 0; t < DEFAULT_AUTH_POLICY.sessionTtlMs; t += step) {
      c.advance(step)
      state.authenticate(result.session.token)
    }
    c.advance(step)
    expect(state.authenticate(result.session.token)).toBeNull()
  })

  it('logs out only the caller and revokes others by id', () => {
    const state = stateWith()
    const a = state.login({ ...CREDS, source: 'a', expected: CREDS })
    const b = state.login({ ...CREDS, source: 'b', expected: CREDS })
    if (!a.ok || !b.ok) return
    expect(state.sessionCount).toBe(2)

    state.logout(a.session.token)
    expect(state.authenticate(a.session.token)).toBeNull()
    expect(state.authenticate(b.session.token)).not.toBeNull()

    const [view] = state.listSessions(b.session.token)
    expect(view?.current).toBe(true)
    expect(state.revokeSession(view.id)).toBe(true)
    expect(state.revokeSession(view.id)).toBe(false)
    expect(state.sessionCount).toBe(0)
  })

  it('never exposes the raw token through the session list', () => {
    const state = stateWith()
    const result = state.login({ ...CREDS, source: 'a', expected: CREDS })
    if (!result.ok) return
    const [view] = state.listSessions(result.session.token)
    expect(JSON.stringify(view)).not.toContain(result.session.token)
    expect(view.id).toBe(sessionIdOf(result.session.token))
  })

  it('revokes every other session while keeping the caller', () => {
    const state = stateWith()
    const keep = state.login({ ...CREDS, source: 'keep', expected: CREDS })
    const other = state.login({ ...CREDS, source: 'other', expected: CREDS })
    if (!keep.ok || !other.ok) return
    expect(state.revokeAllSessions(keep.session.token)).toBe(1)
    expect(state.authenticate(keep.session.token)).not.toBeNull()
    expect(state.authenticate(other.session.token)).toBeNull()
  })
})

describe('AuthState throttling', () => {
  it('locks a source after the configured failures and reports a retry window', () => {
    const c = clock()
    const events: AuditEntry[] = []
    const state = stateWith((e) => events.push(e), c.now)

    for (let i = 0; i < 3; i++) {
      const out = state.login({ username: 'admin', password: 'wrong', source: '1.2.3.4', expected: CREDS })
      expect(out.ok).toBe(false)
      if (!out.ok) expect(out.reason).toBe('invalid')
    }
    expect(state.lockedFor('1.2.3.4').locked).toBe(true)
    expect(events.some((e) => e.event === 'locked-out')).toBe(true)

    // While locked, even the CORRECT password is refused.
    const blocked = state.login({ ...CREDS, source: '1.2.3.4', expected: CREDS })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) {
      expect(blocked.reason).toBe('locked')
      expect(blocked.retryAfterMs).toBeGreaterThan(0)
    }

    // Another source is unaffected (the counter is per source, not global).
    expect(state.login({ ...CREDS, source: '5.6.7.8', expected: CREDS }).ok).toBe(true)
  })

  it('clears the lock after it expires and forgives failures after a success', () => {
    const c = clock()
    const state = stateWith(undefined, c.now)
    for (let i = 0; i < 3; i++) state.login({ username: 'x', password: 'y', source: 'src', expected: CREDS })
    expect(state.lockedFor('src').locked).toBe(true)
    c.advance(60_001)
    expect(state.lockedFor('src').locked).toBe(false)
    expect(state.login({ ...CREDS, source: 'src', expected: CREDS }).ok).toBe(true)
    expect(state.lockedFor('src').locked).toBe(false)
  })
})

describe('AuditTrail', () => {
  it('appends one JSON line per entry and replays the tail after a restart', () => {
    const file = tempFile()
    const trail = new AuditTrail({ filePath: file })
    const entry: AuditEntry = { at: 1, event: 'login-failed', source: '9.9.9.9' }
    trail.record(entry)
    trail.record({ at: 2, event: 'login', source: '9.9.9.9' })

    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(entry)

    // A fresh instance (a restarted proxy) reloads the recent window.
    const reopened = new AuditTrail({ filePath: file })
    expect(reopened.list().map((e) => e.event)).toEqual(['login-failed', 'login'])
  })

  it('caps the in-memory window and rotates the file at the size limit', () => {
    const file = tempFile()
    const trail = new AuditTrail({ filePath: file, keep: 3, maxBytes: 300 })
    for (let i = 0; i < 10; i++) trail.record({ at: i, event: 'login-failed', source: `s${i}` })
    expect(trail.list()).toHaveLength(3)
    expect(trail.list().map((e) => e.at)).toEqual([7, 8, 9])

    // Once past maxBytes the previous generation is kept beside it.
    expect(statSync(`${file}.1`).size).toBeGreaterThan(0)
  })

  it('ignores a torn final line instead of losing the whole trail', () => {
    const file = tempFile()
    writeFileSync(file, '{"at":1,"event":"login","source":"a"}\n{"at":2,"event":"log', 'utf8')
    const trail = new AuditTrail({ filePath: file })
    expect(trail.list()).toHaveLength(1)
  })

  it('never throws when the trail cannot be written', () => {
    // A path whose parent is a FILE cannot be created as a directory.
    const file = tempFile()
    writeFileSync(file, '', 'utf8')
    const trail = new AuditTrail({ filePath: join(file, 'nested', 'audit.jsonl') })
    expect(() => trail.record({ at: 1, event: 'login', source: 'x' })).not.toThrow()
  })
})

describe('session cookie', () => {
  it('carries the __Host- required attributes', () => {
    const cookie = sessionCookie('tok', 3600)
    expect(cookie.startsWith('__Host-dsh_proxy_session=tok;')).toBe(true)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain('Max-Age=3600')
    // No Domain: __Host- forbids it.
    expect(cookie).not.toContain('Domain=')
  })

  it('clears with Max-Age=0 and reads back out of a Cookie header', () => {
    expect(clearedSessionCookie()).toContain('Max-Age=0')
    expect(readCookie('a=1; __Host-dsh_proxy_session=xyz; b=2', '__Host-dsh_proxy_session')).toBe('xyz')
    expect(readCookie('a=1', '__Host-dsh_proxy_session')).toBeUndefined()
    expect(readCookie(undefined, '__Host-dsh_proxy_session')).toBeUndefined()
  })
})

describe('renderLoginPage', () => {
  const base = { action: '/__dsh-proxy/login', secure: true }

  it('renders a self-contained document with a credential form', () => {
    const html = renderLoginPage(base)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('method="post"')
    expect(html).toContain('action="/__dsh-proxy/login"')
    expect(html).toContain('autocomplete="username"')
    expect(html).toContain('autocomplete="current-password"')
    expect(html).toContain('type="password"')
    expect(html).toContain('name="referrer" content="no-referrer"')
    // No script: the page cannot be broken by injected JavaScript.
    expect(html).not.toContain('<script')
  })

  it('escapes interpolated values and reports cleartext transport', () => {
    const html = renderLoginPage({
      ...base,
      title: '<img src=x onerror=alert(1)>',
      error: 'bad "quotes" & <tags>',
      secure: false,
    })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
    expect(html).toContain('&quot;quotes&quot;')
    expect(html).not.toContain('<tags>')
    // The cleartext warning is shown only when TLS is absent.
    expect(html).toContain('未加密')
    expect(renderLoginPage(base)).not.toContain('未加密')
  })

  it('localizes failures without distinguishing username from password', () => {
    expect(loginFailureMessage('invalid', 0)).toContain('用户名或密码不正确')
    expect(loginFailureMessage('locked', 120_000)).toContain('2 分钟')
    expect(loginFailureMessage('disabled', 0)).toContain('尚未设置密码')
  })
})
