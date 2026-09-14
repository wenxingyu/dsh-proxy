/**
 * Authentication core for the LAN proxy's login page: server-side sessions,
 * per-source login throttling, and an append-only audit trail.
 *
 * Why this exists next to Basic Auth: the browser's Basic dialog sends the same
 * reusable credential on every request and caches it for the origin, so there is
 * no logout, no expiry and no revocation — changing the password is the only
 * "sign out". A server-held session token fixes all three, and it is also what
 * makes online brute-force protection and an audit trail possible.
 *
 * Scope and honesty: this module does NOT provide transport security. Tokens and
 * passwords are only as safe as the channel, so the deployment is expected to be
 * terminated by TLS (a reverse proxy in front of this listener, or a VPN). Over
 * plain HTTP this login page would be no better than Basic Auth, just dressed
 * differently — the HTTP layer refuses to accept credentials over cleartext for
 * exactly that reason.
 *
 * Pure logic on purpose: no node:http, no fs. The HTTP layer passes in a clock
 * and a source key, and persists the audit trail; everything here is directly
 * unit-testable without a socket.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Session lifetime and throttling policy; every field is tunable from config. */
export interface AuthPolicy {
  /** Absolute session lifetime in ms (a session dies this long after login). */
  sessionTtlMs: number
  /** Idle timeout in ms (a session dies this long after its last request). */
  sessionIdleMs: number
  /** Failed logins from one source before it is locked out. */
  maxFailures: number
  /** How long a source stays locked once it trips {@link maxFailures}. */
  lockoutMs: number
  /** Minimum delay applied to every failed attempt, to slow scripted guessing. */
  failureDelayMs: number
}

/** Defaults chosen to be tolerable for a human and expensive for a script. */
export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  sessionIdleMs: 12 * 60 * 60 * 1000,
  maxFailures: 5,
  lockoutMs: 15 * 60 * 1000,
  failureDelayMs: 250,
}

/** One live login session. */
export interface AuthSession {
  /** Opaque token id (never the credential); the cookie carries this. */
  token: string
  /** Creation time (ms epoch). */
  createdAt: number
  /** Last time the session was seen (ms epoch), for the idle timeout. */
  lastSeenAt: number
  /** Remote address the session was created from, for display and auditing. */
  source: string
  /** User-Agent at login, for display (truncated; never trusted for authz). */
  userAgent: string
}

/** A session projected for the settings UI (no token: it is a bearer secret). */
export interface AuthSessionView {
  /** Short, non-reversible id for addressing this session in the UI. */
  id: string
  createdAt: number
  lastSeenAt: number
  source: string
  userAgent: string
  /** Whether this is the session making the current request. */
  current: boolean
}

/** One audit-trail entry. */
export interface AuditEntry {
  /** When it happened (ms epoch). */
  at: number
  /** What happened. */
  event:
    | 'login'
    | 'login-failed'
    | 'login-throttled'
    | 'login-origin-withheld'
    | 'logout'
    | 'logout-all'
    | 'session-revoked'
    | 'locked-out'
    | 'insecure-transport-refused'
  /** Source key the event is attributed to (remote address). */
  source: string
  /** Optional human-readable detail (never a credential). */
  detail?: string
}

/** A stable, non-secret id for a token, safe to show in the settings UI. */
export function sessionIdOf(token: string): string {
  // Not a security boundary — the token itself is the bearer secret — but it
  // keeps the raw token out of the UI, logs and RPC payloads.
  return Buffer.from(token).toString('base64url').slice(0, 12)
}

/** Constant-time equality for two strings of possibly different length. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** Compare a candidate password against the configured one. */
export function verifyCredentials(
  candidate: { username: string; password: string },
  expected: { username: string; password: string },
): boolean {
  // Both halves are compared even when the username already mismatched, so the
  // timing does not reveal which field was wrong.
  const userOk = safeEqual(candidate.username, expected.username)
  const passOk = safeEqual(candidate.password, expected.password)
  return userOk && passOk
}

/** Per-source failure accounting used by the throttle. */
interface FailureRecord {
  failures: number
  lockedUntil: number
}

/**
 * Server-side authentication state: live sessions, per-source throttling and
 * the audit trail.
 *
 * Deliberately in-memory: sessions are "you are logged in to this running
 * proxy", and a restart drops them, which is the safe default. The audit trail
 * is appended to the caller's sink so it can outlive the process.
 */
export class AuthState {
  private readonly sessions = new Map<string, AuthSession>()
  private readonly failures = new Map<string, FailureRecord>()
  private readonly policy: AuthPolicy
  private readonly now: () => number
  private readonly auditSink: (entry: AuditEntry) => void

  constructor(options: {
    policy?: Partial<AuthPolicy>
    /** Clock injection for tests; defaults to `Date.now`. */
    now?: () => number
    /** Audit sink; the plugin persists entries to disk. */
    audit?: (entry: AuditEntry) => void
  } = {}) {
    this.policy = { ...DEFAULT_AUTH_POLICY, ...options.policy }
    this.now = options.now ?? (() => Date.now())
    this.auditSink = options.audit ?? (() => {})
  }

  /** The effective policy (the settings UI reports the relevant knobs). */
  get authPolicy(): AuthPolicy {
    return { ...this.policy }
  }

  /** Append one audit entry and hand it to the sink. */
  private audit(entry: AuditEntry): void {
    this.auditSink(entry)
  }

  /** Drop expired sessions; called opportunistically on every check. */
  private sweep(now: number): void {
    for (const [token, session] of this.sessions) {
      const absoluteExpired = now - session.createdAt >= this.policy.sessionTtlMs
      const idleExpired = now - session.lastSeenAt >= this.policy.sessionIdleMs
      if (absoluteExpired || idleExpired) this.sessions.delete(token)
    }
  }

  /**
   * Whether one source is currently locked out.
   * @param source - the per-client key (remote address).
   */
  lockedFor(source: string): { locked: boolean; retryAfterMs: number } {
    const record = this.failures.get(source)
    if (record === undefined) return { locked: false, retryAfterMs: 0 }
    const now = this.now()
    if (record.lockedUntil > now) return { locked: true, retryAfterMs: record.lockedUntil - now }
    // The lock expired: fresh start, so a past lock cannot accumulate forever.
    if (record.failures >= this.policy.maxFailures) this.failures.delete(source)
    return { locked: false, retryAfterMs: 0 }
  }

  /**
   * Attempt a login.
   *
   * The failure path is uniform: a wrong username, a wrong password and a
   * disabled login all produce the same result, and the lockout counter is keyed
   * by source rather than by username so it cannot be used to enumerate accounts.
   *
   * @param input - candidate credentials plus the request's provenance.
   * @returns the new session, a lockout notice, or a plain failure.
   */
  login(input: {
    username: string
    password: string
    source: string
    userAgent?: string
    /** Configured credential pair; an incomplete pair disables login entirely. */
    expected: { username: string; password: string }
  }): { ok: true; session: AuthSession } | { ok: false; reason: 'locked' | 'invalid' | 'disabled'; retryAfterMs: number } {
    const now = this.now()
    const lock = this.lockedFor(input.source)
    if (lock.locked) {
      this.audit({ at: now, event: 'login-throttled', source: input.source, detail: 'locked out' })
      return { ok: false, reason: 'locked', retryAfterMs: lock.retryAfterMs }
    }

    const enabled = input.expected.username !== '' && input.expected.password !== ''
    if (!enabled || !verifyCredentials(
      { username: input.username, password: input.password },
      input.expected,
    )) {
      const record = this.failures.get(input.source) ?? { failures: 0, lockedUntil: 0 }
      record.failures += 1
      if (record.failures >= this.policy.maxFailures) {
        record.lockedUntil = now + this.policy.lockoutMs
        this.audit({ at: now, event: 'locked-out', source: input.source, detail: `${record.failures} failures` })
      }
      this.failures.set(input.source, record)
      this.audit({ at: now, event: 'login-failed', source: input.source })
      return {
        ok: false,
        reason: enabled ? 'invalid' : 'disabled',
        retryAfterMs: record.lockedUntil > now ? record.lockedUntil - now : 0,
      }
    }

    // Success clears the source's failure history.
    this.failures.delete(input.source)
    const session: AuthSession = {
      token: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      source: input.source,
      userAgent: (input.userAgent ?? '').slice(0, 200),
    }
    this.sessions.set(session.token, session)
    this.audit({ at: now, event: 'login', source: input.source })
    return { ok: true, session }
  }

  /**
   * Validate a session cookie and refresh its idle timer.
   * @param token - the cookie value, when present.
   * @returns the live session, or null when there is none.
   */
  authenticate(token: string | undefined): AuthSession | null {
    if (token === undefined || token === '') return null
    const now = this.now()
    this.sweep(now)
    const session = this.sessions.get(token)
    if (session === undefined) return null
    session.lastSeenAt = now
    return session
  }

  /** Every live session, projected for the settings UI (optionally marking the caller's). */
  listSessions(currentToken?: string): AuthSessionView[] {
    const now = this.now()
    this.sweep(now)
    const currentId = currentToken === undefined ? null : sessionIdOf(currentToken)
    return [...this.sessions.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((session) => ({
        id: sessionIdOf(session.token),
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        source: session.source,
        userAgent: session.userAgent,
        current: currentId !== null && sessionIdOf(session.token) === currentId,
      }))
  }

  /**
   * Revoke one session by its public id.
   * @param id - the id from {@link listSessions}.
   * @returns whether a session was revoked.
   */
  revokeSession(id: string): boolean {
    for (const [token, session] of this.sessions) {
      if (sessionIdOf(token) === id) {
        this.sessions.delete(token)
        this.audit({ at: this.now(), event: 'session-revoked', source: session.source, detail: id })
        return true
      }
    }
    return false
  }

  /** Revoke every session except the caller's (or all of them). */
  revokeAllSessions(keepToken?: string): number {
    const now = this.now()
    let revoked = 0
    for (const [token, session] of this.sessions) {
      if (keepToken !== undefined && token === keepToken) continue
      this.sessions.delete(token)
      revoked += 1
      this.audit({ at: now, event: 'logout-all', source: session.source })
    }
    return revoked
  }

  /**
   * End the caller's own session.
   * @param token - the session cookie value.
   */
  logout(token: string | undefined): void {
    if (token === undefined) return
    const session = this.sessions.get(token)
    if (session === undefined) return
    this.sessions.delete(token)
    this.audit({ at: this.now(), event: 'logout', source: session.source })
  }

  /**
   * Sources that are locked out right now, newest lock first.
   *
   * Exposed so an operator can see a brute-force attempt in progress and, in
   * particular, tell whether it is one noisy device or many — the audit trail
   * answers "what happened", this answers "what is happening".
   */
  lockedSources(): Array<{ source: string; failures: number; retryAfterMs: number }> {
    const now = this.now()
    const out: Array<{ source: string; failures: number; retryAfterMs: number }> = []
    for (const [source, record] of this.failures) {
      if (record.lockedUntil <= now) continue
      out.push({ source, failures: record.failures, retryAfterMs: record.lockedUntil - now })
    }
    return out.sort((a, b) => b.retryAfterMs - a.retryAfterMs)
  }

  /** Number of live sessions (used by tests and the status surface). */
  get sessionCount(): number {
    this.sweep(this.now())
    return this.sessions.size
  }
}

/**
 * The cookie name for the session.
 *
 * `__Host-` is a browser-enforced prefix: the cookie is only accepted with
 * `Secure`, `Path=/` and no `Domain`, which blocks a sibling subdomain from
 * planting or overwriting it. Browsers treat `http://localhost` as a secure
 * context, so local testing keeps working.
 */
export const SESSION_COOKIE = '__Host-dsh_proxy_session'

/**
 * Serialise the session cookie.
 *
 * `name` selects the variant: the default `__Host-` name requires `Secure`, so a
 * cleartext deployment (where a `Secure` cookie is never stored) uses
 * {@link PLAINTEXT_COOKIE_NAME} instead. That cookie is weaker — no `__Host-`
 * prefix means a sibling host can overwrite it, and a same-LAN attacker can plant
 * one — which is why the cleartext login mode is a deliberate operator choice and
 * the settings page says so.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, name: string = SESSION_COOKIE): string {
  const secure = name === SESSION_COOKIE ? '; Secure' : ''
  return `${name}=${token}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
}

/** Serialise the cookie that clears the session. */
export function clearedSessionCookie(name: string = SESSION_COOKIE): string {
  const secure = name === SESSION_COOKIE ? '; Secure' : ''
  return `${name}=; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=0`
}

/** Read one cookie value out of a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return part.slice(eq + 1).trim()
  }
  return undefined
}
