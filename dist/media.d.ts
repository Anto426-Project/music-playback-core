import { type MusicProviderKey } from "./models.js";
export type SanitizedMusicMedia = Readonly<{
    title: string;
    author: string;
    canonicalLocator: string;
    durationMs: number | null;
    live: boolean;
}>;
export declare const sanitizeMusicMedia: (input: {
    readonly provider: MusicProviderKey;
    readonly title: unknown;
    readonly author: unknown;
    readonly canonicalLocator: unknown;
    readonly durationMs: unknown;
    readonly live: unknown;
    readonly allowedRawMediaHosts: ReadonlySet<string>;
    readonly maximumTrackDurationMs: number;
}) => SanitizedMusicMedia;
//# sourceMappingURL=media.d.ts.map