/**
 * `registerRpcChannel` compatibility contract: the documented
 * `connection.rpc.handle` shorthand is preferred, and the harness 0.1.5-rc.x
 * `webServer` resolution failure falls back to the registry's `register` with
 * this plugin's own context as owner. Every other failure is rethrown.
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { registerRpcChannel } from '../src/index.ts'

const handler: ConnectionRpcHandler = async () => ({ ok: true, value: null })

/** Fake host context: `connection.rpc.handle` plus an optional raw `register`. */
function fakeCtx(overrides: {
  handle?: (channel: string, handler: ConnectionRpcHandler, options: unknown) => () => Promise<void>
  register?: (owner: unknown, channel: string, handler: ConnectionRpcHandler, options: unknown) => () => void
}): Context {
  return { connection: { rpc: { handle: overrides.handle }, register: overrides.register } } as unknown as Context
}

describe('registerRpcChannel', () => {
  it('uses the documented rpc.handle shorthand when it works', () => {
    const dispose = async (): Promise<void> => {}
    const handle = vi.fn(() => dispose)
    const register = vi.fn(() => () => {})
    const channel = registerRpcChannel(fakeCtx({ handle, register }), '/dsh-proxy', handler)

    expect(handle).toHaveBeenCalledWith('/dsh-proxy', handler, { authority: 'loopback' })
    expect(register).not.toHaveBeenCalled()
    channel()
  })

  it('falls back to register owned by the caller on the harness webServer failure', () => {
    const handle = vi.fn(() => {
      throw new Error('cannot get property "webServer" without inject')
    })
    const register = vi.fn(() => () => {})
    const ctx = fakeCtx({ handle, register })
    const channel = registerRpcChannel(ctx, '/dsh-proxy', handler)

    expect(handle).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(ctx, '/dsh-proxy', handler, { authority: 'loopback' })
    channel()
  })

  it('rethrows unrelated registration failures instead of retrying', () => {
    const handle = vi.fn(() => {
      throw new Error('connection: channel "/dsh-proxy" is already registered')
    })
    const register = vi.fn(() => () => {})
    expect(() => registerRpcChannel(fakeCtx({ handle, register }), '/dsh-proxy', handler)).toThrow(
      /already registered/,
    )
    expect(register).not.toHaveBeenCalled()
  })

  it('rethrows the webServer failure when the registry exposes no register', () => {
    const handle = vi.fn(() => {
      throw new Error('cannot get property "webServer" without inject')
    })
    expect(() => registerRpcChannel(fakeCtx({ handle }), '/dsh-proxy', handler)).toThrow(/webServer/)
  })
})
