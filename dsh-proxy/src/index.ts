/**
 * dsh-proxy host plugin: mounts the authenticated LAN reverse proxy on a
 * second port, forwarding the web app's loopback listener (127.0.0.1:3080 by
 * default) to the LAN with a web-based login gate. The harness deliberately
 * refuses `--host 0.0.0.0` for the web server itself — remote code execution
 * exposure — so this plugin is the sanctioned way to serve the surface beyond
 * loopback, with authentication in front.
 *
 * The plugin also mounts the settings API as an exact `POST /api/dsh-proxy`
 * route on Connection's shared `/api` channel: `status` reads the running
 * proxy, `update` persists a settings patch (target upstream port, username,
 * password) into `$DSH_HOME/dsh-proxy.json` and restarts the forwarding
 * service — the backend of the settings section. Connection owns the carrier,
 * so the route inherits its Host/Origin trust fence and browser session check.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: merges `ctx.webServer` into the Context type.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: merges `ctx.connection` (host Connection Fetch-route registry).
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { ProxyController } from './controller.ts'
import {
  ENDPOINT_START,
  ENDPOINT_STATUS,
  ENDPOINT_STOP,
  ENDPOINT_UPDATE,
  LAN_PROXY_PATH,
  type LanProxyFailure,
  type LanProxyRequest,
  type LanProxyResult,
} from './contract.ts'

// Standalone API for scripts and smoke tests, exercised through the same
// bundled artifact the profile loads.
export { lanAddresses, startLanProxy } from './proxy.ts'
export type { LanProxyHandle, LanProxyOptions } from './proxy.ts'

/** Stable Cordis plugin name (the Loader entry and package name). */
export const name = '@wenxingyu/dsh-proxy'

/** Services required before load: the web server (upstream port source) and the Connection carrier. */
export const inject = ['webServer', 'connection']

/** Plugin configuration, validated at load by the Loader. */
export interface Config {
  /** Interface the proxy binds; 0.0.0.0 exposes the LAN. */
  listenHost: string
  /** Port the proxy listens on (must differ from the web app's port). */
  listenPort: number
  /** Upstream DSH bind host. */
  upstreamHost: string
  /** Upstream DSH port; 0 follows the web app's actual bound port. */
  upstreamPort: number
  /** Login / Basic Auth username; password login is enabled only when both it and `password` are set. */
  username: string
  /** Login / Basic Auth password; password login is enabled only when both it and `username` are set. */
  password: string
}

/** Configuration schema; deployment-varying bounds stay tunable from cordis.yml. */
export const Config = z.object({
  listenHost: z.string().default('0.0.0.0'),
  listenPort: z.natural().max(65535).default(3081),
  upstreamHost: z.string().default('127.0.0.1'),
  upstreamPort: z.natural().max(65535).default(0),
  username: z.string().default(''),
  password: z.string().default(''),
})

/** One endpoint failure in the shared result envelope. */
function failure(message: string): LanProxyResult<never> {
  const error: LanProxyFailure = { code: 'bad-request', message, details: { issues: [] } }
  return { ok: false, error }
}

/**
 * Build the handler mounted at {@link LAN_PROXY_PATH} on Connection's shared
 * `/api` channel. Connection has already applied its Host/Origin fence and the
 * browser session check by the time a request arrives here, so the handler only
 * decodes the plugin's JSON envelope and dispatches one endpoint.
 *
 * A malformed body answers `400`; endpoint-level failures — including an
 * unknown endpoint — answer `200` with the same `{ ok: false }` envelope so the
 * settings section renders them like any other result.
 *
 * @param controller - the proxy controller this route drives.
 * @returns Fetch handler for the plugin's exact route.
 */
export function createLanProxyRoute(controller: ProxyController): (request: Request) => Promise<Response> {
  const dispatch = async (endpoint: string, payload: unknown): Promise<LanProxyResult<unknown>> => {
    if (endpoint === ENDPOINT_STATUS) {
      return { ok: true, value: await controller.refreshStatus() }
    }
    if (endpoint === ENDPOINT_START) {
      const outcome = await controller.start()
      if (!outcome.ok) {
        // The listener did not bind (e.g. the port is taken): answer with the
        // real reason so the settings page reports it instead of claiming the
        // proxy started.
        return failure(outcome.message)
      }
      return { ok: true, value: await controller.refreshStatus() }
    }
    if (endpoint === ENDPOINT_STOP) {
      // Answered before the listener closes so the response survives when the
      // caller is connected through the proxy.
      return { ok: true, value: controller.stopDeferred() }
    }
    if (endpoint === ENDPOINT_UPDATE) {
      const outcome = await controller.update(payload)
      if (outcome.ok) return { ok: true, value: outcome.result }
      return failure(outcome.message)
    }
    return failure(`unknown endpoint ${JSON.stringify(endpoint)}`)
  }

  return async (request) => {
    let body: LanProxyRequest
    try {
      body = (await request.json()) as LanProxyRequest
    } catch {
      return Response.json(failure('body is not JSON'), { status: 400 })
    }
    if (typeof body?.endpoint !== 'string' || body.endpoint.length === 0) {
      return Response.json(failure('body has no endpoint'), { status: 400 })
    }
    const result = await dispatch(body.endpoint, body.payload)
    return Response.json(result)
  }
}

/**
 * Mount the proxy and the settings route as effects on this plugin's fiber:
 * unloading the plugin closes the listener, every upgraded socket, and the
 * route.
 * @param ctx - host cordis context.
 * @param config - validated plugin configuration (schema defaults applied).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = Config(config ?? {})
  const log = (level: 'info' | 'warn' | 'error', message: string): void => {
    ctx.logger[level](message)
  }
  const controller = new ProxyController({
    base: {
      listenHost: resolved.listenHost,
      listenPort: resolved.listenPort,
      upstreamHost: resolved.upstreamHost,
      upstreamPort: resolved.upstreamPort || ctx.webServer.port || 3080,
      username: resolved.username,
      password: resolved.password,
    },
    settingsFile: dshHomePath('dsh-proxy.json'),
    // DSH mints its browser-session cookie only through the tokenized URL it
    // prints at startup, which points at loopback. Rebuild that URL for the
    // authority the browser actually used so a LAN visitor's first index
    // request logs itself in instead of dead-ending on "dsh web
    // authentication required".
    authenticatedUrl: (publicOrigin) => {
      try {
        return ctx.connection.authenticatedUrl(publicOrigin)
      } catch {
        return undefined
      }
    },
    log,
  })

  ctx.effect(
    async () => {
      await controller.start()
      return () => controller.stop()
    },
    'dsh-proxy.proxy',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: LAN_PROXY_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: createLanProxyRoute(controller),
      }),
    'dsh-proxy.settings-route',
  )
}
