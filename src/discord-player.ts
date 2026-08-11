import {
  AppleMusicExtractor,
  AttachmentExtractor,
  ReverbnationExtractor,
  SoundCloudExtractor,
  SpotifyExtractor,
  VimeoExtractor,
  type AppleMusicExtractorInit,
  type SpotifyExtractorInit
} from "@discord-player/extractor";
import {
  BaseExtractor,
  Player,
  QueueRepeatMode,
  type ExtractorExecutionContext,
  type ExtractorStreamable,
  type GuildQueue,
  type Track
} from "discord-player";
import { YoutubeExtractor } from "discord-player-youtubei";
import youtubeDl from "youtube-dl-exec";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  type StageChannel,
  type VoiceChannel
} from "discord.js";

import { sanitizeMusicMedia } from "./media.js";
import {
  MUSIC_STREAM_PROVIDER_KEYS,
  MusicPlaybackError,
  type MusicPlaybackControl,
  type MusicProviderKey,
  type MusicRepeatMode,
  type MusicSessionSnapshot,
  type ResolvedMediaItem
} from "./models.js";
import { NodeYtDlpMediaProbeAdapter } from "./node.js";
import { BoundedKeyedSerialExecutor } from "./serial-executor.js";
import type {
  MusicPlaybackRuntime,
  MusicPlaybackRuntimeFactory,
  MusicPlaybackRuntimeOptions,
  MusicRuntimeCandidate
} from "./runtime.js";

const DISCORD_PLAYER_PROVIDER_IDENTIFIERS: Readonly<
  Record<MusicProviderKey, string>
> = Object.freeze({
  youtubei:
    "com.retrouser955.discord-player.discord-player-youtubei",
  soundcloud: "com.discord-player.soundcloudextractor",
  attachment: "com.discord-player.attachmentextractor",
  vimeo: "com.discord-player.vimeoextractor",
  reverbnation: "com.discord-player.reverbnationextractor",
  spotify: "com.discord-player.spotifyextractor",
  apple_music: "com.discord-player.applemusicextractor"
});

const APPROVED_YT_DLP_PATH = "/usr/bin/yt-dlp";

const youtubeDlRuntime = youtubeDl as typeof youtubeDl & {
  readonly constants: Readonly<{ YOUTUBE_DL_PATH: string }>;
};

const assertApprovedYtDlpRuntime = (): void => {
  if (youtubeDlRuntime.constants.YOUTUBE_DL_PATH !== APPROVED_YT_DLP_PATH) {
    throw new MusicPlaybackError(
      "MUSIC.PROVIDER_UNAVAILABLE",
      "The YouTube fallback executable is not configured at the approved path.",
      false
    );
  }
};

const createSafeYoutubeStream = async (
  track: Track
): Promise<string | Readable> => {
  assertApprovedYtDlpRuntime();
  const locator = new URL(track.url);
  if (
    locator.protocol !== "https:" ||
    ![
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be"
    ].includes(locator.hostname.toLowerCase())
  ) {
    throw new MusicPlaybackError(
      "MUSIC.MEDIA_SOURCE_NOT_ALLOWED",
      "The YouTube stream locator is not approved.",
      false
    );
  }
  const child = spawn(
    APPROVED_YT_DLP_PATH,
    [
      "--js-runtimes",
      "node",
      "--format",
      track.live ? "best[height<=360]" : "bestaudio",
      "--output",
      "-",
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--",
      locator.toString()
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const stream = child.stdout;
  child.stderr.resume();
  const failStream = (): void => {
    if (!stream.destroyed) {
      stream.destroy(
        new MusicPlaybackError(
          "MUSIC.PROVIDER_UNAVAILABLE",
          "The YouTube fallback process failed.",
          true
        )
      );
    }
  };
  child.once("error", failStream);
  child.once("close", (code) => {
    if (code !== 0) failStream();
  });
  // A provider failure may happen before Discord Player attaches its own
  // listener. This no-op listener prevents an unhandled stream error while
  // preserving the error for every subsequently attached consumer.
  stream.on("error", () => undefined);
  const stopChild = (): void => {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      !child.killed
    ) {
      child.kill("SIGTERM");
    }
  };
  stream.once("close", stopChild);
  stream.once("error", stopChild);
  stream.once("end", stopChild);
  return stream;
};

type MusicQueueMetadata = Readonly<{
  guildId: string;
  voiceChannelId: string;
}>;

type ExplicitBridgeOptions = Readonly<{
  resolveBridgeProviderIdentifiers(track: Track): readonly string[];
}>;

const aborted = (
  signal: AbortSignal,
  fallback: MusicPlaybackError
): void => {
  if (signal.aborted) throw signal.reason ?? fallback;
};

const awaitWithSignal = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  fallback: MusicPlaybackError
): Promise<T> => {
  aborted(signal, fallback);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? fallback);
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
};

const requestExplicitBridge = async (
  source: BaseExtractor,
  track: Track,
  providerIdentifiers: readonly string[]
): Promise<ExtractorStreamable> => {
  for (const identifier of providerIdentifiers) {
    if (
      identifier === source.identifier ||
      !source.context.isRegistered(identifier)
    ) {
      continue;
    }
    try {
      const bridged = await source.context.requestBridgeFrom(
        track,
        source,
        identifier
      );
      if (bridged !== null) return bridged;
    } catch {
      // Provider failures are isolated so the configured bridge chain continues.
    }
  }
  throw new MusicPlaybackError(
    "MUSIC.PROVIDER_UNAVAILABLE",
    "No configured streaming provider could bridge the metadata track.",
    true
  );
};

class ExplicitBridgeSpotifyExtractor extends SpotifyExtractor {
  readonly #resolveBridgeProviderIdentifiers:
    ExplicitBridgeOptions["resolveBridgeProviderIdentifiers"];

  public constructor(
    context: ExtractorExecutionContext,
    options: SpotifyExtractorInit & ExplicitBridgeOptions
  ) {
    super(context, options);
    this.#resolveBridgeProviderIdentifiers =
      options.resolveBridgeProviderIdentifiers;
  }

  public override stream(track: Track): Promise<ExtractorStreamable> {
    return requestExplicitBridge(
      this,
      track,
      this.#resolveBridgeProviderIdentifiers(track)
    );
  }
}

class ExplicitBridgeAppleMusicExtractor extends AppleMusicExtractor {
  readonly #resolveBridgeProviderIdentifiers:
    ExplicitBridgeOptions["resolveBridgeProviderIdentifiers"];

  public constructor(
    context: ExtractorExecutionContext,
    options: AppleMusicExtractorInit & ExplicitBridgeOptions
  ) {
    super(context, options);
    this.#resolveBridgeProviderIdentifiers =
      options.resolveBridgeProviderIdentifiers;
  }

  public override stream(track: Track): Promise<ExtractorStreamable> {
    return requestExplicitBridge(
      this,
      track,
      this.#resolveBridgeProviderIdentifiers(track)
    );
  }
}

const assertProviderIdentifiers = (): void => {
  const actual: Readonly<Record<MusicProviderKey, string>> = {
    youtubei: YoutubeExtractor.identifier,
    soundcloud: SoundCloudExtractor.identifier,
    attachment: AttachmentExtractor.identifier,
    vimeo: VimeoExtractor.identifier,
    reverbnation: ReverbnationExtractor.identifier,
    spotify: SpotifyExtractor.identifier,
    apple_music: AppleMusicExtractor.identifier
  };
  for (const [provider, expected] of Object.entries(
    DISCORD_PLAYER_PROVIDER_IDENTIFIERS
  ) as Array<[MusicProviderKey, string]>) {
    if (actual[provider] !== expected) {
      throw new TypeError(
        `Unexpected Discord Player identifier for ${provider}.`
      );
    }
  }
};

const runtimeInteger = (
  value: unknown,
  minimum: number,
  maximum: number,
  label: string
): number => {
  if (!Number.isSafeInteger(value) || (value as number) < minimum ||
    (value as number) > maximum) {
    throw new TypeError(`${label} is outside the supported boundary.`);
  }
  return value as number;
};

const runtimeStringArray = (
  value: readonly string[],
  maximum: number,
  label: string,
  validate: (entry: string) => boolean
): readonly string[] => {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a plain bounded array.`);
  }
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !validate(descriptor.value)
    ) {
      throw new TypeError(`${label} contains an invalid entry.`);
    }
    entries.push(descriptor.value);
  }
  if (new Set(entries).size !== entries.length) {
    throw new TypeError(`${label} cannot contain duplicates.`);
  }
  return Object.freeze(entries);
};

const normalizeRuntimeOptions = (
  options: MusicPlaybackRuntimeOptions
): MusicPlaybackRuntimeOptions => {
  if (options.ffmpegPath !== "/usr/bin/ffmpeg") {
    throw new TypeError("The runtime FFmpeg path is not approved.");
  }
  const allowedRawMediaHosts = runtimeStringArray(
    options.allowedRawMediaHosts,
    256,
    "Allowed raw media hosts",
    (host) =>
      host.length >= 3 &&
      host.length <= 253 &&
      host.includes(".") &&
      !host.endsWith(".") &&
      /^[a-z0-9.-]+$/u.test(host)
  );
  const bridgeProviderOrder = runtimeStringArray(
    options.bridgeProviderOrder,
    MUSIC_STREAM_PROVIDER_KEYS.length,
    "Bridge provider order",
    (provider) =>
      (MUSIC_STREAM_PROVIDER_KEYS as readonly string[]).includes(provider)
  ) as readonly MusicProviderKey[];
  return Object.freeze({
    ffmpegPath: options.ffmpegPath,
    connectionTimeoutMs: runtimeInteger(
      options.connectionTimeoutMs,
      100,
      120_000,
      "Connection timeout"
    ),
    probeTimeoutMs: runtimeInteger(
      options.probeTimeoutMs,
      100,
      30_000,
      "Probe timeout"
    ),
    maximumResolvedReferences: runtimeInteger(
      options.maximumResolvedReferences,
      1,
      50_000,
      "Resolved reference limit"
    ),
    maximumPendingOperationsPerGuild: runtimeInteger(
      options.maximumPendingOperationsPerGuild,
      1,
      64,
      "Per-guild pending operation limit"
    ),
    maximumActiveSessions: runtimeInteger(
      options.maximumActiveSessions,
      1,
      1_000,
      "Active session limit"
    ),
    maximumTrackDurationMs: runtimeInteger(
      options.maximumTrackDurationMs,
      1,
      24 * 60 * 60 * 1_000,
      "Track duration limit"
    ),
    allowedRawMediaHosts,
    bridgeProviderOrder
  });
};

const repeatMode = (queue: GuildQueue): MusicRepeatMode => {
  if (queue.repeatMode === QueueRepeatMode.TRACK) return "track";
  if (queue.repeatMode === QueueRepeatMode.QUEUE) return "queue";
  return "off";
};

const queueState = (
  queue: GuildQueue
): MusicSessionSnapshot["state"] => {
  if (queue.node.isPaused()) return "paused";
  if (queue.node.isBuffering()) return "connecting";
  if (queue.node.isPlaying()) return "playing";
  return "idle";
};

const isGuildVoiceChannel = (
  channel: unknown
): channel is VoiceChannel | StageChannel =>
  typeof channel === "object" &&
  channel !== null &&
  "guildId" in channel &&
  typeof channel.guildId === "string" &&
  "type" in channel &&
  (channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice);

class NodeDiscordPlayerRuntime implements MusicPlaybackRuntime {
  readonly #client: Client;
  readonly #options: MusicPlaybackRuntimeOptions;
  readonly #player: Player;
  readonly #references = new Map<
    string,
    Readonly<{
      guildId: string;
      track: Track;
      media: ResolvedMediaItem;
    }>
  >();
  readonly #bridgePolicies = new WeakMap<Track, readonly string[]>();
  readonly #allowedRawMediaHosts: ReadonlySet<string>;
  readonly #guildOperations: BoundedKeyedSerialExecutor;
  readonly #onDestroyed: () => void;
  readonly #activeSessions = new Set<string>();
  readonly #pendingSessions = new Set<string>();
  #referenceSequence = 0;
  #destroyOperation: Promise<void> | null = null;
  #destroyed = false;
  #shutdownStarted = false;

  public constructor(
    client: Client,
    options: MusicPlaybackRuntimeOptions,
    onDestroyed: () => void
  ) {
    assertProviderIdentifiers();
    const normalizedOptions = normalizeRuntimeOptions(options);
    this.#client = client;
    this.#onDestroyed = onDestroyed;
    this.#options = normalizedOptions;
    this.#allowedRawMediaHosts = new Set(
      normalizedOptions.allowedRawMediaHosts
    );
    this.#guildOperations = new BoundedKeyedSerialExecutor(
      normalizedOptions.maximumPendingOperationsPerGuild
    );
    this.#player = new Player(
      client as unknown as ConstructorParameters<typeof Player>[0],
      {
        connectionTimeout: normalizedOptions.connectionTimeoutMs,
        probeTimeout: normalizedOptions.probeTimeoutMs,
        ffmpegPath: normalizedOptions.ffmpegPath,
        overrideFallbackContext: false,
        queryCache: null,
        skipFFmpeg: false
      }
    );
  }

  public async registerProvider(
    provider: MusicProviderKey,
    signal: AbortSignal
  ): Promise<void> {
    if (this.#shutdownStarted) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The music runtime is stopping.",
        true
      );
    }
    aborted(
      signal,
      new MusicPlaybackError(
        "MUSIC.PROVIDER_UNAVAILABLE",
        "Media provider registration was cancelled.",
        true
      )
    );
    const resolveBridgeProviderIdentifiers = (track: Track) =>
      this.#bridgePolicies.get(track) ?? Object.freeze([]);
    const register = async (): Promise<BaseExtractor | null> => {
      switch (provider) {
        case "youtubei": {
          assertApprovedYtDlpRuntime();
          const probe = await new NodeYtDlpMediaProbeAdapter(
            APPROVED_YT_DLP_PATH
          ).probe({
            timeoutMs: this.#options.probeTimeoutMs,
            signal
          });
          if (probe.state !== "ready") {
            throw new MusicPlaybackError(
              "MUSIC.PROVIDER_UNAVAILABLE",
              "The approved YouTube fallback executable is unavailable.",
              true
            );
          }
          return this.#player.extractors.register(YoutubeExtractor, {
            createStream: createSafeYoutubeStream
          });
        }
        case "soundcloud":
          return this.#player.extractors.register(SoundCloudExtractor, {});
        case "attachment":
          return this.#player.extractors.register(AttachmentExtractor, {});
        case "vimeo":
          return this.#player.extractors.register(VimeoExtractor, {});
        case "reverbnation":
          return this.#player.extractors.register(
            ReverbnationExtractor,
            {}
          );
        case "spotify":
          return this.#player.extractors.register(
            ExplicitBridgeSpotifyExtractor,
            { resolveBridgeProviderIdentifiers }
          );
        case "apple_music":
          return this.#player.extractors.register(
            ExplicitBridgeAppleMusicExtractor,
            { resolveBridgeProviderIdentifiers }
          );
      }
    };
    try {
      const registered = await register();
      if (registered === null) {
        throw new Error("Extractor registration returned no instance.");
      }
      aborted(
        signal,
        new MusicPlaybackError(
          "MUSIC.PROVIDER_UNAVAILABLE",
          "Media provider registration was cancelled.",
          true
        )
      );
    } catch (error: unknown) {
      const identifier = DISCORD_PLAYER_PROVIDER_IDENTIFIERS[provider];
      if (this.#player.extractors.isRegistered(identifier)) {
        try {
          await this.#player.extractors.unregister(identifier);
        } catch {
          // Preserve the isolated activation or cancellation failure.
        }
      }
      throw error;
    }
  }

  #remember(
    track: Track,
    provider: MusicProviderKey,
    guildId: string,
    allowedBridgeProviders: readonly MusicProviderKey[]
  ): MusicRuntimeCandidate {
    const reference = `dp7:${++this.#referenceSequence}`;
    const sanitized = sanitizeMusicMedia({
      provider,
      title: track.title,
      author: track.author,
      canonicalLocator: track.url,
      durationMs: track.durationMS,
      live: track.live,
      allowedRawMediaHosts: this.#allowedRawMediaHosts,
      maximumTrackDurationMs: this.#options.maximumTrackDurationMs
    });
    const media: ResolvedMediaItem = Object.freeze({
      providerReference: reference,
      sourceProvider: provider,
      ...sanitized
    });
    this.#references.set(
      reference,
      Object.freeze({ guildId, track, media })
    );
    if (provider === "spotify" || provider === "apple_music") {
      this.#bridgePolicies.set(
        track,
        Object.freeze(
          allowedBridgeProviders.map(
            (bridgeProvider) =>
              DISCORD_PLAYER_PROVIDER_IDENTIFIERS[bridgeProvider]
          )
        )
      );
    }
    while (
      this.#references.size > this.#options.maximumResolvedReferences
    ) {
      const oldest = this.#references.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.#references.delete(oldest);
    }
    return Object.freeze({ ...media });
  }

  public async resolve(input: {
    readonly guildId: string;
    readonly provider: MusicProviderKey;
    readonly query: string;
    readonly maximumResults: number;
    readonly allowedBridgeProviders: readonly MusicProviderKey[];
    readonly signal: AbortSignal;
  }): Promise<readonly MusicRuntimeCandidate[]> {
    if (this.#shutdownStarted) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The music runtime is stopping.",
        true
      );
    }
    const cancellationError = new MusicPlaybackError(
      "MUSIC.MEDIA_RESOLUTION_TIMEOUT",
      "Media resolution was cancelled.",
      true
    );
    aborted(input.signal, cancellationError);
    if (
      input.provider === "attachment" &&
      !input.query.toLowerCase().startsWith("https://")
    ) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_SOURCE_NOT_ALLOWED",
        "Attachment media must use a secure remote locator.",
        false
      );
    }
    const identifier =
      DISCORD_PLAYER_PROVIDER_IDENTIFIERS[input.provider];
    if (!this.#player.extractors.isRegistered(identifier)) {
      throw new MusicPlaybackError(
        "MUSIC.PROVIDER_UNAVAILABLE",
        "The selected media provider is not registered.",
        true
      );
    }
    const result = await this.#player.search(input.query, {
      searchEngine: `ext:${identifier}`,
      ignoreCache: true
    });
    aborted(input.signal, cancellationError);
    const candidates: MusicRuntimeCandidate[] = [];
    for (const track of result.tracks.slice(0, input.maximumResults)) {
      try {
        candidates.push(
          this.#remember(
            track,
            input.provider,
            input.guildId,
            input.allowedBridgeProviders
          )
        );
      } catch {
        // Invalid provider metadata is skipped without poisoning siblings.
      }
    }
    return Object.freeze(candidates);
  }

  #requireReference(
    providerReference: string,
    guildId: string
  ): Readonly<{
    guildId: string;
    track: Track;
    media: ResolvedMediaItem;
  }> {
    const resolved = this.#references.get(providerReference);
    if (resolved === undefined) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_NOT_FOUND",
        "The resolved media reference has expired.",
        false
      );
    }
    if (resolved.guildId !== guildId) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_SOURCE_NOT_ALLOWED",
        "The resolved media reference belongs to another guild.",
        false
      );
    }
    return resolved;
  }

  #requireQueue(guildId: string): GuildQueue<MusicQueueMetadata> {
    const queue = this.#player.nodes.get<MusicQueueMetadata>(guildId);
    if (queue === null) {
      throw new MusicPlaybackError(
        "MUSIC.SESSION_NOT_FOUND",
        "No active music session exists for this guild.",
        false
      );
    }
    return queue;
  }

  #assertChannel(
    queue: GuildQueue<MusicQueueMetadata>,
    voiceChannelId: string
  ): void {
    const actual = queue.channel?.id ?? queue.metadata.voiceChannelId;
    if (actual !== voiceChannelId) {
      throw new MusicPlaybackError(
        "MUSIC.SESSION_CHANNEL_CONFLICT",
        "The active music session belongs to another voice channel.",
        false
      );
    }
  }

  #mediaForTrack(track: Track | null): ResolvedMediaItem | null {
    if (track === null) return null;
    for (const value of this.#references.values()) {
      if (value.track === track) return value.media;
    }
    const identifier = track.extractor?.identifier;
    const sourceProvider = (
      Object.entries(DISCORD_PLAYER_PROVIDER_IDENTIFIERS) as Array<
        [MusicProviderKey, string]
      >
    ).find((entry) => entry[1] === identifier)?.[0];
    if (sourceProvider === undefined) return null;
    try {
      const sanitized = sanitizeMusicMedia({
        provider: sourceProvider,
        title: track.title,
        author: track.author,
        canonicalLocator: track.url,
        durationMs: track.durationMS,
        live: track.live,
        allowedRawMediaHosts: this.#allowedRawMediaHosts,
        maximumTrackDurationMs: this.#options.maximumTrackDurationMs
      });
      return Object.freeze({
        providerReference: `runtime:${track.id}`,
        sourceProvider,
        ...sanitized
      });
    } catch {
      return null;
    }
  }

  #snapshot(
    queue: GuildQueue<MusicQueueMetadata>
  ): MusicSessionSnapshot {
    return Object.freeze({
      guildId: queue.guild.id,
      voiceChannelId: queue.channel?.id ?? queue.metadata.voiceChannelId,
      state: queueState(queue),
      current: this.#mediaForTrack(queue.currentTrack),
      queuedItemCount: queue.tracks.size,
      repeatMode: repeatMode(queue),
      autoplay: queue.repeatMode === QueueRepeatMode.AUTOPLAY,
      volume: queue.node.volume
    });
  }

  async #withGuildLock<T>(
    guildId: string,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    const cancellationError = new MusicPlaybackError(
      "MUSIC.PLAYBACK_TIMEOUT",
      "The guild music operation was cancelled.",
      true
    );
    aborted(signal, cancellationError);
    if (this.#shutdownStarted) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The music runtime is stopping.",
        true
      );
    }
    return await this.#guildOperations.run(guildId, signal, async () => {
      aborted(signal, cancellationError);
      if (this.#shutdownStarted) {
        throw new MusicPlaybackError(
          "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
          "The music runtime is stopping.",
          true
        );
      }
      return await operation();
    });
  }

  public async enqueue(input: {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly providerReference: string;
    readonly maximumQueueItems: number;
    readonly defaultVolume: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<MusicSessionSnapshot> {
    return await this.#withGuildLock(input.guildId, input.signal, async () =>
      await this.#enqueueUnlocked(input)
    );
  }

  async #enqueueUnlocked(input: {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly providerReference: string;
    readonly maximumQueueItems: number;
    readonly defaultVolume: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<MusicSessionSnapshot> {
    if (this.#shutdownStarted) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The music runtime is stopping.",
        true
      );
    }
    const cancellationError = new MusicPlaybackError(
      "MUSIC.PLAYBACK_TIMEOUT",
      "Media playback was cancelled.",
      true
    );
    aborted(input.signal, cancellationError);
    const resolved = this.#requireReference(
      input.providerReference,
      input.guildId
    );
    this.#reconcileActiveSessions();
    const existing =
      this.#player.nodes.get<MusicQueueMetadata>(input.guildId);
    if (existing !== null) {
      this.#assertChannel(existing, input.voiceChannelId);
      if (
        existing.size + (existing.currentTrack === null ? 0 : 1) >=
        input.maximumQueueItems
      ) {
        throw new MusicPlaybackError(
          "MUSIC.QUEUE_LIMIT_REACHED",
          "The guild music queue reached its configured limit.",
          false
        );
      }
      existing.setMaxSize(input.maximumQueueItems);
      this.#activeSessions.add(input.guildId);
    }

    const reservationRequired = existing === null;
    if (reservationRequired) {
      if (
        this.#activeSessions.size + this.#pendingSessions.size >=
        this.#options.maximumActiveSessions
      ) {
        throw new MusicPlaybackError(
          "MUSIC.OPERATION_CAPACITY_EXHAUSTED",
          "The active music session capacity is temporarily exhausted.",
          true
        );
      }
      this.#pendingSessions.add(input.guildId);
    }

    try {
      const channel = await awaitWithSignal(
        this.#client.channels.fetch(input.voiceChannelId),
        input.signal,
        cancellationError
      );
      aborted(input.signal, cancellationError);
      if (
        !isGuildVoiceChannel(channel) ||
        channel.guildId !== input.guildId
      ) {
        throw new MusicPlaybackError(
          "MUSIC.SESSION_CHANNEL_CONFLICT",
          "The requested voice channel is not available in this guild.",
          false
        );
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort(
          new MusicPlaybackError(
            "MUSIC.PLAYBACK_TIMEOUT",
            "Media playback exceeded its configured deadline.",
            true
          )
        );
      }, input.timeoutMs);
      const signal = AbortSignal.any([input.signal, controller.signal]);
      try {
        const initialized = await this.#player.play(
          channel as unknown as Parameters<Player["play"]>[0],
          resolved.track,
          {
            signal,
            nodeOptions: {
              metadata: Object.freeze({
                guildId: input.guildId,
                voiceChannelId: input.voiceChannelId
              }),
              maxSize: input.maximumQueueItems,
              volume: input.defaultVolume,
              leaveOnEmpty: true,
              leaveOnEmptyCooldown: 60_000,
              leaveOnEnd: true,
              leaveOnEndCooldown: 30_000,
              leaveOnStop: true,
              leaveOnStopCooldown: 0,
              preferBridgedMetadata: false
            }
          }
        );
        aborted(signal, cancellationError);
        this.#activeSessions.add(input.guildId);
        return this.#snapshot(initialized.queue);
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      if (reservationRequired) {
        this.#pendingSessions.delete(input.guildId);
        if (this.#player.nodes.get(input.guildId) !== null) {
          this.#activeSessions.add(input.guildId);
        }
      }
    }
  }

  #reconcileActiveSessions(): void {
    for (const guildId of this.#activeSessions) {
      if (this.#player.nodes.get(guildId) === null) {
        this.#activeSessions.delete(guildId);
      }
    }
  }

  public async control(input: {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly control: MusicPlaybackControl;
    readonly signal: AbortSignal;
  }): Promise<MusicSessionSnapshot | null> {
    return await this.#withGuildLock(input.guildId, input.signal, async () =>
      await this.#controlUnlocked(input)
    );
  }

  async #controlUnlocked(input: {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly control: MusicPlaybackControl;
    readonly signal: AbortSignal;
  }): Promise<MusicSessionSnapshot | null> {
    if (this.#shutdownStarted) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The music runtime is stopping.",
        true
      );
    }
    aborted(
      input.signal,
      new MusicPlaybackError(
        "MUSIC.PLAYBACK_TIMEOUT",
        "The playback control was cancelled.",
        true
      )
    );
    const queue = this.#requireQueue(input.guildId);
    this.#assertChannel(queue, input.voiceChannelId);
    switch (input.control.kind) {
      case "pause":
        if (!queue.node.isPaused()) queue.node.pause();
        break;
      case "resume":
        if (queue.node.isPaused()) queue.node.resume();
        break;
      case "toggle":
        queue.node.setPaused(!queue.node.isPaused());
        break;
      case "skip":
        if (!queue.node.skip()) {
          throw new MusicPlaybackError(
            "MUSIC.CONTROL_INVALID",
            "The current track cannot be skipped.",
            false
          );
        }
        break;
      case "shuffle":
        queue.tracks.shuffle();
        break;
      case "set_repeat":
        queue.setRepeatMode(
          input.control.mode === "track"
            ? QueueRepeatMode.TRACK
            : input.control.mode === "queue"
              ? QueueRepeatMode.QUEUE
              : QueueRepeatMode.OFF
        );
        break;
      case "set_autoplay":
        if (input.control.enabled) {
          queue.setRepeatMode(QueueRepeatMode.AUTOPLAY);
        } else if (queue.repeatMode === QueueRepeatMode.AUTOPLAY) {
          queue.setRepeatMode(QueueRepeatMode.OFF);
        }
        break;
      case "set_volume":
        if (
          !Number.isSafeInteger(input.control.volume) ||
          input.control.volume < 0 ||
          input.control.volume > 100
        ) {
          throw new MusicPlaybackError(
            "MUSIC.CONTROL_INVALID",
            "Volume must be an integer between 0 and 100.",
            false
          );
        }
        queue.node.setVolume(input.control.volume);
        break;
      case "stop":
        queue.node.stop(true);
        queue.delete();
        this.#activeSessions.delete(input.guildId);
        return null;
    }
    aborted(
      input.signal,
      new MusicPlaybackError(
        "MUSIC.PLAYBACK_TIMEOUT",
        "The playback control was cancelled.",
        true
      )
    );
    return this.#snapshot(queue);
  }

  public async session(
    guildId: string,
    signal: AbortSignal
  ): Promise<MusicSessionSnapshot | null> {
    return await this.#withGuildLock(guildId, signal, async () =>
      await this.#sessionUnlocked(guildId, signal)
    );
  }

  async #sessionUnlocked(
    guildId: string,
    signal: AbortSignal
  ): Promise<MusicSessionSnapshot | null> {
    if (this.#shutdownStarted) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The music runtime is stopping.",
        true
      );
    }
    aborted(
      signal,
      new MusicPlaybackError(
        "MUSIC.PLAYBACK_TIMEOUT",
        "The playback session query was cancelled.",
        true
      )
    );
    const queue = this.#player.nodes.get<MusicQueueMetadata>(guildId);
    return queue === null ? null : this.#snapshot(queue);
  }

  public async destroy(signal: AbortSignal): Promise<void> {
    if (this.#destroyed) return;
    this.#shutdownStarted = true;
    const cancellationError = new MusicPlaybackError(
      "MUSIC.PLAYBACK_TIMEOUT",
      "Music runtime shutdown was cancelled.",
      true
    );
    aborted(signal, cancellationError);
    if (this.#destroyOperation === null) {
      this.#references.clear();
      this.#activeSessions.clear();
      this.#pendingSessions.clear();
      const operation = this.#player.destroy();
      this.#destroyOperation = operation;
      void operation.then(
        () => {
          this.#destroyed = true;
          this.#onDestroyed();
          if (this.#destroyOperation === operation) {
            this.#destroyOperation = null;
          }
        },
        () => {
          if (this.#destroyOperation === operation) {
            this.#destroyOperation = null;
          }
        }
      );
    }
    await awaitWithSignal(
      this.#destroyOperation,
      signal,
      cancellationError
    );
  }
}

const NODE_DISCORD_PROVIDER_EXTENSION_PROTOCOL = Symbol.for(
  "@anto-project/discord-bot-core/provider-extension/v1"
);

const compatibleDiscordClient = (providerClient: unknown): Client => {
  if (
    providerClient === null ||
    typeof providerClient !== "object" ||
    !("options" in providerClient) ||
    !("channels" in providerClient) ||
    typeof (providerClient as { readonly channels?: { fetch?: unknown } })
      .channels?.fetch !== "function"
  ) {
    throw new TypeError(
      "The music extension requires a compatible Discord provider client."
    );
  }
  const client = providerClient as Client;
  if (
    !client.options.intents.has(GatewayIntentBits.Guilds) ||
    !client.options.intents.has(GatewayIntentBits.GuildVoiceStates)
  ) {
    throw new TypeError(
      "The music extension requires Guilds and GuildVoiceStates intents."
    );
  }
  return client;
};

/**
 * Discord Player v7 extension for discord-bot-core's opaque provider host.
 * The provider client exists only inside this concrete adapter and is rebound
 * whenever the owning Discord gateway advances to a new client generation.
 */
export class NodeDiscordPlayerExtension
  implements MusicPlaybackRuntimeFactory
{
  #client: Client | null = null;
  #generation: number | null = null;
  #activeRuntime: NodeDiscordPlayerRuntime | null = null;

  public constructor() {
    Object.defineProperty(this, NODE_DISCORD_PROVIDER_EXTENSION_PROTOCOL, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        key: "music-playback.discord-player",
        bindProviderClient: (
          providerClient: unknown,
          generation: number
        ): void => this.#bindProviderClient(providerClient, generation),
        releaseProviderClient: async (
          generation: number,
          signal: AbortSignal
        ): Promise<void> =>
          await this.#releaseProviderClient(generation, signal)
      })
    });
  }

  #bindProviderClient(
    providerClient: unknown,
    generation: number
  ): void {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError("The Discord provider generation is invalid.");
    }
    const client = compatibleDiscordClient(providerClient);
    if (this.#client === client && this.#generation === generation) return;
    if (this.#client !== null || this.#activeRuntime !== null) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The previous Discord music generation is still active.",
        true
      );
    }
    this.#client = client;
    this.#generation = generation;
  }

  async #releaseProviderClient(
    generation: number,
    signal: AbortSignal
  ): Promise<void> {
    if (this.#generation !== generation) return;
    const runtime = this.#activeRuntime;
    this.#client = null;
    this.#generation = null;
    if (runtime !== null) await runtime.destroy(signal);
  }

  public create(
    options: MusicPlaybackRuntimeOptions
  ): MusicPlaybackRuntime {
    const client = this.#client;
    if (client === null || this.#generation === null) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "The Discord provider client is not bound to the music extension.",
        true
      );
    }
    if (this.#activeRuntime !== null) {
      throw new MusicPlaybackError(
        "MUSIC.MEDIA_ENGINE_UNAVAILABLE",
        "A Discord music runtime is already active.",
        true
      );
    }
    let runtime!: NodeDiscordPlayerRuntime;
    runtime = new NodeDiscordPlayerRuntime(client, options, () => {
      if (this.#activeRuntime === runtime) this.#activeRuntime = null;
    });
    this.#activeRuntime = runtime;
    return runtime;
  }
}
