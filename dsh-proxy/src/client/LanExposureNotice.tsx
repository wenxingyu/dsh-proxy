/**
 * The frame-wide popup that fires while the LAN proxy is exposed without a
 * password.
 *
 * It occupies the shared `shell.overlay` seat (declared by the frame root, a
 * list slot that is additive and click-through), so it appears on whatever page
 * the user is on rather than only inside Settings. It reads the same status
 * endpoint the settings section uses and reuses `status.lanExposed`, so the
 * popup, the red badge, and the startup log all agree on what "exposed" means.
 *
 * Two deliberate restraints:
 * - It is NOT a modal: the layer is click-through and this card opts into
 *   pointer events only on itself, so the app underneath stays usable. The user
 *   can read the warning and go set the credentials whenever they like.
 * - Dismissal is NOT persistent. An unauthenticated LAN surface is a standing
 *   risk, so the notice is re-established on every page load; "我知道了" only
 *   hides it for the page it was raised on. Deliberately no localStorage: a
 *   remembered acknowledgement turns a security warning into something the user
 *   can silence once and then never see again.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: declares the `shell.overlay` SlotMap entry this component fills.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ENDPOINT_STATUS, type LanProxyStatus } from '../contract.ts'
import type { LanProxyKey } from './locales.ts'
import { callLanProxy } from './transport.ts'

/** Full popup props: runtime share + the locale seat (own props are empty). */
export type LanExposureNoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<'dsh-proxy'>

/** What the popup should do once the status is known. */
export type LanExposureDecision =
  /** The proxy is not exposed: render nothing (the common case). */
  | { kind: 'silent' }
  /** The proxy is exposed: show the popup for this page load. */
  | { kind: 'show' }

/**
 * Decide what to do for one observed status. There is no "already seen" branch
 * by design — every page load re-warns while the exposure lasts.
 * @param status - the freshly read proxy status, or null when it was not read.
 * @returns whether to show the popup.
 */
export function decideExposure(status: LanProxyStatus | null): LanExposureDecision {
  if (status === null || !status.lanExposed) return { kind: 'silent' }
  return { kind: 'show' }
}

/**
 * The status read runs at most once per page load: this component sits in a
 * frame-wide seat that remounts as the frame does, and re-asking on every
 * remount would turn the alert into a poll. A page LOAD (a refresh) is a new
 * module instance, so the alert comes back.
 */
let checkedThisPageLoad = false

/** Test seam: allow a suite to exercise the first-load path more than once. */
export function resetExposureCheckForTest(): void {
  checkedThisPageLoad = false
}

/**
 * Render the popup (nothing at all when the proxy is not exposed).
 * @param props - runtime share and `t`.
 */
export function LanExposureNotice({ t }: LanExposureNoticeProps): ReactNode {
  const [exposed, setExposed] = useState<Pick<LanProxyStatus, 'listenHost' | 'listenPort'> | null>(null)

  useEffect(() => {
    if (checkedThisPageLoad) return
    checkedThisPageLoad = true
    void (async () => {
      const result = await callLanProxy<LanProxyStatus>(ENDPOINT_STATUS, {})
      // A failed read stays silent: the settings section already surfaces
      // transport failures, and a popup that cannot know the answer must not
      // guess. Nothing is remembered either way.
      const status = result.ok ? (result.value as LanProxyStatus) : null
      if (decideExposure(status).kind !== 'show' || status === null) return
      setExposed({ listenHost: status.listenHost, listenPort: status.listenPort })
    })()
  }, [])

  if (exposed === null) return null

  return (
    <div className="dsh_lanproxy_notice" role="alert" aria-live="assertive">
      <p className="dsh_lanproxy_noticeTitle">{t('notice.title')}</p>
      <p className="dsh_lanproxy_noticeBody">
        {t('notice.body', { address: `${exposed.listenHost}:${exposed.listenPort}` })}
      </p>
      <p className="dsh_lanproxy_noticeHint">{t('notice.hint')}</p>
      <button
        type="button"
        className="dsh_lanproxy_noticeButton"
        onClick={() => { setExposed(null) }}
      >
        {t('notice.dismiss')}
      </button>
    </div>
  )
}
