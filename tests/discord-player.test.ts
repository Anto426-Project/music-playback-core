import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client, GatewayIntentBits } from "discord.js";

import {
  NodeDiscordPlayerExtension
} from "../src/discord-player.js";
import type {
  MusicPlaybackRuntimeOptions
} from "../src/runtime.js";

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

type ProviderExtensionProtocol = Readonly<{
  bindProviderClient(providerClient: unknown, generation: number): void;
  releaseProviderClient(
    generation: number,
    signal: AbortSignal
  ): Promise<void>;
}>;

const protocolFor = (
  extension: NodeDiscordPlayerExtension
): ProviderExtensionProtocol => {
  const descriptor = Object.getOwnPropertyDescriptor(
    extension,
    Symbol.for("@anto-project/discord-bot-core/provider-extension/v1")
  );
  assert.ok(descriptor && "value" in descriptor);
  return descriptor.value as ProviderExtensionProtocol;
};

describe("NodeDiscordPlayerExtension", () => {
  it("rejects runtime creation before an opaque provider is bound", () => {
    const extension = new NodeDiscordPlayerExtension();
    assert.throws(() => extension.create(runtimeOptions), /not bound/u);
    assert.throws(
      () => protocolFor(extension).bindProviderClient(Object.freeze({}), 1),
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
      const extension = new NodeDiscordPlayerExtension();
      const protocol = protocolFor(extension);
      protocol.bindProviderClient(providerClient, 1);
      const runtime = extension.create(runtimeOptions);
      const signal = new AbortController().signal;

      assert.equal(await runtime.session("guild-without-queue", signal), null);
      await Promise.all([
        protocol.releaseProviderClient(1, signal),
        runtime.destroy(signal)
      ]);
      assert.throws(() => extension.create(runtimeOptions), /not bound/u);
    } finally {
      providerClient.destroy();
    }
  });

  it("fails fast when the gateway lacks voice-state intents", () => {
    const providerClient = new Client({
      intents: [GatewayIntentBits.Guilds]
    });
    try {
      const extension = new NodeDiscordPlayerExtension();
      assert.throws(
        () => protocolFor(extension).bindProviderClient(providerClient, 1),
        /Guilds and GuildVoiceStates/u
      );
    } finally {
      providerClient.destroy();
    }
  });
});
