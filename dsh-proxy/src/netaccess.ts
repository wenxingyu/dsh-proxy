/**
 * Network and transport classification shared by the proxy gate and its
 * settings surface.
 *
 * Split out because two independent decisions depend on the same facts, and a
 * disagreement between them would be a security bug:
 * - the session cookie's attributes (`__Host-` + `Secure` only where the browser
 *   will actually store them);
 * - whether the request reached us over TLS, which decides if the login page may
 *   collect a password at all.
 *
 * The forwarded-header helpers exist because a proxy in front (the deployment
 * this feature targets) terminates TLS and is the only component that knows the
 * real scheme. Those headers are ATTACKER-CONTROLLED unless the immediate peer
 * is trusted, so every helper here takes that decision as an explicit argument
 * rather than reading the header on its own.
 */

/** A trusted peer for forwarded headers: the reverse proxy in front of us. */
export interface TrustedProxy {
  /** Addresses whose `X-Forwarded-*` headers are believed (empty = trust none). */
  addresses: ReadonlySet<string>
}

/** Hosts that can only be reached from the machine running the proxy. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])

/** Strip brackets and an IPv4-mapped prefix so addresses compare like values. */
function canonical(value: string): string {
  let host = value.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length)
  return host
}

/** Whether an address (host, Host header, or socket peer) denotes this machine. */
export function isLoopbackAddress(value: string): boolean {
  const host = canonical(value)
  if (host === '') return false
  if (LOOPBACK_HOSTS.has(host)) return true
  return /^127\./.test(host)
}

/**
 * Whether the immediate peer may be believed about the original scheme.
 * @param remoteAddress - the socket peer.
 * @param trusted - configured trusted reverse-proxy addresses.
 */
export function isTrustedProxyPeer(remoteAddress: string | undefined, trusted: TrustedProxy): boolean {
  if (remoteAddress === undefined) return false
  const peer = canonical(remoteAddress)
  // Loopback is always trusted: a reverse proxy on the same host is the common
  // deployment, and a remote attacker cannot forge a loopback source address.
  if (isLoopbackAddress(peer)) return true
  for (const candidate of trusted.addresses) {
    if (canonical(candidate) === peer) return true
  }
  return false
}

/**
 * First value of a comma-separated forwarded header.
 * @param header - the raw header value(s).
 */
function firstValue(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (raw === undefined) return undefined
  const first = raw.split(',')[0]?.trim()
  return first === undefined || first === '' ? undefined : first
}

/**
 * Whether this request arrived over TLS.
 *
 * Trusts `X-Forwarded-Proto` only from a trusted peer; otherwise falls back to
 * the socket's own encryption. A direct plain-HTTP request therefore stays
 * plain no matter what it claims in headers.
 *
 * @param input - request facts.
 * @returns true when the browser's connection to the edge was HTTPS.
 */
export function resolveSecureTransport(input: {
  forwardedProto: string | string[] | undefined
  peerTrusted: boolean
  socketEncrypted: boolean
}): boolean {
  if (input.peerTrusted) {
    const proto = firstValue(input.forwardedProto)?.toLowerCase()
    if (proto === 'https') return true
    if (proto === 'http') return false
  }
  return input.socketEncrypted
}

/**
 * The client address to attribute a request to for throttling and auditing.
 *
 * The value is a security input (it keys the lockout), so the forwarded header
 * is read ONLY from a trusted peer; otherwise the socket peer is the answer.
 * The LAST hop in `X-Forwarded-For` is used when the peer is trusted, which is
 * the address the trusted proxy itself observed.
 *
 * @param input - request facts.
 * @returns a stable per-client key (never empty).
 */
export function resolveClientAddress(input: {
  forwardedFor: string | string[] | undefined
  peerAddress: string | undefined
  peerTrusted: boolean
}): string {
  if (input.peerTrusted) {
    const raw = Array.isArray(input.forwardedFor) ? input.forwardedFor.join(',') : input.forwardedFor
    if (raw !== undefined) {
      const hops = raw.split(',').map((hop) => hop.trim()).filter((hop) => hop !== '')
      const last = hops[hops.length - 1]
      if (last !== undefined) return canonical(last)
    }
  }
  return canonical(input.peerAddress ?? '') || 'unknown'
}

/** Cookie name used when the browser will store a `Secure` cookie. */
export const SECURE_COOKIE_NAME = '__Host-dsh_proxy_session'
/** Cookie name used on plain HTTP, where a `Secure` cookie would not be stored. */
export const PLAINTEXT_COOKIE_NAME = 'dsh_proxy_session'

/** How this particular request must be gated. */
export type AuthMode = 'session' | 'basic' | 'plaintext-blocked'

/**
 * Whether a gate can hold a session cookie.
 *
 * Note the distinction this encodes: `secure` means "a `__Host-` + `Secure`
 * cookie will be stored", which is true for TLS and for a loopback browser even
 * on http. A cleartext LAN gate in `session` mode is NOT that, yet it still
 * authenticates by cookie — just a weaker, non-`Secure` one.
 */
export function gateUsesSession(gate: GateDecision): boolean {
  return gate.mode === 'session'
}

/** The resolved gate for one request. */
export interface GateDecision {
  /** Which authentication path applies. */
  mode: AuthMode
  /** Whether the browser connection to the edge was HTTPS. */
  secure: boolean
  /** Cookie name to set/read for this request. */
  cookieName: string
  /** Absolute URL prefix the request arrived on (scheme+authority), for redirects. */
  origin: string
}

/**
 * Resolve how to gate one request.
 *
 * The compatibility rule that matters: a plain-HTTP LAN browser keeps the native
 * Basic Auth dialog it always had, because a `Secure` session cookie would not be
 * stored there and a login page posting a password in the clear would be worse
 * than useless. Session auth therefore applies over TLS (or to a loopback
 * browser, which browsers treat as a secure context), and `requireTls` lets an
 * operator refuse cleartext entirely once a TLS front door exists.
 *
 * @param input - request facts.
 * @returns the gate for this request.
 */
export function resolveGate(input: {
  secure: boolean
  /** Host header (authority the browser used). */
  host: string | undefined
  /** Socket encryption, for the loopback secure-context rule. */
  socketEncrypted: boolean
  /** Operator switch: refuse any cleartext access instead of authenticating it. */
  requireTls: boolean
  /**
   * How an allowed cleartext visitor authenticates: the login page (default,
   * unified) or the historic native Basic dialog. Ignored on a secure context.
   */
  cleartextAuth?: 'login' | 'basic'
}): GateDecision {
  let hostname = ''
  let authority = input.host ?? ''
  try {
    hostname = new URL(`http://${input.host ?? ''}`).hostname
  } catch {
    hostname = ''
  }
  if (authority === '') authority = 'localhost'
  const loopback = isLoopbackAddress(hostname)
  // Browsers treat http://localhost and http://127.0.0.1 as secure contexts, so a
  // `__Host-` + Secure cookie works there even without TLS.
  const secure = input.secure || input.socketEncrypted || loopback
  const scheme = secure ? 'https' : 'http'

  if (secure) {
    return {
      mode: 'session',
      secure: true,
      cookieName: SECURE_COOKIE_NAME,
      origin: `${scheme}://${authority}`,
    }
  }
  if (input.requireTls) {
    return { mode: 'plaintext-blocked', secure: false, cookieName: PLAINTEXT_COOKIE_NAME, origin: `${scheme}://${authority}` }
  }
  // Cleartext, allowed by policy: the login page is the default so the gate is
  // one mechanism everywhere, with the native Basic dialog kept as an explicit
  // alternative for clients that cannot hold a cookie.
  const mode: AuthMode = input.cleartextAuth === 'basic' ? 'basic' : 'session'
  return { mode, secure: false, cookieName: PLAINTEXT_COOKIE_NAME, origin: `${scheme}://${authority}` }
}
