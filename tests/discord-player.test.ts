import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client, GatewayIntentBits } from "discord.js";

import {
  NodeDiscordPlayerProviderBinding
} from "../src/discord-player.js";
import type {
  MusicPlaybackRuntimeOptions
} from "../src/runtime.js";

const deferred = <T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
}> => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
};

const runtimeOptions: MusicPlaybackRuntimeOptions = Object.freeze({
  ffmpegPath: "/usr/bin/ffmpeg",
  connectionTimeoutMs: 15_000,
  probeTimeoutMs: 5_000,
  maximumResolvedReferences: 100,
  maximumPendingOperationsPerGuild: 4,
  maximumActiveSessions: 8,
  maximumTrackDurationMs: 6 * 60 * 60 * 1_000,
  allowedRawMediaHosts: Object.freeze([
    "cdn.discordapp.com",
    "media.discordapp.net"
  ]),
  bridgeProviderOrder: Object.freeze(["youtubei", "soundcloud"] as const)
});

describe("NodeDiscordPlayerProviderBinding", () => {
  it("rejects runtime creation before an opaque provider is bound", () => {
    const binding = new NodeDiscordPlayerProviderBinding();
    assert.throws(() => binding.create(runtimeOptions), /not bound/u);
    assert.throws(
      () => binding.bindProviderClient(Object.freeze({}), 1),
      /compatible Discord provider client/u
    );
  });

  it("constructs the real v7 adapter behind core-owned contracts", async () => {
    const providerClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });
    try {
      const binding = new NodeDiscordPlayerProviderBinding();
      binding.bindProviderClient(providerClient, 1);
      const runtime = binding.create(runtimeOptions);
      const signal = new AbortController().signal;

      assert.equal(await runtime.session("guild-without-queue", signal), null);
      await Promise.all([
        binding.releaseProviderClient(1, signal),
        runtime.destroy(signal)
      ]);
      assert.throws(() => binding.create(runtimeOptions), /not bound/u);
    } finally {
      providerClient.destroy();
    }
  });

  it("fails fast when the gateway lacks voice-state intents", () => {
    const providerClient = new Client({
      intents: [GatewayIntentBits.Guilds]
    });
    try {
      const binding = new NodeDiscordPlayerProviderBinding();
      assert.throws(
        () => binding.bindProviderClient(providerClient, 1),
        /Guilds and GuildVoiceStates/u
      );
    } finally {
      providerClient.destroy();
    }
  });

  it("ignores stale release calls and rejects reused generations", async () => {
    const providerClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });
    try {
      const binding = new NodeDiscordPlayerProviderBinding();
      binding.bindProviderClient(providerClient, 4);
      binding.bindProviderClient(providerClient, 4);

      const signal = new AbortController().signal;
      await binding.releaseProviderClient(3, signal);
      const runtime = binding.create(runtimeOptions);
      await runtime.destroy(signal);
      await binding.releaseProviderClient(4, signal);

      assert.throws(
        () => binding.bindProviderClient(providerClient, 4),
        /advance monotonically/u
      );
      binding.bindProviderClient(providerClient, 5);
      await binding.releaseProviderClient(5, signal);
    } finally {
      providerClient.destroy();
    }
  });

  it("retains the bound generation until runtime destruction succeeds", async () => {
    const providerClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });
    try {
      const binding = new NodeDiscordPlayerProviderBinding();
      binding.bindProviderClient(providerClient, 7);
      binding.create(runtimeOptions);

      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        binding.releaseProviderClient(7, cancelled.signal),
        (error: unknown) =>
          error instanceof DOMException && error.name === "AbortError"
      );
      assert.throws(
        () => binding.create(runtimeOptions),
        /already active/u
      );

      await binding.releaseProviderClient(
        7,
        new AbortController().signal
      );
      assert.throws(() => binding.create(runtimeOptions), /not bound/u);
    } finally {
      providerClient.destroy();
    }
  });

  it("clears failed release state without discarding the bound generation", async () => {
    const providerClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });
    try {
      const binding = new NodeDiscordPlayerProviderBinding();
      binding.bindProviderClient(providerClient, 9);
      const runtime = binding.create(runtimeOptions);
      const originalDestroy = runtime.destroy.bind(runtime);
      let destroyAttempts = 0;
      runtime.destroy = async (signal: AbortSignal): Promise<void> => {
        destroyAttempts += 1;
        if (destroyAttempts === 1) {
          throw new Error("controlled destroy failure");
        }
        await originalDestroy(signal);
      };

      const signal = new AbortController().signal;
      await assert.rejects(
        binding.releaseProviderClient(9, signal),
        /controlled destroy failure/u
      );
      assert.throws(
        () => binding.create(runtimeOptions),
        /already active/u
      );
      binding.bindProviderClient(providerClient, 9);

      await binding.releaseProviderClient(9, signal);
      assert.equal(destroyAttempts, 2);
      assert.throws(() => binding.create(runtimeOptions), /not bound/u);
    } finally {
      providerClient.destroy();
    }
  });

  it("single-flights release and closes the post-destroy creation window", async () => {
    const providerClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
      ]
    });
    try {
      const binding = new NodeDiscordPlayerProviderBinding();
      binding.bindProviderClient(providerClient, 11);
      const runtime = binding.create(runtimeOptions);
      const originalDestroy = runtime.destroy.bind(runtime);
      const destroyEntered = deferred<void>();
      const allowDestroy = deferred<void>();
      const runtimeDestroyed = deferred<void>();
      const allowReleaseReturn = deferred<void>();
      let destroyCalls = 0;
      runtime.destroy = async (signal: AbortSignal): Promise<void> => {
        destroyCalls += 1;
        destroyEntered.resolve();
        await allowDestroy.promise;
        await originalDestroy(signal);
        runtimeDestroyed.resolve();
        await allowReleaseReturn.promise;
      };

      const signal = new AbortController().signal;
      const firstRelease = binding.releaseProviderClient(11, signal);
      await destroyEntered.promise;
      const secondRelease = binding.releaseProviderClient(11, signal);

      assert.equal(destroyCalls, 1);
      assert.throws(
        () => binding.create(runtimeOptions),
        /being released/u
      );
      assert.throws(
        () => binding.bindProviderClient(providerClient, 11),
        /being released/u
      );

      allowDestroy.resolve();
      await runtimeDestroyed.promise;
      // The runtime callback has now removed the active runtime, while the
      // release continuation is deliberately held. A new runtime here would
      // become orphaned when the release clears the provider generation.
      assert.throws(
        () => binding.create(runtimeOptions),
        /being released/u
      );
      assert.throws(
        () => binding.bindProviderClient(providerClient, 12),
        /being released/u
      );

      allowReleaseReturn.resolve();
      await Promise.all([firstRelease, secondRelease]);
      assert.equal(destroyCalls, 1);
      assert.throws(() => binding.create(runtimeOptions), /not bound/u);
    } finally {
      providerClient.destroy();
    }
  });
});
