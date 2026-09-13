/**
 * Shared wire contract between the host plugin and its settings section: the
 * exact Fetch route the host mounts on Connection's shared `/api` channel, the
 * endpoint names carried in the request body, and the status/update payload
 * shapes. Imported by both halves (type-only on the client side — erased at
 * build).
 */

/**
 * Exact POST route the host plugin owns on Connection's shared `/api` channel.
 * Connection's own `/api` carrier applies the Host/Origin trust fence and the
 * browser session check before dispatching here, so the section only has to be
 * an authenticated same-origin caller.
 */
export const LAN_PROXY_PATH = '/api/dsh-proxy'
/** Endpoint: read the current proxy status. */
export const ENDPOINT_STATUS = 'status'
/** Endpoint: apply a settings patch and restart the forwarding service. */
export const ENDPOINT_UPDATE = 'update'
/** Endpoint: start the forwarding service (idempotent). */
export const ENDPOINT_START = 'start'
/** Endpoint: stop the forwarding service (the response is answered before the listener closes). */
export const ENDPOINT_STOP = 'stop'

/** Request body the settings section POSTs to {@link LAN_PROXY_PATH}. */
export interface LanProxyRequest {
  /** Channel-owned endpoint name, e.g. `status`. */
  endpoint: string
  /** Endpoint-owned request payload; `{}` when the endpoint takes none. */
  payload: unknown
}

/** Carrier-neutral failure envelope returned by every endpoint. */
export interface LanProxyFailure {
  /** Stable machine-readable code. */
  code: string
  /** Human-readable reason, surfaced by the section. */
  message: string
  /** Structured detail (validation issues); empty when not applicable. */
  details: object
}

/**
 * Result envelope shared by every endpoint. Request-level problems (malformed
 * body, unknown endpoint) answer a non-2xx status; endpoint-level failures keep
 * the same shape at HTTP 200 so the section renders them like any other result.
 */
export type LanProxyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: LanProxyFailure }

/** Read-only status the settings section shows. */
export interface LanProxyStatus {
  /** Interface the proxy binds (0.0.0.0 = LAN reachable). */
  listenHost: string
  /** Port the proxy listens on (the OS-assigned value when 0 was configured). */
  listenPort: number
  /** Whether the proxy is actually bound (false = bind failed, e.g. port busy). */
  proxyListening: boolean
  /** Upstream DSH host. */
  upstreamHost: string
  /** Upstream DSH port the proxy forwards to. */
  upstreamPort: number
  /** Whether the target upstream service answers a probe. */
  upstreamReachable: boolean
  /** Login username currently enforced. */
  username: string
  /**
   * The CURRENT password, so the settings form can pre-fill (write back) the
   * credential fields and empty means "set empty". The endpoint sits on
   * Connection's `/api` channel behind the browser session check, and it is
   * also behind the proxy's own auth gate, so a caller reaching it already
   * holds the same credentials (or is on the host, where the persisted
   * $DSH_HOME file is equally readable).
   */
  password: string
  /** Whether the auth gate is on (both credentials non-empty). */
  authEnabled: boolean
  /** Whether a persisted runtime override exists on top of the cordis config. */
  persisted: boolean
}

/** Settings-section patch: only fields present are changed; omitted fields keep their values. */
export interface LanProxyUpdatePayload {
  /** New proxy listen port (1–65535, must differ from the default service port). */
  listenPort?: number
  /**
   * Deprecated: new forward target port, kept so legacy persisted configs
   * and scripts still apply. The settings page no longer edits it — the
   * editable port is the proxy's own listen port.
   */
  upstreamPort?: number
  /** New login username. */
  username?: string
  /** New login password; an empty string clears it (auth needs a non-empty pair to stay on). */
  password?: string
}

/** Successful update response. */
export interface LanProxyUpdateResult {
  /** The status after the forwarding service restarted (or stayed stopped). */
  status: LanProxyStatus
  /**
   * Machine-readable outcome the settings page localizes into the UI language:
   * `saved`/`credentials-partial-saved` mean the service was stopped and was
   * merely saved (no restart); the `*-restarted` variants mean it was running
   * and got restarted; `saved-restart-failed` means a running service failed to
   * rebind and the reason rides in `message`.
   */
  notice:
    | 'saved'
    | 'saved-restarted'
    | 'saved-restart-failed'
    | 'credentials-partial-saved'
    | 'credentials-partial-restarted'
  /**
   * Deprecated human-readable confirmation (Chinese); kept for scripts. When
   * `notice` is `saved-restart-failed`, this carries the rebind error reason.
   */
  message: string
}
