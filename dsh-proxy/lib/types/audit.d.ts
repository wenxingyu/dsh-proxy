import type { AuditEntry } from './auth.ts';
/** How the trail is bounded on disk. */
export interface AuditOptions {
    /** File to append to. */
    filePath: string;
    /** Rotate once the file exceeds this many bytes (default 1 MiB). */
    maxBytes?: number;
    /** How many entries the in-memory ring and the reader return (default 200). */
    keep?: number;
}
/** One parsed audit line, as the settings UI renders it. */
export interface AuditRecord extends AuditEntry {
    /** Stable index for React keys (position in the returned list). */
    index: number;
}
/**
 * Append-only audit trail with a size cap and an in-memory recent window.
 *
 * The in-memory window is what the settings page reads (cheap, no disk read per
 * RPC); the file is the durable record an operator can grep.
 */
export declare class AuditTrail {
    private readonly filePath;
    private readonly maxBytes;
    private readonly keep;
    private recent;
    constructor(options: AuditOptions);
    /**
     * Record one entry: push to the window and append to disk.
     * @param entry - the event, already free of credentials.
     */
    record(entry: AuditEntry): void;
    /** The most recent entries, newest last (the settings UI reverses for display). */
    list(): AuditRecord[];
    /** Drop the in-memory window (the on-disk trail is left alone). */
    clearWindow(): void;
    /** Move the file aside when it outgrows {@link maxBytes}, keeping one previous generation. */
    private rotateIfNeeded;
    /** Read the tail of the file so a restart keeps its recent history. */
    private readFromDisk;
}
