import { type MusicPlaybackControl, type MusicProviderKey, type MusicProviderPolicy, type MusicSessionSnapshot, type ResolvedMediaCollection, type ResolvedMediaItem } from "./models.js";
import type { AudioPlaybackPort, MediaProbePort, MediaResolverPort, MusicPlaybackClientHealth, MusicPlaybackClientLifecyclePort } from "./ports.js";
import type { MusicPlaybackRuntimeFactory } from "./runtime.js";
export type MusicPlaybackClientOptions = Readonly<{
    ffmpegPath: string;
    enabledProviders: readonly MusicProviderKey[];
    bridgeProviderOrder: readonly MusicProviderKey[];
    allowedRawMediaHosts: readonly string[];
    connectionTimeoutMs: number;
    mediaProbeTimeoutMs: number;
    providerRegistrationTimeoutMs: number;
    mediaResolutionTimeoutMs: number;
    playbackTimeoutMs: number;
    sessionReadTimeoutMs: number;
    shutdownTimeoutMs: number;
    maximumConcurrentOperations: number;
    maximumConcurrentOperationsPerGuild: number;
    maximumActiveSessions: number;
    maximumQueryLength: number;
    maximumSearchResults: number;
    maximumResolvedReferences: number;
    maximumTrackDurationMs: number;
}>;
export declare const DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS: MusicPlaybackClientOptions;
export declare class MusicPlaybackClient implements MusicPlaybackClientLifecyclePort, MediaResolverPort, AudioPlaybackPort {
    #private;
    constructor(factory: MusicPlaybackRuntimeFactory, mediaProbe: MediaProbePort, options?: MusicPlaybackClientOptions);
    health(): MusicPlaybackClientHealth;
    start(signal?: AbortSignal): Promise<MusicPlaybackClientHealth>;
    stop(): Promise<void>;
    restart(signal?: AbortSignal): Promise<MusicPlaybackClientHealth>;
    resolve(input: {
        readonly guildId: string;
        readonly query: string;
        readonly preferredProvider?: MusicProviderKey;
        readonly providerPolicies: readonly MusicProviderPolicy[];
        readonly maximumResults?: number;
        readonly signal?: AbortSignal;
    }): Promise<ResolvedMediaCollection>;
    enqueue(input: {
        readonly guildId: string;
        readonly voiceChannelId: string;
        readonly media: ResolvedMediaItem;
        readonly maximumQueueItems: number;
        readonly defaultVolume: number;
        readonly signal?: AbortSignal;
    }): Promise<MusicSessionSnapshot>;
    control(input: {
        readonly guildId: string;
        readonly voiceChannelId: string;
        readonly control: MusicPlaybackControl;
        readonly signal?: AbortSignal;
    }): Promise<MusicSessionSnapshot | null>;
    session(guildIdInput: string, signal?: AbortSignal): Promise<MusicSessionSnapshot | null>;
}
//# sourceMappingURL=client.d.ts.map