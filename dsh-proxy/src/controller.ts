/**
 * ProxyController: owns the lifecycle of the LAN proxy inside the harness —
 * effective options (cordis config overlaid with the persisted runtime
 * settings), start/stop/restart, and the status/update verbs the settings
 * page calls. No cordis dependency: the plugin entry in index.ts wires it
 * into the harness, which keeps every business rule unit-testable against a
 * real in-process upstream.
 */
import { lanAddresses, startLanProxy, type LanProxyHandle } from './proxy.ts'
import { RuntimeSettingsFile, normalizeRuntimeSettings, validateUpdate } from './settings.ts'
import { AuthState, type AuthPolicy } from './auth.ts'
import { AuditTrail } from './audit.ts'
import {
  DEFAULT_SECURITY_SETTINGS,
  SecuritySettingsFile,
  isCleartextAuthMode,
  type CleartextAuthMode,
  type SecuritySettings,
} from './security.ts'
import { LOGIN_PATH, LOGOUT_PATH } from './proxy.ts'
import { isLoopbackAddress } from './netaccess.ts'
import {
  isLanExposed,
  type LanProxyAuditView,
  type LanProxyAuthView,
  type LanProxySecurityPayload,
  type LanProxyStatus,
  type LanProxyUpdatePayload,
  type LanProxyUpdateResult,
} from './contract.ts'

/** The fully-resolved runtime options of one proxy instance. */
export interface EffectiveProxyOptions {
  listenHost: string
  listenPort: number
  upstreamHost: string
  upstreamPort: number
  username: string
  password: string
}

export interface ProxyControllerOptions {
  /** Options from the cordis config (schema defaults applied, upstream port resolved). */
  base: EffectiveProxyOptions
  /** Path of the persisted runtime-settings JSON. */
  settingsFile: string
  /**
   * Host hook building DSH's launch-token URL for a public origin, so a LAN
   * visitor's first index request can log itself in (see
   * {@link LanProxyOptions.authenticatedUrl}). Absent when the host has none.
   */
  authenticatedUrl?: (publicOrigin: string) => string | undefined
  /**
   * Path of the persisted audit trail. The login gate records failures and
   * session lifecycle there; omit it to keep the trail in memory only.
   */
  auditFile?: string
  /** Session/throttle policy for the login gate (defaults to {@link DEFAULT_AUTH_POLICY}). */
  authPolicy?: Partial<AuthPolicy>
  /** Addresses whose forwarded headers are believed (the TLS proxy in front). */
  trustedProxyAddresses?: readonly string[]
  /** Refuse cleartext instead of falling back to Basic Auth (default false = LAN-over-HTTP supported). */
  requireTls?: boolean
  /** Path of the persisted transport policy (`requireTls`), so the switch survives a restart. */
  securityFile?: string
  /** Login page title/heading. */
  loginTitle?: string
  /** Log sink (the plugin passes ctx.logger-based printer). */
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export type UpdateOutcome =
  | { ok: true; result: LanProxyUpdateResult }
  | { ok: false; message: string }

/** Result of one start attempt: a failed bind reports the reason instead of passing silently. */
export type StartOutcome =
  | { ok: true }
  | { ok: false; message: string }

/** Upstream reachability probe: connection timeout. */
const PROBE_TIMEOUT_MS = 1500
/** Upstream reachability probe: result cache lifetime. */
const PROBE_CACHE_MS = 3000

export class ProxyController {
  private handle: LanProxyHandle | null = null
  private boundPort: number | null = null
  private probeCache: { at: number; reachable: boolean } | null = null
  private readonly settings: RuntimeSettingsFile
  private readonly log: ProxyControllerOptions['log']
  private options: EffectiveProxyOptions
  /** Login-gate sessions; deliberately in-memory so a restart drops them. */
  private readonly auth: AuthState
  /** Durable audit trail (absent when no path was configured). */
  private readonly audit: AuditTrail | null
  /** Persisted transport policy (`requireTls`); absent when no path was configured. */
  private readonly security: SecuritySettingsFile | null
  /** Effective transport policy, kept in sync with the file. */
  private securitySettings: SecuritySettings

  constructor(private readonly opts: ProxyControllerOptions) {
    this.log = opts.log
    this.settings = new RuntimeSettingsFile(opts.settingsFile)
    this.audit = opts.auditFile === undefined ? null : new AuditTrail({ filePath: opts.auditFile })
    this.security = opts.securityFile === undefined ? null : new SecuritySettingsFile(opts.securityFile)
    this.securitySettings = this.security?.read() ?? { ...DEFAULT_SECURITY_SETTINGS }
    this.auth = new AuthState({
      ...(opts.authPolicy === undefined ? {} : { policy: opts.authPolicy }),
      audit: (entry) => this.audit?.record(entry),
    })
    this.options = { ...opts.base }
    const persisted = this.settings.read()
    if (persisted.listenPort !== undefined) this.options.listenPort = persisted.listenPort
    if (persisted.upstreamPort !== undefined) this.options.upstreamPort = persisted.upstreamPort
    if (persisted.username !== undefined) this.options.username = persisted.username
    if (persisted.password !== undefined) this.options.password = persisted.password
  }

  /** Whether a persisted runtime override exists (drives the status flag). */
  private persisted(): boolean {
    const current = this.settings.read()
    return current.listenPort !== undefined
      || current.upstreamPort !== undefined
      || current.username !== undefined
      || current.password !== undefined
  }

  /**
   * Start the proxy (idempotent). Listen errors — the port is already taken by
   * another dsh-proxy instance, say — are logged loudly and reported through
   * the outcome (never thrown), so a failed forwarder can never take down the
   * web app boot while callers still learn why the listener is down.
   */
  async start(): Promise<StartOutcome> {
    if (this.handle !== null) return { ok: true }
    const log = this.log
    const handle = startLanProxy({
      listenHost: this.options.listenHost,
      listenPort: this.options.listenPort,
      upstreamHost: this.options.upstreamHost,
      upstreamPort: this.options.upstreamPort,
      username: this.options.username,
      password: this.options.password,
      auth: this.auth,
      ...(this.opts.trustedProxyAddresses === undefined ? {} : { trustedProxyAddresses: this.opts.trustedProxyAddresses }),
      requireTls: this.requireTls(),
      cleartextAuth: this.cleartextAuth(),
      ...(this.opts.loginTitle === undefined ? {} : { loginTitle: this.opts.loginTitle }),
      audit: (entry) => this.audit?.record(entry),
      ...(this.opts.authenticatedUrl === undefined ? {} : { authenticatedUrl: this.opts.authenticatedUrl }),
      log,
    })
    this.handle = handle
    try {
      const bound = await handle.ready
      this.boundPort = bound
      const urls = handle.describeUrls(bound)
      log('info', `dsh-proxy: listening on ${this.options.listenHost}:${bound} -> http://${this.options.upstreamHost}:${this.options.upstreamPort}`)
      log('info', `dsh-proxy: 本机访问 ${urls.local}`)
      for (const url of urls.lan) log('info', `dsh-proxy: 局域网访问 ${url}`)
      if (this.options.username !== '' && this.options.password !== '') {
        log('info', `dsh-proxy: password login enabled (username: ${this.options.username})`)
        if (!this.requireTls() && this.cleartextAuth() === 'login' && !isLoopbackAddress(this.options.listenHost)) {
          // Be explicit about the weaker cookie rather than letting an operator
          // assume cleartext sessions are equivalent to TLS ones.
          log('warn', 'dsh-proxy: 明文登录已启用/SECURITY NOTE — cleartext visitors get a session cookie WITHOUT Secure/__Host- (a Secure cookie is not stored over http); anyone on the same network can sniff or plant it. Put a TLS reverse proxy in front, or set cleartextAuth to "basic" / requireTls to true.')
        }
      } else {
        // The listener stays exactly as configured (a reachable port still
        // challenges with Basic Auth the moment credentials are set), but an
        // unauthenticated LAN surface is stated loudly and unambiguously: this
        // proxy hands its clients the privileged DSH RPC surface behind the
        // loopback Host rewrite.
        const lanUrls = urls.lan.length > 0
          ? urls.lan.join('  ')
          : `http://${this.options.listenHost}:${bound}`
        const reason = this.options.username !== '' || this.options.password !== ''
          ? 'only one of username/password is set, so password login is OFF'
          : 'username and password are both empty, so password login is OFF'
        log('warn', `dsh-proxy: 安全提示/SECURITY WARNING — ${reason}; anyone who can reach ${lanUrls} gets full access to DSH (HTTP + WebSocket, including privileged /api RPC) WITHOUT a password. Set BOTH a username and a password in DSH settings → LAN Proxy, or bind listenHost to 127.0.0.1.`)
      }
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('error', `dsh-proxy: failed to listen on ${this.options.listenHost}:${this.options.listenPort}: ${message} — stop any other dsh-proxy on this port, or change listenPort`)
      this.handle = null
      return {
        ok: false,
        message: `无法监听 ${this.options.listenHost}:${this.options.listenPort}：${message}。该端口可能已被占用，请更换代理服务端口或释放该端口后重试。`,
      }
    }
  }

  /**
   * Effective transport policy: the persisted override wins, then the cordis
   * config, then the compatible default (cleartext allowed).
   */
  private requireTls(): boolean {
    if (this.security !== null) return this.securitySettings.requireTls
    return this.opts.requireTls ?? false
  }

  /** Authentication mode currently in force for allowed cleartext traffic. */
  private cleartextAuth(): CleartextAuthMode {
    return this.securitySettings.cleartextAuth
  }

  /** The authentication surface for the settings page. */
  authView(currentToken?: string): LanProxyAuthView {
    return {
      sessions: this.auth.listSessions(currentToken),
      lockouts: this.auth.lockedSources(),
      policy: this.auth.authPolicy,
      requireTls: this.requireTls(),
      cleartextAuth: this.cleartextAuth(),
      loginEnabled: this.options.username !== '' && this.options.password !== '',
      loginPath: LOGIN_PATH,
      logoutPath: LOGOUT_PATH,
    }
  }

  /** Recent audit entries, newest first (what an operator would want on screen). */
  auditView(): LanProxyAuditView[] {
    const entries = this.audit?.list() ?? []
    return [...entries].reverse().map(({ at, event, source, detail }) => ({
      at,
      event,
      source,
      ...(detail === undefined ? {} : { detail }),
    }))
  }

  /**
   * Revoke one session, or every session except the caller's.
   * @param payload - `{ id }` from the settings page; `all` keeps the caller.
   * @param currentToken - the caller's own session token, so it is never dropped by `all`.
   * @returns how many sessions were revoked.
   */
  revokeSessions(payload: unknown, currentToken?: string): { revoked: number } {
    const id = (payload as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id === '') return { revoked: 0 }
    if (id === 'all') return { revoked: this.auth.revokeAllSessions(currentToken) }
    return { revoked: this.auth.revokeSession(id) ? 1 : 0 }
  }

  /**
   * Persist the transport policy. A change takes effect on the next restart, so
   * this reports whether a restart is needed instead of silently not applying it.
   * @param payload - the requested `requireTls`.
   */
  updateSecurity(payload: unknown): {
    ok: true
    requireTls: boolean
    cleartextAuth: CleartextAuthMode
    restartRequired: boolean
  } | { ok: false; message: string } {
    const input = payload as Partial<LanProxySecurityPayload> | null
    if (input === null || typeof input !== 'object') return { ok: false, message: '请求体必须是对象' }
    const next: SecuritySettings = { ...this.securitySettings }
    if (input.requireTls !== undefined) {
      if (typeof input.requireTls !== 'boolean') return { ok: false, message: 'requireTls 必须是布尔值' }
      next.requireTls = input.requireTls
    }
    if (input.cleartextAuth !== undefined) {
      if (!isCleartextAuthMode(input.cleartextAuth)) {
        return { ok: false, message: "cleartextAuth 只能是 'login' 或 'basic'" }
      }
      next.cleartextAuth = input.cleartextAuth
    }
    if (input.requireTls === undefined && input.cleartextAuth === undefined) {
      return { ok: false, message: '没有可保存的修改' }
    }
    const changed = next.requireTls !== this.requireTls()
      || next.cleartextAuth !== this.securitySettings.cleartextAuth
    this.securitySettings = next
    this.security?.write(next)
    this.log('info', `dsh-proxy: transport policy updated (requireTls=${String(next.requireTls)}, cleartextAuth=${next.cleartextAuth})`)
    return {
      ok: true,
      requireTls: next.requireTls,
      cleartextAuth: next.cleartextAuth,
      restartRequired: changed,
    }
  }

  /** Stop the proxy and every upgraded socket. */
  async stop(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.boundPort = null
    if (handle !== null) await handle.close()
  }

  /** Stop and start again with the current effective options (the "restart the forwarding service" verb). */
  async restart(): Promise<StartOutcome> {
    await this.stop()
    return this.start()
  }

  /**
   * Stop the proxy AFTER the caller's response has flushed back. The stop RPC
   * answer travels through the proxy itself when the settings page is reached
   * via the LAN URL, so closing the listener before the response is written
   * would drop it; the listener is torn down shortly afterwards instead.
   * @param delayMs - grace before the listener closes (defaults to 300ms).
   * @returns the status as it will be once stopped.
   */
  stopDeferred(delayMs = 300): LanProxyStatus {
    const stopped: LanProxyStatus = { ...this.status(), proxyListening: false }
    const timer = setTimeout(() => {
      void this.stop()
    }, delayMs)
    timer.unref?.()
    return stopped
  }

  /**
   * Current read-only status for the settings page. `upstreamReachable`
   * reflects the most recent probe (false until the first probe runs).
   */
  status(): LanProxyStatus {
    const authEnabled = this.options.username !== '' && this.options.password !== ''
    return {
      listenHost: this.options.listenHost,
      listenPort: this.boundPort ?? this.options.listenPort,
      proxyListening: this.boundPort !== null,
      upstreamHost: this.options.upstreamHost,
      upstreamPort: this.options.upstreamPort,
      upstreamReachable: this.probeCache?.reachable ?? false,
      username: this.options.username,
      password: this.options.password,
      authEnabled,
      // The settings page warns in red about this one; the rule lives in the
      // shared contract so the host and the section can never disagree.
      lanExposed: isLanExposed(this.options.listenHost, this.boundPort !== null, authEnabled),
      authSessionCount: this.auth.sessionCount,
      persisted: this.persisted(),
    }
  }

  /**
   * Status with a fresh upstream reachability probe (cached for a few
   * seconds so repeated settings-page loads do not hammer the target).
   */
  async refreshStatus(): Promise<LanProxyStatus> {
    await this.probeUpstream()
    return this.status()
  }

  /**
   * Probe whether the target upstream service answers HTTP. Any response —
   * even an error status — counts as reachable; only connection failures and
   * timeouts turn the light red.
   */
  private async probeUpstream(): Promise<boolean> {
    const now = Date.now()
    if (this.probeCache !== null && now - this.probeCache.at < PROBE_CACHE_MS) {
      return this.probeCache.reachable
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    let reachable = false
    try {
      const res = await fetch(
        `http://${this.options.upstreamHost}:${this.options.upstreamPort}/favicon.svg`,
        { signal: controller.signal, redirect: 'manual' },
      )
      reachable = true
      await res.body?.cancel().catch(() => {})
    } catch {
      reachable = false
    } finally {
      clearTimeout(timer)
    }
    this.probeCache = { at: now, reachable }
    return reachable
  }

  /**
   * Apply an update payload: validate, persist, then restart the forwarding
   * service with the new effective options.
   * @param payload - raw RPC payload from the settings page.
   * @returns the new status, or a user-facing rejection message.
   */
  async update(payload: unknown): Promise<UpdateOutcome> {
    // Validate against the actually bound port: with listenPort 0 the OS
    // assigns the port, and the configured 0 must never be the comparison.
    const check = validateUpdate(
      payload,
      this.boundPort ?? this.options.listenPort,
      this.options.upstreamPort,
    )
    if (!check.ok) return { ok: false, message: check.message }
    const patch = check.patch as LanProxyUpdatePayload

    const next: LanProxyUpdatePayload = { ...this.settings.read(), ...patch }
    this.settings.write(next)

    if (patch.listenPort !== undefined) this.options.listenPort = patch.listenPort
    if (patch.upstreamPort !== undefined) this.options.upstreamPort = patch.upstreamPort
    if (patch.username !== undefined) this.options.username = patch.username
    if (patch.password !== undefined) this.options.password = patch.password

    // A running service must restart to pick up the new effective options; a
    // stopped service is just saved and stays stopped (starting it is the
    // explicit start control's job).
    const wasListening = this.boundPort !== null
    const startOutcome = wasListening ? await this.restart() : null
    this.probeCache = null
    this.log('info', `dsh-proxy: settings updated via the settings page; forwarding service ${startOutcome === null ? 'kept stopped' : startOutcome.ok ? 'restarted' : 'restart FAILED'}`)
    const bothSet = this.options.username !== '' && this.options.password !== ''
    const anySet = this.options.username !== '' || this.options.password !== ''
    const partial = anySet && !bothSet

    if (startOutcome !== null && !startOutcome.ok) {
      return {
        ok: true,
        result: {
          status: await this.refreshStatus(),
          notice: 'saved-restart-failed',
          message: startOutcome.message,
        },
      }
    }
    const notice: 'saved' | 'saved-restarted' | 'credentials-partial-saved' | 'credentials-partial-restarted'
      = startOutcome === null
        ? (partial ? 'credentials-partial-saved' : 'saved')
        : (partial ? 'credentials-partial-restarted' : 'saved-restarted')
    return {
      ok: true,
      result: {
        status: await this.refreshStatus(),
        notice,
        message: startOutcome === null
          ? (partial ? '已保存（注意：需同时设置用户名和密码才会启用密码登录）' : '已保存')
          : (partial ? '已保存并重启转发服务（注意：需同时设置用户名和密码才会启用密码登录）' : '已保存并重启转发服务'),
      },
    }
  }
}
