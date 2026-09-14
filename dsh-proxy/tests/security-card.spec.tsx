// @vitest-environment jsdom
/**
 * The settings-page security card: it renders the live session list, the
 * lockouts and the audit trail from the host endpoints, and its two actions
 * (revoke, transport policy) call the right endpoint and re-read afterwards.
 */
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SecurityCard, type SecurityCardProps } from '../src/client/SecurityCard.tsx'
import { zh, type LanProxyKey } from '../src/client/locales.ts'
import {
  ENDPOINT_AUDIT,
  ENDPOINT_AUTH,
  ENDPOINT_AUTH_REVOKE,
  ENDPOINT_SECURITY,
  type LanProxyAuditView,
  type LanProxyAuthView,
} from '../src/contract.ts'
import type { LanProxyCall } from '../src/client/transport.ts'

const t = (key: LanProxyKey, params?: Record<string, unknown>): string => {
  const template = zh[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ''))
}

const AUTH: LanProxyAuthView = {
  sessions: [
    { id: 'cur123', createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_100_000, source: '127.0.0.1', userAgent: 'Chrome', current: true },
    { id: 'oth456', createdAt: 1_700_000_000_000, lastSeenAt: 1_700_000_050_000, source: '192.168.1.50', userAgent: 'Safari', current: false },
  ],
  lockouts: [{ source: '10.0.0.9', failures: 5, retryAfterMs: 600_000 }],
  policy: { sessionTtlMs: 7 * 86400000, sessionIdleMs: 12 * 3600000, maxFailures: 5, lockoutMs: 900000 },
  requireTls: false,
  cleartextAuth: 'login',
  loginEnabled: true,
  loginPath: '/__dsh-proxy/login',
  logoutPath: '/__dsh-proxy/logout',
}

const AUDIT: LanProxyAuditView[] = [
  { at: 1_700_000_200_000, event: 'login-failed', source: '10.0.0.9' },
  { at: 1_700_000_100_000, event: 'lockout', source: '10.0.0.9', detail: '5 failures' },
]

/** Build a `call` stub answering the two read endpoints plus the two verbs. */
function makeCall(over: {
  auth?: LanProxyAuthView
  audit?: LanProxyAuditView[]
  security?: unknown
  revoke?: unknown
} = {}): { call: LanProxyCall; calls: Array<{ endpoint: string; payload: unknown }> } {
  const calls: Array<{ endpoint: string; payload: unknown }> = []
  const call = vi.fn((endpoint: string, payload: unknown) => {
    calls.push({ endpoint, payload })
    if (endpoint === ENDPOINT_AUTH) return Promise.resolve({ ok: true, value: over.auth ?? AUTH })
    if (endpoint === ENDPOINT_AUDIT) return Promise.resolve({ ok: true, value: over.audit ?? AUDIT })
    if (endpoint === ENDPOINT_AUTH_REVOKE) {
      return Promise.resolve(over.revoke ?? { ok: true, value: { revoked: 1 } })
    }
    if (endpoint === ENDPOINT_SECURITY) {
      return Promise.resolve(over.security ?? { ok: true, value: { ok: true, requireTls: true, restartRequired: true } })
    }
    return Promise.resolve({ ok: true, value: {} })
  }) as unknown as LanProxyCall
  return { call, calls }
}

function mount(element: ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return { root, container }
}

const props = (call: LanProxyCall): SecurityCardProps => ({ call, t })
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let mounted: { root: Root; container: HTMLDivElement } | null = null

afterEach(() => {
  mounted?.root.unmount()
  mounted = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('SecurityCard', () => {
  it('lists live sessions, marks the current one, and shows the audit trail', async () => {
    const { call } = makeCall()
    mounted = mount(<SecurityCard {...props(call)} />)
    await flush()
    const text = mounted.container.textContent ?? ''
    expect(text).toContain('127.0.0.1')
    expect(text).toContain('192.168.1.50')
    expect(text).toContain(zh['sec.current'])
    expect(text).toContain('10.0.0.9')
    expect(text).toContain('login-failed')
    expect(text).toContain('lockout')
    // The gate state and policy are stated in plain numbers.
    expect(text).toContain(zh['sec.requireTlsOff'])
    expect(text).toContain('7')
  })

  it('revokes one session by id and re-reads the host truth', async () => {
    const { call, calls } = makeCall()
    mounted = mount(<SecurityCard {...props(call)} />)
    await flush()

    const revokeButtons = [...mounted.container.querySelectorAll('button')]
      .filter((button) => button.textContent === zh['sec.revoke'])
    expect(revokeButtons).toHaveLength(2)
    // The second row is the other session; click its revoke.
    flushSync(() => { revokeButtons[1]?.click() })
    await flush()

    const revokeCall = calls.find((entry) => entry.endpoint === ENDPOINT_AUTH_REVOKE)
    expect(revokeCall).toEqual({ endpoint: ENDPOINT_AUTH_REVOKE, payload: { id: 'oth456' } })
    expect(mounted.container.textContent ?? '').toContain(zh['sec.revoked'])
    // Re-read happened: two reads of the auth surface (mount + after revoke).
    expect(calls.filter((entry) => entry.endpoint === ENDPOINT_AUTH).length).toBe(2)
  })

  it('offers "revoke all others" only when another session exists', async () => {
    const solo = { ...AUTH, sessions: [AUTH.sessions[0]!] }
    const { call, calls } = makeCall({ auth: solo })
    mounted = mount(<SecurityCard {...props(call)} />)
    await flush()
    expect(mounted.container.textContent ?? '').not.toContain(zh['sec.revokeAll'])

    mounted.root.unmount()
    const { call: call2, calls: calls2 } = makeCall()
    mounted = mount(<SecurityCard {...props(call2)} />)
    await flush()
    const all = [...mounted.container.querySelectorAll('button')]
      .find((button) => button.textContent === zh['sec.revokeAll'])
    expect(all).toBeDefined()
    flushSync(() => { all?.click() })
    await flush()
    expect(calls2.find((entry) => entry.endpoint === ENDPOINT_AUTH_REVOKE)?.payload).toEqual({ id: 'all' })
    expect(calls.length).toBeGreaterThan(0)
  })

  it('toggles the transport policy and says a restart is needed', async () => {
    const { call, calls } = makeCall()
    mounted = mount(<SecurityCard {...props(call)} />)
    await flush()

    const toggle = [...mounted.container.querySelectorAll('button')]
      .find((button) => button.textContent === zh['sec.enableRequireTls'])
    expect(toggle).toBeDefined()
    flushSync(() => { toggle?.click() })
    await flush()

    expect(calls.find((entry) => entry.endpoint === ENDPOINT_SECURITY)?.payload).toEqual({ requireTls: true })
    const text = mounted.container.textContent ?? ''
    expect(text).toContain(zh['sec.saved'])
    expect(text).toContain(zh['sec.restartHint'])
  })

  it('switches the cleartext authentication mode', async () => {
    const { call, calls } = makeCall()
    mounted = mount(<SecurityCard {...props(call)} />)
    await flush()
    // Default is the unified login page, and the card says the cleartext cookie
    // is the weaker one.
    expect(mounted.container.textContent ?? '').toContain(zh['sec.cleartextLogin'])
    expect(mounted.container.textContent ?? '').toContain(zh['sec.cleartextLoginHint'])

    const toggle = [...mounted.container.querySelectorAll('button')]
      .find((button) => button.textContent === zh['sec.useCleartextBasic'])
    expect(toggle).toBeDefined()
    flushSync(() => { toggle?.click() })
    await flush()
    expect(calls.find((entry) => entry.endpoint === ENDPOINT_SECURITY)?.payload).toEqual({ cleartextAuth: 'basic' })
  })

  it('reports a host rejection without losing the current view', async () => {
    const { call } = makeCall({
      security: { ok: false, error: { code: 'bad-request', message: 'requireTls 必须是布尔值', details: {} } },
    })
    mounted = mount(<SecurityCard {...props(call)} />)
    await flush()
    const toggle = [...mounted.container.querySelectorAll('button')]
      .find((button) => button.textContent === zh['sec.enableRequireTls'])
    flushSync(() => { toggle?.click() })
    await flush()
    const text = mounted.container.textContent ?? ''
    expect(text).toContain('requireTls 必须是布尔值')
    // The session table is still rendered from the last good read.
    expect(text).toContain('192.168.1.50')
  })

  it('shows the empty-state copy when there are no sessions or audit entries', async () => {
    const { call } = makeCall({ auth: { ...AUTH, sessions: [], lockouts: [] }, audit: [] })
    mounted = mount(<SecurityCard {...props(call)} />)
    await flush()
    const text = mounted.container.textContent ?? ''
    expect(text).toContain(zh['sec.noSessions'])
    expect(text).toContain(zh['sec.noAudit'])
  })
})
