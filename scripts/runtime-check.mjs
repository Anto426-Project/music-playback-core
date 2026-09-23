// Exercises the real provider registration and local executables without logging
// in to Discord or creating a voice session. No tokens or .env file are needed.
import { createRequire } from "node:module";
import { Client, GatewayIntentBits } from "discord.js";
import { MusicPlaybackClient } from "../dist/index.js";
import { NodeDiscordPlayerProviderBinding } from "../dist/discord-player.js";
import { NodeFfmpegMediaProbeAdapter } from "../dist/node.js";

// discord-voip loads DAVE only when opening a voice socket. Fail deployment
// before the bot starts if the native addon needed for that path is missing.
const require = createRequire(import.meta.url);
const daveProtocolVersion = require("@snazzah/davey").DAVE_PROTOCOL_VERSION;
if (!Number.isInteger(daveProtocolVersion) || daveProtocolVersion < 1) {
  throw new Error("The DAVE voice protocol addon is unavailable.");
}

const gateway = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const binding = new NodeDiscordPlayerProviderBinding();
binding.bindProviderClient(gateway, 1);
const client = new MusicPlaybackClient(binding, new NodeFfmpegMediaProbeAdapter());
try {
  const health = await client.start(AbortSignal.timeout(110_000));
  console.log(JSON.stringify({ check: "music-runtime", ...health }));
  if (health.state !== "ready") process.exitCode = 1;
} finally {
  await client.stop();
  await binding.releaseProviderClient(1, AbortSignal.timeout(10_000));
  await gateway.destroy();
}
