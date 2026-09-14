/**
 * Browser-side transport for the settings section: one POST to the exact
 * `/api/dsh-proxy` route the host mounts on Connection's shared `/api` channel.
 *
 * Connection owns the carrier — request trust, the browser session check, and
 * the `/api` HTTP bridge — so this module only speaks the plugin's own small
 * JSON envelope and never throws at the caller: every transport failure comes
 * back as a rendered `LanProxyResult` failure, exactly like an endpoint error.
 */
import { type LanProxyAuditView, type LanProxyAuthView, type LanProxyResult } from '../contract.ts';
/** Call one settings endpoint and resolve its result envelope. */
export type LanProxyCall = <T>(endpoint: string, payload: unknown) => Promise<LanProxyResult<T>>;
/** Read the login/session surface the security card renders. */
export declare function fetchAuthView(call: LanProxyCall): Promise<LanProxyAuthView | null>;
/** Read the recent audit trail (newest first, as the host returns it). */
export declare function fetchAudit(call: LanProxyCall): Promise<LanProxyAuditView[]>;
/** POST one endpoint to the host route and decode its result envelope. */
export declare const callLanProxy: LanProxyCall;
