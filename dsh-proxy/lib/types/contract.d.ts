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
export declare const LAN_PROXY_PATH = "/api/dsh-proxy";
/** Endpoint: read the current proxy status. */
export declare const ENDPOINT_STATUS = "status";
/** Endpoint: apply a settings patch and restart the forwarding service. */
export declare const ENDPOINT_UPDATE = "update";
/** Endpoint: start the forwarding service (idempotent). */
export declare const ENDPOINT_START = "start";
/** Endpoint: stop the forwarding service (the response is answered before the listener closes). */
export declare const ENDPOINT_STOP = "stop";
/** Endpoint: list live login sessions, the current lockouts, and the security policy. */
export declare const ENDPOINT_AUTH = "auth";
/** Endpoint: read the recent audit trail. */
export declare const ENDPOINT_AUDIT = "audit";
/** Endpoint: revoke one session, or every session except the caller's. */
export declare const ENDPOINT_AUTH_REVOKE = "auth-revoke";
/** Endpoint: persist the transport policy (`requireTls`). */
export declare const ENDPOINT_SECURITY = "security";
/** Request body the settings section POSTs to {@link LAN_PROXY_PATH}. */
export interface LanProxyRequest {
    /** Channel-owned endpoint name, e.g. `status`. */
    endpoint: string;
    /** Endpoint-owned request payload; `{}` when the endpoint takes none. */
    payload: unknown;
}
/** Carrier-neutral failure envelope returned by every endpoint. */
export interface LanProxyFailure {
    /** Stable machine-readable code. */
    code: string;
    /** Human-readable reason, surfaced by the section. */
    message: string;
    /** Structured detail (validation issues); empty when not applicable. */
    details: object;
}
/**
 * Result envelope shared by every endpoint. Request-level problems (malformed
 * body, unknown endpoint) answer a non-2xx status; endpoint-level failures keep
 * the same shape at HTTP 200 so the section renders them like any other result.
 */
export type LanProxyResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: LanProxyFailure;
};
/** Read-only status the settings section shows. */
export interface LanProxyStatus {
    /** Interface the proxy binds (0.0.0.0 = LAN reachable). */
    listenHost: string;
    /** Port the proxy listens on (the OS-assigned value when 0 was configured). */
    listenPort: number;
    /** Whether the proxy is actually bound (false = bind failed, e.g. port busy). */
    proxyListening: boolean;
    /** Upstream DSH host. */
    upstreamHost: string;
    /** Upstream DSH port the proxy forwards to. */
    upstreamPort: number;
    /** Whether the target upstream service answers a probe. */
    upstreamReachable: boolean;
    /** Login username currently enforced. */
    username: string;
    /**
     * The CURRENT password, so the settings form can pre-fill (write back) the
     * credential fields and empty means "set empty". The endpoint sits on
     * Connection's `/api` channel behind the browser session check, and it is
     * also behind the proxy's own auth gate, so a caller reaching it already
     * holds the same credentials (or is on the host, where the persisted
     * $DSH_HOME file is equally readable).
     */
    password: string;
    /** Whether the auth gate is on (both credentials non-empty). */
    authEnabled: boolean;
    /**
     * Whether the running listener is reachable from the network without a
     * password (see {@link isLanExposed}). The settings section flags this in red
     * and the host logs it loudly at startup; it is a warning, not a blocker —
     * the listener itself is exactly as configured.
     */
    lanExposed: boolean;
    /** Number of live login sessions (0 in the open, password-free state). */
    authSessionCount: number;
    /** Whether a persisted runtime override exists on top of the cordis config. */
    persisted: boolean;
}
/**
 * Whether the proxy is currently reachable from the network WITHOUT a password
 * — the security condition the settings page warns about, and the host logs
 * loudly at startup.
 *
 * Deliberately narrow: it holds only while the listener is actually up, bound
 * to a non-loopback host, with the auth gate off. A loopback-only listener
 * carries no such exposure (the DSH user already sits on this machine) and is
 * not flagged; a service that is merely stopped is not flagged either, since
 * nothing is published until it binds.
 *
 * Pure and shared: the host computes it from its own effective options and the
 * settings section renders from the status it receives, so both halves agree.
 *
 * @param listenHost - the configured bind host.
 * @param proxyListening - whether the listener is currently bound.
 * @param authEnabled - whether password login is on (BOTH credentials set).
 * @returns true when the surface is open to the network.
 */
export declare function isLanExposed(listenHost: string, proxyListening: boolean, authEnabled: boolean): boolean;
/** One live login session as the settings page renders it (never the raw token). */
export interface LanProxySessionView {
    /** Short non-secret id used to address the session for revocation. */
    id: string;
    /** Creation time (ms epoch). */
    createdAt: number;
    /** Last time it was seen (ms epoch). */
    lastSeenAt: number;
    /** Remote address it was created from. */
    source: string;
    /** User-Agent at login (display only). */
    userAgent: string;
    /** Whether this is the session making the current request. */
    current: boolean;
}
/** A source currently locked out by the login throttle. */
export interface LanProxyLockoutView {
    /** Per-client key (remote address). */
    source: string;
    /** Consecutive failures that tripped the lock. */
    failures: number;
    /** How long until the lock lifts (ms). */
    retryAfterMs: number;
}
/** The authentication surface the settings page shows. */
export interface LanProxyAuthView {
    /** Live sessions, most recently used first. */
    sessions: LanProxySessionView[];
    /** Sources locked out right now (a brute-force in progress). */
    lockouts: LanProxyLockoutView[];
    /** Effective policy, so the UI can state the real numbers. */
    policy: {
        /** Absolute session lifetime (ms). */
        sessionTtlMs: number;
        /** Idle timeout (ms). */
        sessionIdleMs: number;
        /** Failures per source before a lockout. */
        maxFailures: number;
        /** Lockout duration (ms). */
        lockoutMs: number;
    };
    /** Whether cleartext is refused outright. */
    requireTls: boolean;
    /** How an allowed cleartext visitor authenticates: the login page, or the native Basic dialog. */
    cleartextAuth: 'login' | 'basic';
    /** Whether the login form is reachable at all (password login on). */
    loginEnabled: boolean;
    /** Reserved path of the login form. */
    loginPath: string;
    /** Reserved path that logs the current session out. */
    logoutPath: string;
}
/** One audit line as the settings page renders it. */
export interface LanProxyAuditView {
    /** When it happened (ms epoch). */
    at: number;
    /** Event name from the auth core. */
    event: string;
    /** Source the event is attributed to. */
    source: string;
    /** Optional detail (never a credential). */
    detail?: string;
}
/** Request payload for {@link ENDPOINT_AUTH_REVOKE}. */
export interface LanProxyRevokePayload {
    /** Session id to revoke, or `all` to revoke every session except the caller's. */
    id: string;
}
/** Request payload for {@link ENDPOINT_SECURITY}; omitted fields are unchanged. */
export interface LanProxySecurityPayload {
    /** New value for the cleartext refusal policy. */
    requireTls?: boolean;
    /**
     * New value for how cleartext traffic authenticates. `login` is the default and
     * unifies the gate; `basic` restores the native dialog for that traffic.
     */
    cleartextAuth?: 'login' | 'basic';
}
/** Settings-section patch: only fields present are changed; omitted fields keep their values. */
export interface LanProxyUpdatePayload {
    /** New proxy listen port (1–65535, must differ from the default service port). */
    listenPort?: number;
    /**
     * Deprecated: new forward target port, kept so legacy persisted configs
     * and scripts still apply. The settings page no longer edits it — the
     * editable port is the proxy's own listen port.
     */
    upstreamPort?: number;
    /** New login username. */
    username?: string;
    /** New login password; an empty string clears it (auth needs a non-empty pair to stay on). */
    password?: string;
}
/** Successful update response. */
export interface LanProxyUpdateResult {
    /** The status after the forwarding service restarted (or stayed stopped). */
    status: LanProxyStatus;
    /**
     * Machine-readable outcome the settings page localizes into the UI language:
     * `saved`/`credentials-partial-saved` mean the service was stopped and was
     * merely saved (no restart); the `*-restarted` variants mean it was running
     * and got restarted; `saved-restart-failed` means a running service failed to
     * rebind and the reason rides in `message`.
     */
    notice: 'saved' | 'saved-restarted' | 'saved-restart-failed' | 'credentials-partial-saved' | 'credentials-partial-restarted';
    /**
     * Deprecated human-readable confirmation (Chinese); kept for scripts. When
     * `notice` is `saved-restart-failed`, this carries the rebind error reason.
     */
    message: string;
}
