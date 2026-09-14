/**
 * Persisted security knobs that are NOT the credential pair.
 *
 * Kept in their own file rather than folded into `dsh-proxy.json`: that file is
 * the runtime overlay for the forwarding service (port, credentials), while
 * these decide HOW the gate behaves. Mixing them would make a settings write
 * about a port also rewrite the transport policy.
 *
 * Two switches, with defaults chosen for the common deployment:
 *
 * - `cleartextAuth` decides how a plain-HTTP LAN visitor authenticates. It
 *   defaults to `login`, so the gate is ONE mechanism everywhere the browser can
 *   hold a cookie. `basic` restores the historic native dialog (a usable fallback
 *   for a client that cannot keep cookies), and is the only mode that leaves the
 *   password in the Basic header.
 * - `requireTls` refuses cleartext outright and is off by default: it only makes
 *   sense once a TLS reverse proxy is actually in front.
 *
 * Note the asymmetry the caller must surface: on cleartext the session cookie
 * cannot carry `Secure`, so it is a weaker cookie — see the note in `auth.ts`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** How a plain-HTTP (non-loopback) visitor authenticates. */
export type CleartextAuthMode = 'login' | 'basic'

/** The on-disk shape of the security settings. */
export interface SecuritySettings {
  /** Refuse cleartext requests entirely. */
  requireTls: boolean
  /** Authentication used for whatever cleartext traffic is still allowed. */
  cleartextAuth: CleartextAuthMode
}

/** Defaults applied when the file is absent or unreadable. */
export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  requireTls: false,
  // Unified by default: one login page everywhere a cookie can be held.
  cleartextAuth: 'login',
}

/** Whether a value is an accepted cleartext mode. */
export function isCleartextAuthMode(value: unknown): value is CleartextAuthMode {
  return value === 'login' || value === 'basic'
}

/** Tolerant read of an unknown JSON value into the settings shape. */
export function normalizeSecuritySettings(raw: unknown): SecuritySettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SECURITY_SETTINGS }
  const source = raw as Record<string, unknown>
  return {
    requireTls: typeof source.requireTls === 'boolean'
      ? source.requireTls
      : DEFAULT_SECURITY_SETTINGS.requireTls,
    cleartextAuth: isCleartextAuthMode(source.cleartextAuth)
      ? source.cleartextAuth
      : DEFAULT_SECURITY_SETTINGS.cleartextAuth,
  }
}

/**
 * Read/write access to the persisted security settings. Writes are atomic
 * (temp file + rename) so a crash never leaves a truncated file behind.
 */
export class SecuritySettingsFile {
  constructor(private readonly filePath: string) {}

  read(): SecuritySettings {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return { ...DEFAULT_SECURITY_SETTINGS }
    }
    try {
      return normalizeSecuritySettings(JSON.parse(text))
    } catch {
      return { ...DEFAULT_SECURITY_SETTINGS }
    }
  }

  write(settings: SecuritySettings): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp`
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    renameSync(temp, this.filePath)
  }
}
