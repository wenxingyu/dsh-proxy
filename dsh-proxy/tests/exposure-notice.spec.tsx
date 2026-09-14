// @vitest-environment jsdom
/**
 * The frame-wide LAN-exposure popup: it fires on EVERY page load while the proxy
 * is open to the network without a password, stays silent in every other state,
 * and keeps no memory of having been dismissed — a security warning must not be
 * silenceable once and gone.
 *
 * The status read is exercised through the real `callLanProxy` transport with a
 * stubbed global `fetch`, so the component's own wiring is covered too.
 */
import type { ReactElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LanExposureNotice,
  decideExposure,
  resetExposureCheckForTest,
  type LanExposureNoticeProps,
} from '../src/client/LanExposureNotice.tsx'
import { zh, type LanProxyKey } from '../src/client/locales.ts'
import { cssText } from '../src/client/styles.ts'
import type { LanProxyStatus } from '../src/contract.ts'

const t = (key: LanProxyKey, params?: Record<string, unknown>): string => {
  const template = zh[key] ?? key
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name] ?? ''))
}

const STATUS: LanProxyStatus = {
  listenHost: '0.0.0.0',
  listenPort: 3081,
  proxyListening: true,
  upstreamHost: '127.0.0.1',
  upstreamPort: 3080,
  upstreamReachable: true,
  username: '',
  password: '',
  authEnabled: false,
  lanExposed: true,
  persisted: false,
}

const props = (): LanExposureNoticeProps => ({ t }) as LanExposureNoticeProps

function mount(element: ReactElement): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => { root.render(element) })
  return { root, container }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Answer the transport's status POST with one status (or a transport failure). */
function stubStatus(status: LanProxyStatus | null): void {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (status === null) throw new Error('transport down')
    return new Response(JSON.stringify({ ok: true, value: status }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }))
}

let mounted: { root: Root; container: HTMLDivElement } | null = null

beforeEach(() => {
  resetExposureCheckForTest()
  window.localStorage.clear()
  document.body.innerHTML = ''
})

afterEach(() => {
  mounted?.root.unmount()
  mounted = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('decideExposure', () => {
  it('is silent while the proxy is not exposed', () => {
    expect(decideExposure(null)).toEqual({ kind: 'silent' })
    expect(decideExposure({ ...STATUS, lanExposed: false })).toEqual({ kind: 'silent' })
  })

  it('shows the popup whenever the status says the surface is open', () => {
    expect(decideExposure(STATUS)).toEqual({ kind: 'show' })
    // No "already seen" input exists: the decision cannot become silent just
    // because the user dismissed an earlier popup.
    expect(decideExposure(STATUS)).toEqual({ kind: 'show' })
  })
})

describe('LanExposureNotice', () => {
  it('renders nothing while password login is on', async () => {
    stubStatus({ ...STATUS, authEnabled: true, lanExposed: false })
    mounted = mount(<LanExposureNotice {...props()} />)
    await flush()
    expect(mounted.container.querySelector('.dsh_lanproxy_notice')).toBeNull()
  })

  it('renders nothing when the status read fails', async () => {
    stubStatus(null)
    mounted = mount(<LanExposureNotice {...props()} />)
    await flush()
    expect(mounted.container.querySelector('.dsh_lanproxy_notice')).toBeNull()
  })

  it('shows the warning with the exposed address, and dismisses for this page only', async () => {
    stubStatus(STATUS)
    mounted = mount(<LanExposureNotice {...props()} />)
    await flush()

    const notice = mounted.container.querySelector('.dsh_lanproxy_notice')
    expect(notice).not.toBeNull()
    expect(notice?.getAttribute('role')).toBe('alert')
    const text = notice?.textContent ?? ''
    expect(text).toContain(zh['notice.title'])
    expect(text).toContain('0.0.0.0:3081')
    expect(text).toContain('没有设置密码登录')

    const dismiss = mounted.container.querySelector('.dsh_lanproxy_noticeButton') as HTMLButtonElement
    expect(dismiss.textContent).toBe(zh['notice.dismiss'])
    flushSync(() => { dismiss.click() })
    expect(mounted.container.querySelector('.dsh_lanproxy_notice')).toBeNull()
  })

  it('warns again on the NEXT page load, however many times it was dismissed', async () => {
    stubStatus(STATUS)

    // Three consecutive page loads (each one is a fresh module state) — the
    // notice must come back every time while the exposure lasts.
    for (let load = 1; load <= 3; load++) {
      resetExposureCheckForTest()
      mounted = mount(<LanExposureNotice {...props()} />)
      await flush()
      expect(mounted.container.querySelector('.dsh_lanproxy_notice'), `load ${load}`).not.toBeNull()
      const dismiss = mounted.container.querySelector('.dsh_lanproxy_noticeButton') as HTMLButtonElement
      flushSync(() => { dismiss.click() })
      mounted.root.unmount()
      mounted = null
    }
  })

  it('persists NOTHING about the dismissal (no localStorage key can mute it)', async () => {
    stubStatus(STATUS)
    mounted = mount(<LanExposureNotice {...props()} />)
    await flush()
    const dismiss = mounted.container.querySelector('.dsh_lanproxy_noticeButton') as HTMLButtonElement
    flushSync(() => { dismiss.click() })
    // A remembered acknowledgement is exactly what made the warning vanish
    // permanently before; nothing may be written to storage.
    expect(Object.keys(window.localStorage)).toEqual([])
  })

  it('checks the status only once per page load', async () => {
    stubStatus(STATUS)
    mounted = mount(<LanExposureNotice {...props()} />)
    await flush()
    mounted.root.unmount()

    // Remounting inside the same page load (the frame remounts) must not re-ask.
    mounted = mount(<LanExposureNotice {...props()} />)
    await flush()
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})

describe('notice styling contract', () => {
  /**
   * The first cut styled the dismiss button with the theme's `label-primary`
   * text over a hand-picked dark background. That label resolves to BLACK in the
   * light theme, so the button rendered black-on-black until hovered. The fix
   * pairs the accent FILL with `fg-on-accent` (the same pair the settings page's
   * primary button already uses), and this guard keeps it that way.
   */
  it('pairs the dismiss button fill with the on-accent foreground', () => {
    const block = /\.dsh_lanproxy_noticeButton\s*\{([^}]*)\}/.exec(cssText)?.[1] ?? ''
    expect(block).not.toBe('')
    expect(block).toContain('background: var(--dsw-alias-accent')
    expect(block).toContain('color: var(--dsw-alias-fg-on-accent')
    // The theme-dependent label token must not style text over a fixed fill.
    expect(block).not.toContain('color: var(--dsw-alias-label-primary')
  })

  it('keeps the notice card in the theme surface and label colors', () => {
    const card = /\.dsh_lanproxy_notice\s*\{([^}]*)\}/.exec(cssText)?.[1] ?? ''
    expect(card).toContain('background: color-mix(')
    expect(card).toContain('color: var(--dsw-alias-label-primary')
    // The title must not be tinted with a state color (legibility in light theme).
    const title = /\.dsh_lanproxy_noticeTitle\s*\{([^}]*)\}/.exec(cssText)?.[1] ?? ''
    expect(title).toContain('color: var(--dsw-alias-label-primary')
  })
})
