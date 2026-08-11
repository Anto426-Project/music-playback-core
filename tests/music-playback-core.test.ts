import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
  MUSIC_PROVIDER_KEYS,
  MusicPlaybackClient,
  MusicPlaybackError,
  sanitizeMusicMedia,
  selectMusicProvider,
  type MediaEngineProbeResult,
  type MediaProbePort,
  type MusicPlaybackControl,
  type MusicPlaybackRuntime,
  type MusicPlaybackRuntimeFactory,
  type MusicPlaybackRuntimeOptions,
  type MusicProviderKey,
  type MusicProviderPolicy,
  type MusicRuntimeCandidate,
  type MusicSessionSnapshot
} from "../src/index.js";

const readyProbe: MediaEngineProbeResult = Object.freeze({
  state: "ready",
  version: "8.1.2",
  failureCode: null
});

class MediaProbeFake implements MediaProbePort {
  public readonly calls: number[] = [];

  public constructor(public result = readyProbe) {}

  public async probe(input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<MediaEngineProbeResult> {
    this.calls.push(input.timeoutMs);
    if (input.signal?.aborted === true) throw input.signal.reason;
    return this.result;
  }
}

const mediaCandidate = (
  provider: MusicProviderKey
): MusicRuntimeCandidate => {
  const locator: Record<MusicProviderKey, string> = {
    youtubei: "https://www.youtube.com/watch?v=abc123",
    soundcloud: "https://soundcloud.com/artist/track",
    attachment:
      "https://cdn.discordapp.com/attachments/1/2/audio.ogg",
    vimeo: "https://vimeo.com/123456",
    reverbnation: "https://www.reverbnation.com/artist/song",
    spotify: "https://open.spotify.com/track/abc123",
    apple_music: "https://music.apple.com/it/album/example/123"
  };
  return Object.freeze({
    providerReference: `reference:${provider}`,
    sourceProvider: provider,
    title: `${provider} result`,
    author: "Artist",
    canonicalLocator: locator[provider],
    durationMs: 120_000,
    live: false
  });
};

const sessionSnapshot = (
  guildId: string,
  voiceChannelId: string,
  state: MusicSessionSnapshot["state"] = "playing"
): MusicSessionSnapshot =>
  Object.freeze({
    guildId,
    voiceChannelId,
    state,
    current: null,
    queuedItemCount: 1,
    repeatMode: "off",
    autoplay: false,
    volume: 50
  });

class RuntimeFake implements MusicPlaybackRuntime {
  public readonly registrations: MusicProviderKey[] = [];
  public readonly resolveCalls: Array<{
    provider: MusicProviderKey;
    query: string;
  }> = [];
  public readonly controlCalls: MusicPlaybackControl[] = [];
  public readonly sessions = new Map<string, MusicSessionSnapshot>();
  public registrationFailure: MusicProviderKey | null = null;
  public resolutionFailure = false;
  public waitForRegistrationAbort: MusicProviderKey | null = null;
  public destroyCount = 0;

  public async registerProvider(
    provider: MusicProviderKey,
    signal: AbortSignal
  ): Promise<void> {
    this.registrations.push(provider);
    if (provider === this.waitForRegistrationAbort) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true }
        );
      });
    }
    if (provider === this.registrationFailure) {
      throw new Error("isolated provider failure");
    }
  }

  public async resolve(input: {
    readonly guildId: string;
    readonly provider: MusicProviderKey;
    readonly query: string;
    readonly maximumResults: number;
    readonly allowedBridgeProviders: readonly MusicProviderKey[];
    readonly signal: AbortSignal;
  }): Promise<readonly MusicRuntimeCandidate[]> {
    if (input.signal.aborted) throw input.signal.reason;
    if (this.resolutionFailure) {
      throw new Error("provider resolution failed");
    }
    this.resolveCalls.push({
      provider: input.provider,
      query: input.query
    });
    return Object.freeze([mediaCandidate(input.provider)]);
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
    if (input.signal.aborted) throw input.signal.reason;
    const existing = this.sessions.get(input.guildId);
    if (
      existing !== undefined &&
      existing.voiceChannelId !== input.voiceChannelId
    ) {
      throw new MusicPlaybackError(
        "MUSIC.SESSION_CHANNEL_CONFLICT",
        "another channel owns this session",
        false
      );
    }
    const snapshot = sessionSnapshot(
      input.guildId,
      input.voiceChannelId
    );
    this.sessions.set(input.guildId, snapshot);
    return snapshot;
  }

  public async control(input: {
    readonly guildId: string;
    readonly voiceChannelId: string;
    readonly control: MusicPlaybackControl;
    readonly signal: AbortSignal;
  }): Promise<MusicSessionSnapshot | null> {
    if (input.signal.aborted) throw input.signal.reason;
    this.controlCalls.push(input.control);
    const existing = this.sessions.get(input.guildId) ?? null;
    if (existing === null) return null;
    if (input.control.kind === "stop") {
      this.sessions.delete(input.guildId);
      return null;
    }
    const state =
      input.control.kind === "pause"
        ? "paused"
        : input.control.kind === "resume"
          ? "playing"
          : existing.state;
    const snapshot = sessionSnapshot(
      input.guildId,
      input.voiceChannelId,
      state
    );
    this.sessions.set(input.guildId, snapshot);
    return snapshot;
  }

  public async session(
    guildId: string,
    signal: AbortSignal
  ): Promise<MusicSessionSnapshot | null> {
    if (signal.aborted) throw signal.reason;
    return this.sessions.get(guildId) ?? null;
  }

  public async destroy(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason;
    this.destroyCount += 1;
    this.sessions.clear();
  }
}

class RuntimeFactoryFake implements MusicPlaybackRuntimeFactory {
  public readonly options: MusicPlaybackRuntimeOptions[] = [];

  public constructor(public readonly runtime = new RuntimeFake()) {}

  public create(options: MusicPlaybackRuntimeOptions): MusicPlaybackRuntime {
    this.options.push(options);
    return this.runtime;
  }
}

const policies = (
  priority: readonly MusicProviderKey[] = [
    "youtubei",
    "soundcloud",
    "attachment",
    "vimeo",
    "reverbnation",
    "spotify",
    "apple_music"
  ]
): readonly MusicProviderPolicy[] =>
  Object.freeze(
    priority.map((provider, index) =>
      Object.freeze({ provider, enabled: true, priority: index })
    )
  );

describe("MusicPlaybackClient", () => {
  it("does not construct a runtime when the FFmpeg probe is unavailable", async () => {
    const factory = new RuntimeFactoryFake();
    const probe = new MediaProbeFake(
      Object.freeze({
        state: "unavailable",
        version: null,
        failureCode: "MEDIA_ENGINE.NOT_INSTALLED"
      })
    );
    const client = new MusicPlaybackClient(factory, probe);

    const health = await client.start();

    assert.equal(health.state, "unavailable");
    assert.equal(factory.options.length, 0);
    assert.deepEqual(factory.runtime.registrations, []);
  });

  it("starts single-flight, isolates provider failures and destroys once", async () => {
    const factory = new RuntimeFactoryFake();
    factory.runtime.registrationFailure = "youtubei";
    const probe = new MediaProbeFake();
    const client = new MusicPlaybackClient(factory, probe);

    const [first, second] = await Promise.all([
      client.start(),
      client.start()
    ]);

    assert.strictEqual(first, second);
    assert.equal(first.state, "degraded");
    assert.deepEqual(factory.runtime.registrations, [
      "youtubei",
      "soundcloud",
      "attachment",
      "vimeo",
      "reverbnation",
      "spotify",
      "apple_music"
    ]);
    assert.equal(probe.calls[0], 5_000);
    assert.equal(factory.options.length, 1);

    await Promise.all([client.stop(), client.stop()]);
    assert.equal(factory.runtime.destroyCount, 1);
    assert.equal(client.health().state, "stopped");
  });

  it("bounds a stuck provider registration and continues with siblings", async () => {
    const factory = new RuntimeFactoryFake();
    factory.runtime.waitForRegistrationAbort = "youtubei";
    const client = new MusicPlaybackClient(factory, new MediaProbeFake(), {
      ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
      enabledProviders: Object.freeze(["youtubei", "soundcloud"]),
      bridgeProviderOrder: Object.freeze(["soundcloud"]),
      providerRegistrationTimeoutMs: 100
    });

    const health = await client.start();

    assert.equal(health.state, "degraded");
    assert.deepEqual(factory.runtime.registrations, [
      "youtubei",
      "soundcloud"
    ]);
    assert.equal(
      health.providers.find((entry) => entry.provider === "youtubei")?.state,
      "unavailable"
    );
    assert.equal(
      health.providers.find((entry) => entry.provider === "soundcloud")?.state,
      "ready"
    );
  });

  it("recovers an unavailable provider set without restarting the process", async () => {
    const factory = new RuntimeFactoryFake();
    factory.runtime.registrationFailure = "youtubei";
    const client = new MusicPlaybackClient(factory, new MediaProbeFake(), {
      ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
      enabledProviders: Object.freeze(["youtubei"]),
      bridgeProviderOrder: Object.freeze(["youtubei"])
    });

    assert.equal((await client.start()).state, "unavailable");
    factory.runtime.registrationFailure = null;

    assert.equal((await client.restart()).state, "ready");
    assert.equal(factory.runtime.destroyCount, 1);
    assert.equal(factory.options.length, 2);
  });

  it("aborts in-flight startup before completing stop", async () => {
    const factory = new RuntimeFactoryFake();
    factory.runtime.waitForRegistrationAbort = "youtubei";
    const client = new MusicPlaybackClient(factory, new MediaProbeFake(), {
      ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
      enabledProviders: Object.freeze(["youtubei"]),
      bridgeProviderOrder: Object.freeze(["youtubei"])
    });

    const starting = client.start();
    const rejectedStartup = assert.rejects(starting);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.stop();
    await rejectedStartup;
    assert.equal(factory.runtime.destroyCount, 1);
    assert.equal(client.health().state, "stopped");
  });

  it("selects only enabled providers and revalidates runtime media", async () => {
    const factory = new RuntimeFactoryFake();
    const client = new MusicPlaybackClient(factory, new MediaProbeFake());
    await client.start();

    const resolved = await client.resolve({
      guildId: "guild-1",
      query: "artist title",
      providerPolicies: policies(["soundcloud", "youtubei"])
    });
    assert.equal(resolved.selectedProvider, "soundcloud");
    assert.equal(
      resolved.items[0]?.canonicalLocator,
      "https://soundcloud.com/artist/track"
    );

    await assert.rejects(
      client.resolve({
        guildId: "guild-1",
        query: "/srv/private/audio.mp3",
        providerPolicies: policies()
      }),
      { code: "MUSIC.MEDIA_SOURCE_NOT_ALLOWED" }
    );
  });

  it("opens a provider circuit after repeated failures and recovers explicitly", async () => {
    const factory = new RuntimeFactoryFake();
    const client = new MusicPlaybackClient(factory, new MediaProbeFake(), {
      ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
      enabledProviders: Object.freeze(["soundcloud"]),
      bridgeProviderOrder: Object.freeze(["soundcloud"])
    });
    const providerPolicies = policies(["soundcloud"]);
    await client.start();
    factory.runtime.resolutionFailure = true;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        client.resolve({
          guildId: "guild-1",
          query: "track",
          providerPolicies
        }),
        { code: "MUSIC.PROVIDER_UNAVAILABLE" }
      );
    }
    assert.equal(client.health().state, "unavailable");
    assert.equal(
      client
        .health()
        .providers.find((entry) => entry.provider === "soundcloud")
        ?.failureCode,
      "MUSIC.PROVIDER_CIRCUIT_OPEN"
    );

    factory.runtime.resolutionFailure = false;
    await client.restart();
    assert.equal(
      (
        await client.resolve({
          guildId: "guild-1",
          query: "track",
          providerPolicies
        })
      ).items.length,
      1
    );
  });

  it("keeps one typed session per guild and validates controls", async () => {
    const factory = new RuntimeFactoryFake();
    const client = new MusicPlaybackClient(factory, new MediaProbeFake(), {
      ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
      enabledProviders: Object.freeze(["soundcloud"])
    });
    await client.start();
    const resolved = await client.resolve({
      guildId: "guild-1",
      query: "track query",
      providerPolicies: policies(["soundcloud"])
    });
    const media = resolved.items[0];
    assert.ok(media);

    const started = await client.enqueue({
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      media,
      maximumQueueItems: 100,
      defaultVolume: 50
    });
    assert.equal(started.state, "playing");
    await assert.rejects(
      client.enqueue({
        guildId: "guild-1",
        voiceChannelId: "voice-2",
        media,
        maximumQueueItems: 100,
        defaultVolume: 50
      }),
      { code: "MUSIC.SESSION_CHANNEL_CONFLICT" }
    );
    assert.equal(
      (
        await client.control({
          guildId: "guild-1",
          voiceChannelId: "voice-1",
          control: { kind: "pause" }
        })
      )?.state,
      "paused"
    );
    assert.equal(
      (
        await client.control({
          guildId: "guild-1",
          voiceChannelId: "voice-1",
          control: { kind: "resume" }
        })
      )?.state,
      "playing"
    );
    await client.control({
      guildId: "guild-1",
      voiceChannelId: "voice-1",
      control: { kind: "set_volume", volume: 35 }
    });
    assert.deepEqual(factory.runtime.controlCalls.at(-1), {
      kind: "set_volume",
      volume: 35
    });
    await assert.rejects(
      client.control({
        guildId: "guild-1",
        voiceChannelId: "voice-1",
        control: {
          kind: "set_volume",
          volume: 101
        } as MusicPlaybackControl
      }),
      { code: "MUSIC.CONTROL_INVALID" }
    );
    assert.equal(
      await client.control({
        guildId: "guild-1",
        voiceChannelId: "voice-1",
        control: { kind: "stop" }
      }),
      null
    );
    assert.equal(await client.session("guild-1"), null);
  });

  it("maps malformed runtime snapshots to a safe typed error", async () => {
    const factory = new RuntimeFactoryFake();
    const client = new MusicPlaybackClient(factory, new MediaProbeFake());
    await client.start();
    factory.runtime.sessions.set(
      "guild-bad",
      {
        ...sessionSnapshot("guild-bad", "voice-1"),
        current: undefined
      } as unknown as MusicSessionSnapshot
    );

    await assert.rejects(client.session("guild-bad"), {
      code: "MUSIC.MEDIA_ENGINE_UNAVAILABLE"
    });
  });
});

describe("Music media boundary", () => {
  it("sanitizes metadata and enforces canonical provider hosts", () => {
    const sanitized = sanitizeMusicMedia({
      provider: "youtubei",
      title: `  Title\u0000 ${"x".repeat(500)}  `,
      author: `Artist ${"y".repeat(300)}`,
      canonicalLocator: "https://www.youtube.com/watch?v=abc123",
      durationMs: 180_000,
      live: false,
      allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
      maximumTrackDurationMs: 6 * 60 * 60 * 1_000
    });
    assert.equal([...sanitized.title].length, 300);
    assert.equal([...sanitized.author].length, 200);
    assert.equal(sanitized.title.includes("\u0000"), false);
    assert.throws(
      () =>
        sanitizeMusicMedia({
          provider: "soundcloud",
          title: "Track",
          author: "Artist",
          canonicalLocator: "https://evil.example/audio.mp3",
          durationMs: 1_000,
          live: false,
          allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
          maximumTrackDurationMs: 10_000
        }),
      MusicPlaybackError
    );
  });

  it("rejects ambiguous policies and local locators", () => {
    assert.throws(
      () =>
        selectMusicProvider({
          query: "track",
          providerPolicies: [
            { provider: "youtubei", enabled: true, priority: 0 },
            { provider: "soundcloud", enabled: true, priority: 0 }
          ],
          readyProviders: new Set(["youtubei", "soundcloud"]),
          allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
          maximumQueryLength: 500
        }),
      MusicPlaybackError
    );
    assert.throws(
      () =>
        selectMusicProvider({
          query: "file:///private/audio.mp3",
          providerPolicies: policies(),
          readyProviders: new Set(MUSIC_PROVIDER_KEYS),
          allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
          maximumQueryLength: 500
        }),
      MusicPlaybackError
    );
    assert.throws(
      () =>
        selectMusicProvider({
          query: "x".repeat(4_000),
          providerPolicies: policies(),
          readyProviders: new Set(MUSIC_PROVIDER_KEYS),
          allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
          maximumQueryLength: 500
        }),
      MusicPlaybackError
    );
    assert.throws(
      () =>
        new MusicPlaybackClient(
          new RuntimeFactoryFake(),
          new MediaProbeFake(),
          {
            ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
            ffmpegPath: "/tmp/ffmpeg"
          }
        ),
      /FFmpeg path/u
    );
    assert.throws(
      () =>
        new MusicPlaybackClient(
          new RuntimeFactoryFake(),
          new MediaProbeFake(),
          {
            ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
            allowedRawMediaHosts: Object.freeze(["localhost."])
          }
        ),
      /DNS hostnames/u
    );
  });

  it("routes metadata and attachment locators and rejects impossible duration", () => {
    const readyProviders = new Set(MUSIC_PROVIDER_KEYS);
    assert.equal(
      selectMusicProvider({
        query: "https://open.spotify.com/track/abc123",
        providerPolicies: policies(),
        readyProviders,
        allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
        maximumQueryLength: 500
      }).provider,
      "spotify"
    );
    assert.equal(
      selectMusicProvider({
        query:
          "https://cdn.discordapp.com/attachments/1/2/audio.ogg",
        providerPolicies: policies(),
        readyProviders,
        allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
        maximumQueryLength: 500
      }).provider,
      "attachment"
    );
    assert.throws(
      () =>
        sanitizeMusicMedia({
          provider: "youtubei",
          title: "Track",
          author: "Artist",
          canonicalLocator:
            "https://www.youtube.com/watch?v=abc123",
          durationMs: 10_001,
          live: false,
          allowedRawMediaHosts: new Set(["cdn.discordapp.com"]),
          maximumTrackDurationMs: 10_000
        }),
      MusicPlaybackError
    );
  });
});
