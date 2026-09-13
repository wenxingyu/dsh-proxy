import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots';
import type { LanProxyCall } from './transport.ts';
/** Injected business face: the caller for this plugin's own `/api` route. */
export interface SettingsSectionInjected {
    call: LanProxyCall;
}
/** Full section props: runtime share + injected face + the locale seat. */
export type SettingsSectionProps = PropsRuntime<'settings.section'> & InjectFace<SettingsSectionInjected> & PropsLocale<'dsh-proxy'>;
/**
 * Render the section.
 * @param props - runtime share, the injected endpoint caller, and `t`.
 */
export declare function SettingsSection({ call, t }: SettingsSectionProps): import("react").JSX.Element;
