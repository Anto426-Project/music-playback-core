import type { MusicPlaybackControl, MusicProviderKey, MusicQueueSnapshot, MusicSessionSnapshot } from "./models.js";
export type MusicRuntimeCandidate = Readonly<{
    providerReference: string;
    sourceProvider: MusicProviderKey;
    title: string;
    author: string;
    canonicalLocator: string;
    durationMs: number | null;
    live: boolean;
}>;
export type MusicPlaybackRuntimeOptions = Readonly<{
    ffmpegPath: string;
    connectionTimeoutMs: number;
    probeTimeoutMs: number;
    maximumResolvedReferences: number;
    maximumPendingOperationsPerGuild: number;
    maximumActiveSessions: number;
    maximumTrackDurationMs: number;
    allowedRawMediaHosts: readonly string[];
    bridgeProviderOrder: readonly MusicProviderKey[];
}>;
export interface MusicPlaybackRuntime {
    queue?(guildId: string, signal: AbortSignal): Promise<MusicQueueSnapshot | null>;
    registerProvider(provider: MusicProviderKey, signal: AbortSignal): Promise<void>;
    resolve(input: {
        readonly guildId: string;
        readonly provider: MusicProviderKey;
        readonly query: string;
        readonly maximumResults: number;
        readonly allowedBridgeProviders: readonly MusicProviderKey[];
        readonly signal: AbortSignal;
    }): Promise<readonly MusicRuntimeCandidate[]>;
    enqueue(input: {
        readonly guildId: string;
        readonly voiceChannelId: string;
        readonly providerReference: string;
        readonly maximumQueueItems: number;
        readonly defaultVolume: number;
        readonly timeoutMs: number;
        readonly signal: AbortSignal;
    }): Promise<MusicSessionSnapshot>;
    control(input: {
        readonly guildId: string;
        readonly voiceChannelId: string;
        readonly control: MusicPlaybackControl;
        readonly signal: AbortSignal;
    }): Promise<MusicSessionSnapshot | null>;
    session(guildId: string, signal: AbortSignal): Promise<MusicSessionSnapshot | null>;
    destroy(signal: AbortSignal): Promise<void>;
}
export interface MusicPlaybackRuntimeFactory {
    create(options: MusicPlaybackRuntimeOptions): MusicPlaybackRuntime;
}
//# sourceMappingURL=runtime.d.ts.map