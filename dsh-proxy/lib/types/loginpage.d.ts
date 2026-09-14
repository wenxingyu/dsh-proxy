/**
 * The proxy's own login page.
 *
 * Deliberately a server-rendered, self-contained HTML document with no
 * dependency on DSH's asset pipeline: the visitor is unauthenticated, so the app
 * bundle is exactly what must NOT be reachable yet. One document, one inline
 * stylesheet, one form, no JavaScript — a script-free login form cannot be
 * broken by XSS in the page and needs no CSP allowance beyond the default.
 *
 * Security properties, all enforced elsewhere but relied on here:
 * - the form posts to the proxy's own path with `autocomplete` off for the
 *   username and `current-password` for the password, so a password manager can
 *   fill it without the page ever reading the value;
 * - the response is marked `no-store` and `no-referrer` by the caller, so a
 *   credential-bearing POST is not cached or leaked through a Referer;
 * - the page states the transport it is on: served over cleartext HTTP (no TLS
 *   in front) the caller refuses to accept the submission at all, because a
 *   password posted in the clear is not worth collecting.
 */
/** Everything the page needs to render; no state is read from the request. */
export interface LoginPageOptions {
    /** Overrides the `<title>`/heading when the deployment names its proxy. */
    title?: string;
    /** Human-readable error shown above the form (already localized by the caller). */
    error?: string;
    /** Path the form posts to (the login endpoint). */
    action: string;
    /** Whether the visitor arrived over TLS (a trusted proxy reported https). */
    secure: boolean;
}
/**
 * Render the login document.
 * @param options - title, error and the form target.
 * @returns a complete HTML document as a string.
 */
export declare function renderLoginPage(options: LoginPageOptions): string;
/** Localized failure copy for the login page, keyed by the auth core's reason. */
export declare function loginFailureMessage(reason: 'invalid' | 'locked' | 'disabled', retryAfterMs: number): string;
