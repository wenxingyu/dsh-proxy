import type { ReactNode } from 'react';
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { type LanProxyStatus } from '../contract.ts';
/** Full popup props: runtime share + the locale seat (own props are empty). */
export type LanExposureNoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<'dsh-proxy'>;
/** What the popup should do once the status is known. */
export type LanExposureDecision = 
/** The proxy is not exposed: render nothing (the common case). */
{
    kind: 'silent';
}
/** The proxy is exposed: show the popup for this page load. */
 | {
    kind: 'show';
};
/**
 * Decide what to do for one observed status. There is no "already seen" branch
 * by design — every page load re-warns while the exposure lasts.
 * @param status - the freshly read proxy status, or null when it was not read.
 * @returns whether to show the popup.
 */
export declare function decideExposure(status: LanProxyStatus | null): LanExposureDecision;
/** Test seam: allow a suite to exercise the first-load path more than once. */
export declare function resetExposureCheckForTest(): void;
/**
 * Render the popup (nothing at all when the proxy is not exposed).
 * @param props - runtime share and `t`.
 */
export declare function LanExposureNotice({ t }: LanExposureNoticeProps): ReactNode;
