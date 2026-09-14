/**
 * Audit trail persistence for the LAN proxy's login gate.
 *
 * A login gate without a record of who tried what is not auditable: you cannot
 * tell a fat-fingered password from a script grinding the form. Every event the
 * auth core reports is appended here as one JSON line, so the file survives a
 * crash mid-write and can be tailed while the proxy runs.
 *
 * Two deliberate properties:
 * - only failures and session lifecycle events are written (a successful request
 *   is not an event, or the file would be a request log);
 * - credentials never reach the sink: the events carry a source and a detail
 *   string that the callers keep free of secrets, and the password is compared
 *   before any entry is produced.
 *
 * Best-effort by design: a read-only or full disk must not break authentication,
 * so every failure here degrades to "no audit line" rather than an error.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditEntry } from './auth.ts'

/** How the trail is bounded on disk. */
export interface AuditOptions {
  /** File to append to. */
  filePath: string
  /** Rotate once the file exceeds this many bytes (default 1 MiB). */
  maxBytes?: number
  /** How many entries the in-memory ring and the reader return (default 200). */
  keep?: number
}

/** One parsed audit line, as the settings UI renders it. */
export interface AuditRecord extends AuditEntry {
  /** Stable index for React keys (position in the returned list). */
  index: number
}

/**
 * Append-only audit trail with a size cap and an in-memory recent window.
 *
 * The in-memory window is what the settings page reads (cheap, no disk read per
 * RPC); the file is the durable record an operator can grep.
 */
export class AuditTrail {
  private readonly filePath: string
  private readonly maxBytes: number
  private readonly keep: number
  private recent: AuditEntry[] = []

  constructor(options: AuditOptions) {
    this.filePath = options.filePath
    this.maxBytes = options.maxBytes ?? 1024 * 1024
    this.keep = options.keep ?? 200
    this.recent = this.readFromDisk()
  }

  /**
   * Record one entry: push to the window and append to disk.
   * @param entry - the event, already free of credentials.
   */
  record(entry: AuditEntry): void {
    this.recent.push(entry)
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep)
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      this.rotateIfNeeded()
      appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* a full or read-only disk must not take the login gate down */
    }
  }

  /** The most recent entries, newest last (the settings UI reverses for display). */
  list(): AuditRecord[] {
    return this.recent.slice(-this.keep).map((entry, index) => ({ ...entry, index }))
  }

  /** Drop the in-memory window (the on-disk trail is left alone). */
  clearWindow(): void {
    this.recent = []
  }

  /** Move the file aside when it outgrows {@link maxBytes}, keeping one previous generation. */
  private rotateIfNeeded(): void {
    let size = 0
    try {
      size = statSync(this.filePath).size
    } catch {
      return
    }
    if (size < this.maxBytes) return
    renameSync(this.filePath, `${this.filePath}.1`)
  }

  /** Read the tail of the file so a restart keeps its recent history. */
  private readFromDisk(): AuditEntry[] {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const tail = lines.slice(-this.keep)
    const entries: AuditEntry[] = []
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line) as AuditEntry
        if (typeof parsed?.at === 'number' && typeof parsed?.event === 'string') entries.push(parsed)
      } catch {
        /* a torn final line from a crash: skip it rather than lose the rest */
      }
    }
    return entries
  }
}
