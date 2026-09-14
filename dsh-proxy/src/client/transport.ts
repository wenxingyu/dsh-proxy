/**
 * Browser-side transport for the settings section: one POST to the exact
 * `/api/dsh-proxy` route the host mounts on Connection's shared `/api` channel.
 *
 * Connection owns the carrier — request trust, the browser session check, and
 * the `/api` HTTP bridge — so this module only speaks the plugin's own small
 * JSON envelope and never throws at the caller: every transport failure comes
 * back as a rendered `LanProxyResult` failure, exactly like an endpoint error.
 */
import {
  ENDPOINT_AUDIT,
  ENDPOINT_AUTH,
  LAN_PROXY_PATH,
  type LanProxyAuditView,
  type LanProxyAuthView,
  type LanProxyRequest,
  type LanProxyResult,
} from '../contract.ts'

/** Call one settings endpoint and resolve its result envelope. */
export type LanProxyCall = <T>(endpoint: string, payload: unknown) => Promise<LanProxyResult<T>>

/** Stable failure code for a request that never produced a plugin-level answer. */
const TRANSPORT_FAILURE = 'transport'

/** Render one carrier-level rejection as a failure envelope. */
function carrierFailure(message: string, details: object = {}): LanProxyResult<never> {
  return { ok: false, error: { code: TRANSPORT_FAILURE, message, details } }
}

/**
 * Decode a response body as a result envelope.
 * @param response - the answer to read.
 * @returns the envelope, or null when the body is not one.
 */
async function readEnvelope(response: Response): Promise<LanProxyResult<never> | null> {
  try {
    const body = (await response.json()) as unknown
    if (typeof body === 'object' && body !== null && typeof (body as { ok?: unknown }).ok === 'boolean') {
      return body as LanProxyResult<never>
    }
    return null
  } catch {
    return null
  }
}

/** Read the login/session surface the security card renders. */
export async function fetchAuthView(call: LanProxyCall): Promise<LanProxyAuthView | null> {
  const result = await call<LanProxyAuthView>(ENDPOINT_AUTH, {})
  return result.ok ? (result.value as LanProxyAuthView) : null
}

/** Read the recent audit trail (newest first, as the host returns it). */
export async function fetchAudit(call: LanProxyCall): Promise<LanProxyAuditView[]> {
  const result = await call<LanProxyAuditView[]>(ENDPOINT_AUDIT, {})
  return result.ok ? (result.value as LanProxyAuditView[]) : []
}

/** POST one endpoint to the host route and decode its result envelope. */
export const callLanProxy: LanProxyCall = async (endpoint, payload) => {
  const body: LanProxyRequest = { endpoint, payload: payload ?? {} }
  let response: Response
  try {
    response = await fetch(LAN_PROXY_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    return carrierFailure(error instanceof Error ? error.message : String(error))
  }
  // A non-2xx answer may still carry the plugin's own failure envelope (the
  // host answers 400 for a malformed request); prefer that over the bare status.
  const envelope = await readEnvelope(response)
  if (envelope !== null) return envelope
  if (!response.ok) {
    const detail = response.statusText.length > 0 ? `${response.status} ${response.statusText}` : String(response.status)
    return carrierFailure(detail, { status: response.status })
  }
  return carrierFailure('response body is not a result envelope')
}
