import type {
  MusicPlaybackControl,
  MusicProviderKey,
  MusicProviderPolicy,
  MusicSessionSnapshot,
  ResolvedMediaCollection,
  ResolvedMediaItem
} from "./models.js";

export type MediaEngineProbeResult = Readonly<{
  state: "ready" | "unavailable";
  version: string | null;
  failureCode: string | null;
}>;

export interface MediaProbePort {
  probe(input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<MediaEngineProbeResult>;
}

export interface MediaResolverPort {
  resolve(input: {
    readonly guildId: string;
    readonly query: string;
    readonly preferredProvider?: MusicProviderKey;
    readonly providerPolicies: readonly MusicProviderPolicy[];
    readonly maximumResults?: number;
    readonly signal?: AbortSignal;
  }): Promise<ResolvedMediaCollection>;
}

export interface AudioPlaybackPort {
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

  session(
    guildId: string,
    signal?: AbortSignal
  ): Promise<MusicSessionSnapshot | null>;
}

export type MusicProviderHealth = Readonly<{
  provider: MusicProviderKey;
  state: "ready" | "disabled" | "unavailable";
  failureCode: string | null;
}>;

export type MusicPlaybackClientHealth = Readonly<{
  state: "stopped" | "ready" | "degraded" | "unavailable";
  mediaEngine: MediaEngineProbeResult | null;
  providers: readonly MusicProviderHealth[];
}>;

export interface MusicPlaybackClientLifecyclePort {
  start(signal?: AbortSignal): Promise<MusicPlaybackClientHealth>;
  restart(signal?: AbortSignal): Promise<MusicPlaybackClientHealth>;
  stop(): Promise<void>;
  health(): MusicPlaybackClientHealth;
}
