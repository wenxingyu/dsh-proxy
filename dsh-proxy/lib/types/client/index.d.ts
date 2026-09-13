/**
 * dsh-proxy client plugin: the browser half of the LAN-proxy settings
 * page. Registers the `settings.section` entry ("局域网代理") that shows the
 * running proxy status and edits the listen port / username / password through
 * the host `/api/dsh-proxy` route on Connection's shared `/api` channel.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** Required services: slots (section registry) and locale. */
export declare const inject: string[];
/**
 * Compose the settings section.
 * @param ctx - client root context.
 */
export declare function apply(ctx: ClientContext): void;
