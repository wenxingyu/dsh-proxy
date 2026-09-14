/**
 * The settings-page security card: what the login gate is doing right now.
 *
 * It answers three operator questions in one place — is the gate on, who is
 * currently signed in, and has anyone been trying to break in — because those are
 * exactly the facts a Basic Auth deployment could never show. Everything it
 * displays comes from the host endpoints (`auth`, `audit`, `auth-revoke`,
 * `security`); the card owns no state the host does not.
 *
 * Failure policy: a failed read renders an inline error with a retry, never a
 * throw, matching the rest of the section. A failed ACTION (revoke, policy
 * toggle) reports the host's reason and leaves the previous view in place.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ENDPOINT_AUTH_REVOKE,
  ENDPOINT_SECURITY,
  type LanProxyAuditView,
  type LanProxyAuthView,
} from '../contract.ts'
import type { LanProxyKey } from './locales.ts'
import { fetchAudit, fetchAuthView, type LanProxyCall } from './transport.ts'

/** The `t` seat this card uses (a slice of the section's props). */
type Translate = (key: LanProxyKey, params?: Record<string, unknown>) => string

export interface SecurityCardProps {
  /** Caller for this plugin's own `/api` route. */
  call: LanProxyCall
  /** Translate function of the `dsh-proxy` namespace. */
  t: Translate
}

/** Render a millisecond duration as a short human string. */
function minutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60000))
}

/** Render a timestamp as a locale string, tolerating a clock skew of zero. */
function stamp(at: number): string {
  try {
    return new Date(at).toLocaleString()
  } catch {
    return String(at)
  }
}

/**
 * Render the security card.
 * @param props - the endpoint caller and `t`.
 */
export function SecurityCard({ call, t }: SecurityCardProps): ReactNode {
  const [auth, setAuth] = useState<LanProxyAuthView | null>(null)
  const [audit, setAudit] = useState<LanProxyAuditView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Load both views; a partial failure still renders whatever answered. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const [nextAuth, nextAudit] = await Promise.all([fetchAuthView(call), fetchAudit(call)])
      setAuth(nextAuth)
      setAudit(nextAudit)
      if (nextAuth === null) setError(t('sec.failed'))
    } catch (err) {
      setError(`${t('sec.failed')}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [call, t])

  useEffect(() => {
    void load()
  }, [load])

  /** Revoke one session or every other one, then re-read the truth from the host. */
  const revoke = useCallback(async (id: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await call(ENDPOINT_AUTH_REVOKE, { id })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setMessage(t('sec.revoked'))
      await load()
    } catch (err) {
      setError(`${t('sec.failed')}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [call, load, t])

  /** Persist a transport-policy patch and report that a restart is needed. */
  const patchSecurity = useCallback(async (patch: { requireTls?: boolean; cleartextAuth?: 'login' | 'basic' }): Promise<void> => {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await call<{ restartRequired?: boolean }>(ENDPOINT_SECURITY, patch)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      const restartRequired = (result.value as { restartRequired?: boolean })?.restartRequired === true
      setMessage(restartRequired ? `${t('sec.saved')} · ${t('sec.restartHint')}` : t('sec.saved'))
      await load()
    } catch (err) {
      setError(`${t('sec.failed')}：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }, [call, load, t])

  if (loading && auth === null) {
    return <p className="dsh_lanproxy_hint">{t('sec.loading')}</p>
  }

  const others = auth?.sessions.filter((session) => !session.current) ?? []
  const policy = auth?.policy

  return (
    <div className="dsh_lanproxy_card">
      <div className="dsh_lanproxy_cardHeader">
        <div className="dsh_lanproxy_cardTitle">{t('sec.title')}</div>
        <div className="dsh_lanproxy_controls">
          <button
            type="button"
            className="dsh_lanproxy_button"
            disabled={busy}
            onClick={() => { void load() }}
          >
            {t('sec.refresh')}
          </button>
        </div>
      </div>
      <p className="dsh_lanproxy_hint">{t('sec.subtitle')}</p>

      <StatusRow label={t('sec.loginEnabled')} value={auth?.loginEnabled === true ? t('sec.loginOn') : t('sec.loginOff')} />
      <StatusRow
        label={t('sec.requireTls')}
        value={auth?.requireTls === true ? t('sec.requireTlsOn') : t('sec.requireTlsOff')}
      />
      <div className="dsh_lanproxy_actions">
        <button
          type="button"
          className="dsh_lanproxy_button"
          disabled={busy || auth === null}
          onClick={() => { void patchSecurity({ requireTls: !(auth?.requireTls === true) }) }}
        >
          {auth?.requireTls === true ? t('sec.disableRequireTls') : t('sec.enableRequireTls')}
        </button>
      </div>

      <StatusRow
        label={t('sec.cleartextAuth')}
        value={auth?.cleartextAuth === 'basic' ? t('sec.cleartextBasic') : t('sec.cleartextLogin')}
      />
      <div className="dsh_lanproxy_actions">
        <button
          type="button"
          className="dsh_lanproxy_button"
          disabled={busy || auth === null}
          onClick={() => {
            void patchSecurity({ cleartextAuth: auth?.cleartextAuth === 'basic' ? 'login' : 'basic' })
          }}
        >
          {auth?.cleartextAuth === 'basic' ? t('sec.useCleartextLogin') : t('sec.useCleartextBasic')}
        </button>
      </div>
      <p className={auth?.cleartextAuth === 'basic' ? 'dsh_lanproxy_hint' : 'dsh_lanproxy_warn'}>
        {auth?.cleartextAuth === 'basic' ? t('sec.cleartextBasicHint') : t('sec.cleartextLoginHint')}
      </p>
      {policy !== undefined && policy.maxFailures !== undefined ? (
        <p className="dsh_lanproxy_hint">
          {t('sec.policy', {
            ttl: Math.round(policy.sessionTtlMs / 86400000),
            idle: Math.round(policy.sessionIdleMs / 3600000),
            max: policy.maxFailures,
            lockout: minutes(policy.lockoutMs),
          })}
        </p>
      ) : null}

      <div className="dsh_lanproxy_cardTitle">{t('sec.sessions')}</div>
      {auth !== null && auth.sessions.length > 0 ? (
        <table className="dsh_lanproxy_table">
          <thead>
            <tr>
              <th>{t('sec.source')}</th>
              <th>{t('sec.createdAt')}</th>
              <th>{t('sec.lastSeen')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {auth.sessions.map((session) => (
              <tr key={session.id}>
                <td>{session.source}{session.current ? ` · ${t('sec.current')}` : ''}</td>
                <td>{stamp(session.createdAt)}</td>
                <td>{stamp(session.lastSeenAt)}</td>
                <td>
                  <button
                    type="button"
                    className="dsh_lanproxy_button dsh_lanproxy_buttonSmall"
                    disabled={busy}
                    onClick={() => { void revoke(session.id) }}
                  >
                    {t('sec.revoke')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dsh_lanproxy_hint">{t('sec.noSessions')}</p>
      )}
      {others.length > 0 ? (
        <div className="dsh_lanproxy_actions">
          <button
            type="button"
            className="dsh_lanproxy_button dsh_lanproxy_buttonStop"
            disabled={busy}
            onClick={() => { void revoke('all') }}
          >
            {t('sec.revokeAll')}
          </button>
        </div>
      ) : null}

      {auth !== null && auth.lockouts.length > 0 ? (
        <>
          <div className="dsh_lanproxy_cardTitle">{t('sec.lockouts')}</div>
          <ul className="dsh_lanproxy_list">
            {auth.lockouts.map((lock) => (
              <li key={lock.source}>
                <code>{lock.source}</code>{' '}
                {t('sec.lockoutRow', { failures: lock.failures, minutes: minutes(lock.retryAfterMs) })}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="dsh_lanproxy_cardTitle">{t('sec.audit', { count: audit.length })}</div>
      {audit.length > 0 ? (
        <table className="dsh_lanproxy_table">
          <thead>
            <tr>
              <th>{t('sec.createdAt')}</th>
              <th>{t('sec.source')}</th>
              <th>event</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((entry, index) => (
              <tr key={`${entry.at}-${index}`}>
                <td>{stamp(entry.at)}</td>
                <td>{entry.source}</td>
                <td>
                  {entry.event}
                  {entry.detail !== undefined ? ` · ${entry.detail}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="dsh_lanproxy_hint">{t('sec.noAudit')}</p>
      )}

      {message !== null ? <p className="dsh_lanproxy_message">{message}</p> : null}
      {error !== null ? <p className="dsh_lanproxy_error">{error}</p> : null}
    </div>
  )
}

/** One labeled row, matching the status card's layout. */
function StatusRow(props: { label: ReactNode; value: ReactNode }): ReactNode {
  return (
    <div className="dsh_lanproxy_row">
      <span className="dsh_lanproxy_rowLabel">{props.label}</span>
      <span className="dsh_lanproxy_rowValue">{props.value}</span>
    </div>
  )
}
