import { type MusicProviderKey, type MusicProviderPolicy } from "./models.js";
export declare const isMusicProviderKey: (value: unknown) => value is MusicProviderKey;
export declare const normalizeMusicProviderPolicies: (policies: readonly MusicProviderPolicy[]) => readonly MusicProviderPolicy[];
export type MusicProviderSelection = Readonly<{
    provider: MusicProviderKey;
    normalizedQuery: string;
}>;
export declare const selectMusicProvider: (input: {
    readonly query: string;
    readonly preferredProvider?: MusicProviderKey;
    readonly providerPolicies: readonly MusicProviderPolicy[];
    readonly readyProviders: ReadonlySet<MusicProviderKey>;
    readonly allowedRawMediaHosts: ReadonlySet<string>;
    readonly maximumQueryLength: number;
}) => MusicProviderSelection;
export declare const approvedMusicProviderHosts: (provider: MusicProviderKey) => readonly string[];
//# sourceMappingURL=provider-policy.d.ts.map