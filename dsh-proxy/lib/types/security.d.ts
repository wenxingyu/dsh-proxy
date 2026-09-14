/** How a plain-HTTP (non-loopback) visitor authenticates. */
export type CleartextAuthMode = 'login' | 'basic';
/** The on-disk shape of the security settings. */
export interface SecuritySettings {
    /** Refuse cleartext requests entirely. */
    requireTls: boolean;
    /** Authentication used for whatever cleartext traffic is still allowed. */
    cleartextAuth: CleartextAuthMode;
}
/** Defaults applied when the file is absent or unreadable. */
export declare const DEFAULT_SECURITY_SETTINGS: SecuritySettings;
/** Whether a value is an accepted cleartext mode. */
export declare function isCleartextAuthMode(value: unknown): value is CleartextAuthMode;
/** Tolerant read of an unknown JSON value into the settings shape. */
export declare function normalizeSecuritySettings(raw: unknown): SecuritySettings;
/**
 * Read/write access to the persisted security settings. Writes are atomic
 * (temp file + rename) so a crash never leaves a truncated file behind.
 */
export declare class SecuritySettingsFile {
    private readonly filePath;
    constructor(filePath: string);
    read(): SecuritySettings;
    write(settings: SecuritySettings): void;
}
