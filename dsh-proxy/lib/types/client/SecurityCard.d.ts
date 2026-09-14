import type { ReactNode } from 'react';
import type { LanProxyKey } from './locales.ts';
import { type LanProxyCall } from './transport.ts';
/** The `t` seat this card uses (a slice of the section's props). */
type Translate = (key: LanProxyKey, params?: Record<string, unknown>) => string;
export interface SecurityCardProps {
    /** Caller for this plugin's own `/api` route. */
    call: LanProxyCall;
    /** Translate function of the `dsh-proxy` namespace. */
    t: Translate;
}
/**
 * Render the security card.
 * @param props - the endpoint caller and `t`.
 */
export declare function SecurityCard({ call, t }: SecurityCardProps): ReactNode;
export {};
