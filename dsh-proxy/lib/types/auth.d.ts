/** Session lifetime and throttling policy; every field is tunable from config. */
export interface AuthPolicy {
    /** Absolute session lifetime in ms (a session dies this long after login). */
    sessionTtlMs: number;
    /** Idle timeout in ms (a session dies this long after its last request). */
    sessionIdleMs: number;
    /** Failed logins from one source before it is locked out. */
    maxFailures: number;
    /** How long a source stays locked once it trips {@link maxFailures}. */
    lockoutMs: number;
    /** Minimum delay applied to every failed attempt, to slow scripted guessing. */
    failureDelayMs: number;
}
/** Defaults chosen to be tolerable for a human and expensive for a script. */
export declare const DEFAULT_AUTH_POLICY: AuthPolicy;
/** One live login session. */
export interface AuthSession {
    /** Opaque token id (never the credential); the cookie carries this. */
    token: string;
    /** Creation time (ms epoch). */
    createdAt: number;
    /** Last time the session was seen (ms epoch), for the idle timeout. */
    lastSeenAt: number;
    /** Remote address the session was created from, for display and auditing. */
    source: string;
    /** User-Agent at login, for display (truncated; never trusted for authz). */
    userAgent: string;
}
/** A session projected for the settings UI (no token: it is a bearer secret). */
export interface AuthSessionView {
    /** Short, non-reversible id for addressing this session in the UI. */
    id: string;
    createdAt: number;
    lastSeenAt: number;
    source: string;
    userAgent: string;
    /** Whether this is the session making the current request. */
    current: boolean;
}
/** One audit-trail entry. */
export interface AuditEntry {
    /** When it happened (ms epoch). */
    at: number;
    /** What happened. */
    event: 'login' | 'login-failed' | 'login-throttled' | 'login-origin-withheld' | 'logout' | 'logout-all' | 'session-revoked' | 'locked-out' | 'insecure-transport-refused';
    /** Source key the event is attributed to (remote address). */
    source: string;
    /** Optional human-readable detail (never a credential). */
    detail?: string;
}
/** A stable, non-secret id for a token, safe to show in the settings UI. */
export declare function sessionIdOf(token: string): string;
/** Compare a candidate password against the configured one. */
export declare function verifyCredentials(candidate: {
    username: string;
    password: string;
}, expected: {
    username: string;
    password: string;
}): boolean;
/**
 * Server-side authentication state: live sessions, per-source throttling and
 * the audit trail.
 *
 * Deliberately in-memory: sessions are "you are logged in to this running
 * proxy", and a restart drops them, which is the safe default. The audit trail
 * is appended to the caller's sink so it can outlive the process.
 */
export declare class AuthState {
    private readonly sessions;
    private readonly failures;
    private readonly policy;
    private readonly now;
    private readonly auditSink;
    constructor(options?: {
        policy?: Partial<AuthPolicy>;
        /** Clock injection for tests; defaults to `Date.now`. */
        now?: () => number;
        /** Audit sink; the plugin persists entries to disk. */
        audit?: (entry: AuditEntry) => void;
    });
    /** The effective policy (the settings UI reports the relevant knobs). */
    get authPolicy(): AuthPolicy;
    /** Append one audit entry and hand it to the sink. */
    private audit;
    /** Drop expired sessions; called opportunistically on every check. */
    private sweep;
    /**
     * Whether one source is currently locked out.
     * @param source - the per-client key (remote address).
     */
    lockedFor(source: string): {
        locked: boolean;
        retryAfterMs: number;
    };
    /**
     * Attempt a login.
     *
     * The failure path is uniform: a wrong username, a wrong password and a
     * disabled login all produce the same result, and the lockout counter is keyed
     * by source rather than by username so it cannot be used to enumerate accounts.
     *
     * @param input - candidate credentials plus the request's provenance.
     * @returns the new session, a lockout notice, or a plain failure.
     */
    login(input: {
        username: string;
        password: string;
        source: string;
        userAgent?: string;
        /** Configured credential pair; an incomplete pair disables login entirely. */
        expected: {
            username: string;
            password: string;
        };
    }): {
        ok: true;
        session: AuthSession;
    } | {
        ok: false;
        reason: 'locked' | 'invalid' | 'disabled';
        retryAfterMs: number;
    };
    /**
     * Validate a session cookie and refresh its idle timer.
     * @param token - the cookie value, when present.
     * @returns the live session, or null when there is none.
     */
    authenticate(token: string | undefined): AuthSession | null;
    /** Every live session, projected for the settings UI (optionally marking the caller's). */
    listSessions(currentToken?: string): AuthSessionView[];
    /**
     * Revoke one session by its public id.
     * @param id - the id from {@link listSessions}.
     * @returns whether a session was revoked.
     */
    revokeSession(id: string): boolean;
    /** Revoke every session except the caller's (or all of them). */
    revokeAllSessions(keepToken?: string): number;
    /**
     * End the caller's own session.
     * @param token - the session cookie value.
     */
    logout(token: string | undefined): void;
    /**
     * Sources that are locked out right now, newest lock first.
     *
     * Exposed so an operator can see a brute-force attempt in progress and, in
     * particular, tell whether it is one noisy device or many — the audit trail
     * answers "what happened", this answers "what is happening".
     */
    lockedSources(): Array<{
        source: string;
        failures: number;
        retryAfterMs: number;
    }>;
    /** Number of live sessions (used by tests and the status surface). */
    get sessionCount(): number;
}
/**
 * The cookie name for the session.
 *
 * `__Host-` is a browser-enforced prefix: the cookie is only accepted with
 * `Secure`, `Path=/` and no `Domain`, which blocks a sibling subdomain from
 * planting or overwriting it. Browsers treat `http://localhost` as a secure
 * context, so local testing keeps working.
 */
export declare const SESSION_COOKIE = "__Host-dsh_proxy_session";
/**
 * Serialise the session cookie.
 *
 * `name` selects the variant: the default `__Host-` name requires `Secure`, so a
 * cleartext deployment (where a `Secure` cookie is never stored) uses
 * {@link PLAINTEXT_COOKIE_NAME} instead. That cookie is weaker — no `__Host-`
 * prefix means a sibling host can overwrite it, and a same-LAN attacker can plant
 * one — which is why the cleartext login mode is a deliberate operator choice and
 * the settings page says so.
 */
export declare function sessionCookie(token: string, maxAgeSeconds: number, name?: string): string;
/** Serialise the cookie that clears the session. */
export declare function clearedSessionCookie(name?: string): string;
/** Read one cookie value out of a `Cookie` header. */
export declare function readCookie(header: string | undefined, name: string): string | undefined;
