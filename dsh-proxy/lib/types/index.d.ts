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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { ProxyController } from './controller.ts';
export { lanAddresses, startLanProxy } from './proxy.ts';
export type { LanProxyHandle, LanProxyOptions } from './proxy.ts';
/** Stable Cordis plugin name (the Loader entry and package name). */
export declare const name = "@wenxingyu/dsh-proxy";
/** Services required before load: the web server (upstream port source) and the Connection carrier. */
export declare const inject: string[];
/** Plugin configuration, validated at load by the Loader. */
export interface Config {
    /** Interface the proxy binds; 0.0.0.0 exposes the LAN. */
    listenHost: string;
    /** Port the proxy listens on (must differ from the web app's port). */
    listenPort: number;
    /** Upstream DSH bind host. */
    upstreamHost: string;
    /** Upstream DSH port; 0 follows the web app's actual bound port. */
    upstreamPort: number;
    /** Login / Basic Auth username; password login is enabled only when both it and `password` are set. */
    username: string;
    /** Login / Basic Auth password; password login is enabled only when both it and `username` are set. */
    password: string;
}
/** Configuration schema; deployment-varying bounds stay tunable from cordis.yml. */
export declare const Config: z<Schemastery.ObjectS<{
    listenHost: z<string, string>;
    listenPort: z<number, number>;
    upstreamHost: z<string, string>;
    upstreamPort: z<number, number>;
    username: z<string, string>;
    password: z<string, string>;
}>, Schemastery.ObjectT<{
    listenHost: z<string, string>;
    listenPort: z<number, number>;
    upstreamHost: z<string, string>;
    upstreamPort: z<number, number>;
    username: z<string, string>;
    password: z<string, string>;
}>>;
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
export declare function createLanProxyRoute(controller: ProxyController): (request: Request) => Promise<Response>;
/**
 * Mount the proxy and the settings route as effects on this plugin's fiber:
 * unloading the plugin closes the listener, every upgraded socket, and the
 * route.
 * @param ctx - host cordis context.
 * @param config - validated plugin configuration (schema defaults applied).
 */
export declare function apply(ctx: Context, config?: Config): void;
