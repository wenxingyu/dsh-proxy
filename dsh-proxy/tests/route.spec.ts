/**
 * The host settings route: `createLanProxyRoute` decodes the plugin's JSON
 * envelope, dispatches one endpoint onto the proxy controller, and answers the
 * shared result envelope. Connection has already applied its trust/auth fence
 * by the time the handler runs, so these tests drive the handler directly.
 */
import { describe, expect, it, vi } from 'vitest'
import { createLanProxyRoute } from '../src/index.ts'
import { ProxyController } from '../src/controller.ts'
import {
  ENDPOINT_START,
  ENDPOINT_STATUS,
  ENDPOINT_STOP,
  ENDPOINT_UPDATE,
  type LanProxyResult,
  type LanProxyStatus,
  type LanProxyUpdateResult,
} from '../src/contract.ts'

const STATUS: LanProxyStatus = {
  listenHost: '0.0.0.0',
  listenPort: 3081,
  proxyListening: true,
  upstreamHost: '127.0.0.1',
  upstreamPort: 3080,
  upstreamReachable: true,
  username: 'admin',
  password: 's3cret',
  authEnabled: true,
  persisted: false,
}

const UPDATE: LanProxyUpdateResult = { status: STATUS, notice: 'saved-restarted', message: '已保存并重启转发服务' }

/** Structural stand-in for the controller; only the four routed methods are used. */
function fakeController(over: {
  start?: () => Promise<{ ok: true } | { ok: false; message: string }>
  update?: (payload: unknown) => Promise<{ ok: true; result: LanProxyUpdateResult } | { ok: false; message: string }>
} = {}): ProxyController {
  return {
    refreshStatus: vi.fn(async () => STATUS),
    start: vi.fn(over.start ?? (async () => ({ ok: true }) as const)),
    stopDeferred: vi.fn(() => STATUS),
    update: vi.fn(over.update ?? (async () => ({ ok: true, result: UPDATE }) as const)),
  } as unknown as ProxyController
}

/** POST one envelope to the route and decode the JSON answer. */
async function post(
  controller: ProxyController,
  body: unknown,
): Promise<{ status: number; result: LanProxyResult<unknown> }> {
  const fetchRoute = createLanProxyRoute(controller)
  const response = await fetchRoute(
    new Request('http://127.0.0.1:3080/api/dsh-proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
  return { status: response.status, result: (await response.json()) as LanProxyResult<unknown> }
}

describe('createLanProxyRoute', () => {
  it('answers the status endpoint with the controller status', async () => {
    const controller = fakeController()
    const { status, result } = await post(controller, { endpoint: ENDPOINT_STATUS, payload: {} })
    expect(status).toBe(200)
    expect(result).toEqual({ ok: true, value: STATUS })
    expect(controller.refreshStatus).toHaveBeenCalledTimes(1)
  })

  it('answers the update endpoint with the update result', async () => {
    const update = vi.fn(async () => ({ ok: true, result: UPDATE }) as const)
    const { status, result } = await post(fakeController({ update }), {
      endpoint: ENDPOINT_UPDATE,
      payload: { listenPort: 3091 },
    })
    expect(status).toBe(200)
    expect(result).toEqual({ ok: true, value: UPDATE })
    expect(update).toHaveBeenCalledWith({ listenPort: 3091 })
  })

  it('reports an update rejection as a bad-request failure at HTTP 200', async () => {
    const controller = fakeController({ update: async () => ({ ok: false, message: '端口被占用' }) })
    const { status, result } = await post(controller, { endpoint: ENDPOINT_UPDATE, payload: {} })
    expect(status).toBe(200)
    expect(result).toEqual({
      ok: false,
      error: { code: 'bad-request', message: '端口被占用', details: { issues: [] } },
    })
  })

  it('reports a failed start bind with the real reason instead of a status', async () => {
    const controller = fakeController({ start: async () => ({ ok: false, message: 'EADDRINUSE' }) })
    const { result } = await post(controller, { endpoint: ENDPOINT_START, payload: {} })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.message).toBe('EADDRINUSE')
    expect(controller.refreshStatus).not.toHaveBeenCalled()
  })

  it('answers a successful start with the refreshed status', async () => {
    const { result } = await post(fakeController(), { endpoint: ENDPOINT_START, payload: {} })
    expect(result).toEqual({ ok: true, value: STATUS })
  })

  it('answers the stop endpoint with the pre-computed status', async () => {
    const controller = fakeController()
    const { result } = await post(controller, { endpoint: ENDPOINT_STOP, payload: {} })
    expect(result).toEqual({ ok: true, value: STATUS })
    expect(controller.stopDeferred).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown endpoint without touching the controller', async () => {
    const controller = fakeController()
    const { status, result } = await post(controller, { endpoint: 'nope', payload: {} })
    expect(status).toBe(200)
    expect(result.ok).toBe(false)
    expect(controller.refreshStatus).not.toHaveBeenCalled()
  })

  it('rejects a non-JSON body with HTTP 400', async () => {
    const { status, result } = await post(fakeController(), 'not json')
    expect(status).toBe(400)
    expect(result.ok).toBe(false)
  })

  it('rejects a body without an endpoint with HTTP 400', async () => {
    const { status, result } = await post(fakeController(), { payload: {} })
    expect(status).toBe(400)
    expect(result.ok).toBe(false)
  })
})
