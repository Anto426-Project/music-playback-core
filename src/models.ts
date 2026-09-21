export const MUSIC_PROVIDER_KEYS = Object.freeze([
  "youtubei",
  "soundcloud",
  "attachment",
  "vimeo",
  "reverbnation",
  "spotify",
  "apple_music"
] as const);

export type MusicProviderKey = (typeof MUSIC_PROVIDER_KEYS)[number];

export const MUSIC_STREAM_PROVIDER_KEYS = Object.freeze([
  "youtubei",
  "soundcloud",
  "attachment",
  "vimeo",
  "reverbnation"
] as const);

export type MusicStreamProviderKey =
  (typeof MUSIC_STREAM_PROVIDER_KEYS)[number];

export type MusicMetadataProviderKey = "spotify" | "apple_music";

export type MusicProviderPolicy = Readonly<{
  provider: MusicProviderKey;
  enabled: boolean;
  priority: number;
}>;

export type MusicRepeatMode = "off" | "track" | "queue";

export type ResolvedMediaItem = Readonly<{
  providerReference: string;
  sourceProvider: MusicProviderKey;
  title: string;
  author: string;
  canonicalLocator: string;
  durationMs: number | null;
  live: boolean;
}>;

export type ResolvedMediaCollection = Readonly<{
  query: string;
  selectedProvider: MusicProviderKey;
  items: readonly ResolvedMediaItem[];
}>;

export type MusicSessionState =
  | "connecting"
  | "playing"
  | "paused"
  | "idle";

export type MusicSessionSnapshot = Readonly<{
  guildId: string;
  voiceChannelId: string;
  state: MusicSessionState;
  current: ResolvedMediaItem | null;
  queuedItemCount: number;
  repeatMode: MusicRepeatMode;
  autoplay: boolean;
  volume: number;
}>;

export type MusicPlaybackControl =
  | Readonly<{ kind: "pause" }>
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "toggle" }>
  | Readonly<{ kind: "skip" }>
  | Readonly<{ kind: "shuffle" }>
  | Readonly<{ kind: "set_repeat"; mode: MusicRepeatMode }>
  | Readonly<{ kind: "set_autoplay"; enabled: boolean }>
  | Readonly<{ kind: "stop" }>
  | Readonly<{ kind: "set_volume"; volume: number }>;

export type MusicPlaybackErrorCode =
  | "MUSIC.YT_DLP_UNAVAILABLE"
  | "MUSIC.PROVIDER_REGISTRATION_TIMEOUT"
  | "MUSIC.CLIENT_NOT_STARTED"
  | "MUSIC.MEDIA_ENGINE_UNAVAILABLE"
  | "MUSIC.PROVIDER_DISABLED"
  | "MUSIC.PROVIDER_UNAVAILABLE"
  | "MUSIC.MEDIA_QUERY_INVALID"
  | "MUSIC.MEDIA_SOURCE_NOT_ALLOWED"
  | "MUSIC.MEDIA_NOT_FOUND"
  | "MUSIC.MEDIA_RESOLUTION_TIMEOUT"
  | "MUSIC.PLAYBACK_TIMEOUT"
  | "MUSIC.SESSION_NOT_FOUND"
  | "MUSIC.SESSION_CHANNEL_CONFLICT"
  | "MUSIC.QUEUE_LIMIT_REACHED"
  | "MUSIC.OPERATION_CAPACITY_EXHAUSTED"
  | "MUSIC.CONTROL_INVALID";

export class MusicPlaybackError extends Error {
  public constructor(
    public readonly code: MusicPlaybackErrorCode,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "MusicPlaybackError";
  }
}
