import { AuthState, type AuditEntry } from './auth.ts';
export interface LanProxyOptions {
    /** Interface the proxy binds (0.0.0.0 for LAN access). */
    listenHost: string;
    /** Port the proxy listens on; 0 asks the OS for a free port. */
    listenPort: number;
    /** Upstream DSH bind host, normally the loopback address. */
    upstreamHost: string;
    /** Upstream DSH port (the web app's actual bound port). */
    upstreamPort: number;
    /** Basic Auth username; password login is enabled only when both it and `password` are set. */
    username: string;
    /** Basic Auth password; password login is enabled only when both it and `username` are set. */
    password: string;
    /**
     * Build the host's launch-token URL for one public origin (the origin the
     * BROWSER used, e.g. `http://192.168.1.20:3081`).
     *
     * DSH answers the index with 401 until the browser holds its per-process
     * session cookie, and the cookie is only minted by opening the tokenized URL
     * `dsh web` prints — a loopback address a LAN visitor cannot use. When this
     * hook is provided, an unauthenticated index request is redirected through
     * the token exchange for the caller's own origin, so the LAN URL logs itself
     * in. Omit it when the host offers no launch-token source to pass the
     * upstream 401 through unchanged.
     */
    authenticatedUrl?: (publicOrigin: string) => string | undefined;
    /**
     * Session store for the login page. When present, a request that arrived over
     * TLS (or from a loopback browser) is gated by a session cookie and served the
     * login form; a plain-HTTP LAN request keeps the native Basic Auth dialog, so
     * the long-standing LAN workflow is unchanged.
     */
    auth?: AuthState;
    /** Addresses whose `X-Forwarded-*` headers are believed (the TLS-terminating proxy in front). */
    trustedProxyAddresses?: readonly string[];
    /**
     * Refuse cleartext altogether instead of authenticating it. Off by default:
     * the LAN-over-HTTP deployment is a supported configuration.
     */
    requireTls?: boolean;
    /**
     * How an allowed cleartext visitor authenticates. Defaults to the login page so
     * the gate is one mechanism everywhere; `basic` keeps the native dialog.
     */
    cleartextAuth?: 'login' | 'basic';
    /** Heading/title of the login page. */
    loginTitle?: string;
    /** Sink for gate events the session store does not own (e.g. a refused cleartext request). */
    audit?: (entry: AuditEntry) => void;
    /** Optional sink for human-readable lifecycle messages. */
    log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}
export interface LanProxyHandle {
    /** Resolves with the bound port once listening; rejects on bind errors. */
    ready: Promise<number>;
    /** Close the listener and every upgraded socket. */
    close: () => Promise<void>;
    /** Human-readable access URLs (local + LAN) for the configured port. */
    describeUrls: (boundPort: number) => {
        local: string;
        lan: string[];
    };
}
/** GET serves the form; POST submits credentials. */
export declare const LOGIN_PATH = "/__dsh-proxy/login";
/** Clears the session cookie and returns to the form. */
export declare const LOGOUT_PATH = "/__dsh-proxy/logout";
/** LAN IPv4 addresses the host currently has, as http URLs on `port`. */
export declare function lanAddresses(port: number): string[];
export declare function startLanProxy(options: LanProxyOptions): LanProxyHandle;
