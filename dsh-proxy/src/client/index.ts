/**
 * dsh-proxy client plugin: the browser half of the LAN-proxy settings
 * page. Registers the `settings.section` entry ("局域网代理") that shows the
 * running proxy status and edits the listen port / username / password through
 * the host `/api/dsh-proxy` route on Connection's shared `/api` channel.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the settings.section SlotMap entry and its owner props.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.locale Context merge and LocaleNamespaceMap.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SettingsSection, type SettingsSectionInjected } from './SettingsSection.tsx'
import { NS, en, zh } from './locales.ts'
import { adoptStyles } from './styles.ts'
import { callLanProxy } from './transport.ts'

/** Required services: slots (section registry) and locale. */
export const inject = ['slots', 'locale']

/**
 * Compose the settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  adoptStyles()
  console.info('[dsh-proxy] bundle loaded')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-proxy: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-proxy',
    order: 70,
    label: () => t('nav'),
    locale: NS,
    inject: (): SettingsSectionInjected => ({ call: callLanProxy }),
  }, SettingsSection))
}
