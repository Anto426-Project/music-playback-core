import { AppleMusicExtractor, AttachmentExtractor, ReverbnationExtractor, SoundCloudExtractor, SpotifyExtractor, VimeoExtractor } from "@discord-player/extractor";
import { BaseExtractor, Player, QueueRepeatMode } from "discord-player";
import { YoutubeExtractor } from "discord-player-youtubei";
import { spawn } from "node:child_process";
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import { sanitizeMusicMedia } from "./media.js";
import { MUSIC_STREAM_PROVIDER_KEYS, MusicPlaybackError } from "./models.js";
import { NodeYtDlpMediaProbeAdapter } from "./node.js";
import { BoundedKeyedSerialExecutor } from "./serial-executor.js";
const DISCORD_PLAYER_PROVIDER_IDENTIFIERS = Object.freeze({
    youtubei: "com.retrouser955.discord-player.discord-player-youtubei",
    soundcloud: "com.discord-player.soundcloudextractor",
    attachment: "com.discord-player.attachmentextractor",
    vimeo: "com.discord-player.vimeoextractor",
    reverbnation: "com.discord-player.reverbnationextractor",
    spotify: "com.discord-player.spotifyextractor",
    apple_music: "com.discord-player.applemusicextractor"
});
const APPROVED_YT_DLP_PATH = "/usr/bin/yt-dlp";
const createSafeYoutubeStream = async (track) => {
    const locator = new URL(track.url);
    if (locator.protocol !== "https:" ||
        ![
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "youtu.be"
        ].includes(locator.hostname.toLowerCase())) {
        throw new MusicPlaybackError("MUSIC.MEDIA_SOURCE_NOT_ALLOWED", "The YouTube stream locator is not approved.", false);
    }
    const child = spawn(APPROVED_YT_DLP_PATH, [
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
    ], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
    });
    const stream = child.stdout;
    child.stderr.resume();
    const failStream = () => {
        if (!stream.destroyed) {
            stream.destroy(new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The YouTube fallback process failed.", true));
        }
    };
    child.once("error", failStream);
    child.once("close", (code) => {
        if (code !== 0)
            failStream();
    });
    // A provider failure may happen before Discord Player attaches its own
    // listener. This no-op listener prevents an unhandled stream error while
    // preserving the error for every subsequently attached consumer.
    stream.on("error", () => undefined);
    const stopChild = () => {
        if (child.exitCode === null &&
            child.signalCode === null &&
            !child.killed) {
            child.kill("SIGTERM");
        }
    };
    stream.once("close", stopChild);
    stream.once("error", stopChild);
    stream.once("end", stopChild);
    return stream;
};
const aborted = (signal, fallback) => {
    if (signal.aborted)
        throw signal.reason ?? fallback;
};
const awaitWithSignal = async (operation, signal, fallback) => {
    aborted(signal, fallback);
    return await new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? fallback);
        signal.addEventListener("abort", onAbort, { once: true });
        void operation.then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", onAbort);
        });
    });
};
const requestExplicitBridge = async (source, track, providerIdentifiers) => {
    for (const identifier of providerIdentifiers) {
        if (identifier === source.identifier ||
            !source.context.isRegistered(identifier)) {
            continue;
        }
        try {
            const bridged = await source.context.requestBridgeFrom(track, source, identifier);
            if (bridged !== null)
                return bridged;
        }
        catch {
            // Provider failures are isolated so the configured bridge chain continues.
        }
    }
    throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "No configured streaming provider could bridge the metadata track.", true);
};
class ExplicitBridgeSpotifyExtractor extends SpotifyExtractor {
    #resolveBridgeProviderIdentifiers;
    constructor(context, options) {
        super(context, options);
        this.#resolveBridgeProviderIdentifiers =
            options.resolveBridgeProviderIdentifiers;
    }
    stream(track) {
        return requestExplicitBridge(this, track, this.#resolveBridgeProviderIdentifiers(track));
    }
}
class ExplicitBridgeAppleMusicExtractor extends AppleMusicExtractor {
    #resolveBridgeProviderIdentifiers;
    constructor(context, options) {
        super(context, options);
        this.#resolveBridgeProviderIdentifiers =
            options.resolveBridgeProviderIdentifiers;
    }
    stream(track) {
        return requestExplicitBridge(this, track, this.#resolveBridgeProviderIdentifiers(track));
    }
}
const assertProviderIdentifiers = () => {
    const actual = {
        youtubei: YoutubeExtractor.identifier,
        soundcloud: SoundCloudExtractor.identifier,
        attachment: AttachmentExtractor.identifier,
        vimeo: VimeoExtractor.identifier,
        reverbnation: ReverbnationExtractor.identifier,
        spotify: SpotifyExtractor.identifier,
        apple_music: AppleMusicExtractor.identifier
    };
    for (const [provider, expected] of Object.entries(DISCORD_PLAYER_PROVIDER_IDENTIFIERS)) {
        if (actual[provider] !== expected) {
            throw new TypeError(`Unexpected Discord Player identifier for ${provider}.`);
        }
    }
};
const runtimeInteger = (value, minimum, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < minimum ||
        value > maximum) {
        throw new TypeError(`${label} is outside the supported boundary.`);
    }
    return value;
};
const runtimeStringArray = (value, maximum, label, validate) => {
    if (!Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > maximum) {
        throw new TypeError(`${label} must be a plain bounded array.`);
    }
    const entries = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined ||
            !("value" in descriptor) ||
            typeof descriptor.value !== "string" ||
            !validate(descriptor.value)) {
            throw new TypeError(`${label} contains an invalid entry.`);
        }
        entries.push(descriptor.value);
    }
    if (new Set(entries).size !== entries.length) {
        throw new TypeError(`${label} cannot contain duplicates.`);
    }
    return Object.freeze(entries);
};
const normalizeRuntimeOptions = (options) => {
    if (options.ffmpegPath !== "/usr/bin/ffmpeg") {
        throw new TypeError("The runtime FFmpeg path is not approved.");
    }
    const allowedRawMediaHosts = runtimeStringArray(options.allowedRawMediaHosts, 256, "Allowed raw media hosts", (host) => host.length >= 3 &&
        host.length <= 253 &&
        host.includes(".") &&
        !host.endsWith(".") &&
        /^[a-z0-9.-]+$/u.test(host));
    const bridgeProviderOrder = runtimeStringArray(options.bridgeProviderOrder, MUSIC_STREAM_PROVIDER_KEYS.length, "Bridge provider order", (provider) => MUSIC_STREAM_PROVIDER_KEYS.includes(provider));
    return Object.freeze({
        ffmpegPath: options.ffmpegPath,
        connectionTimeoutMs: runtimeInteger(options.connectionTimeoutMs, 100, 120_000, "Connection timeout"),
        probeTimeoutMs: runtimeInteger(options.probeTimeoutMs, 100, 30_000, "Probe timeout"),
        maximumResolvedReferences: runtimeInteger(options.maximumResolvedReferences, 1, 50_000, "Resolved reference limit"),
        maximumPendingOperationsPerGuild: runtimeInteger(options.maximumPendingOperationsPerGuild, 1, 64, "Per-guild pending operation limit"),
        maximumActiveSessions: runtimeInteger(options.maximumActiveSessions, 1, 1_000, "Active session limit"),
        maximumTrackDurationMs: runtimeInteger(options.maximumTrackDurationMs, 1, 24 * 60 * 60 * 1_000, "Track duration limit"),
        allowedRawMediaHosts,
        bridgeProviderOrder
    });
};
const repeatMode = (queue) => {
    if (queue.repeatMode === QueueRepeatMode.TRACK)
        return "track";
    if (queue.repeatMode === QueueRepeatMode.QUEUE)
        return "queue";
    return "off";
};
const queueState = (queue) => {
    if (queue.node.isPaused())
        return "paused";
    if (queue.node.isBuffering())
        return "connecting";
    if (queue.node.isPlaying())
        return "playing";
    return "idle";
};
const isGuildVoiceChannel = (channel) => typeof channel === "object" &&
    channel !== null &&
    "guildId" in channel &&
    typeof channel.guildId === "string" &&
    "type" in channel &&
    (channel.type === ChannelType.GuildVoice ||
        channel.type === ChannelType.GuildStageVoice);
class NodeDiscordPlayerRuntime {
    #client;
    #options;
    #player;
    #references = new Map();
    #bridgePolicies = new WeakMap();
    #allowedRawMediaHosts;
    #guildOperations;
    #onDestroyed;
    #activeSessions = new Set();
    #pendingSessions = new Set();
    #referenceSequence = 0;
    #destroyOperation = null;
    #destroyed = false;
    #shutdownStarted = false;
    constructor(client, options, onDestroyed) {
        assertProviderIdentifiers();
        const normalizedOptions = normalizeRuntimeOptions(options);
        this.#client = client;
        this.#onDestroyed = onDestroyed;
        this.#options = normalizedOptions;
        this.#allowedRawMediaHosts = new Set(normalizedOptions.allowedRawMediaHosts);
        this.#guildOperations = new BoundedKeyedSerialExecutor(normalizedOptions.maximumPendingOperationsPerGuild);
        this.#player = new Player(client, {
            connectionTimeout: normalizedOptions.connectionTimeoutMs,
            probeTimeout: normalizedOptions.probeTimeoutMs,
            ffmpegPath: normalizedOptions.ffmpegPath,
            overrideFallbackContext: false,
            queryCache: null,
            skipFFmpeg: false
        });
    }
    async registerProvider(provider, signal) {
        if (this.#shutdownStarted) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime is stopping.", true);
        }
        aborted(signal, new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "Media provider registration was cancelled.", true));
        const resolveBridgeProviderIdentifiers = (track) => this.#bridgePolicies.get(track) ?? Object.freeze([]);
        const register = async () => {
            switch (provider) {
                case "youtubei": {
                    const probe = await new NodeYtDlpMediaProbeAdapter(APPROVED_YT_DLP_PATH).probe({
                        timeoutMs: this.#options.probeTimeoutMs,
                        signal
                    });
                    if (probe.state !== "ready") {
                        throw new MusicPlaybackError("MUSIC.YT_DLP_UNAVAILABLE", "The approved YouTube fallback executable is unavailable.", true);
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
                    return this.#player.extractors.register(ReverbnationExtractor, {});
                case "spotify":
                    return this.#player.extractors.register(ExplicitBridgeSpotifyExtractor, { resolveBridgeProviderIdentifiers });
                case "apple_music":
                    return this.#player.extractors.register(ExplicitBridgeAppleMusicExtractor, { resolveBridgeProviderIdentifiers });
            }
        };
        try {
            const registered = await register();
            if (registered === null) {
                throw new Error("Extractor registration returned no instance.");
            }
            aborted(signal, new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "Media provider registration was cancelled.", true));
        }
        catch (error) {
            const identifier = DISCORD_PLAYER_PROVIDER_IDENTIFIERS[provider];
            if (this.#player.extractors.isRegistered(identifier)) {
                try {
                    await this.#player.extractors.unregister(identifier);
                }
                catch {
                    // Preserve the isolated activation or cancellation failure.
                }
            }
            throw error;
        }
    }
    #remember(track, provider, guildId, allowedBridgeProviders) {
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
        const media = Object.freeze({
            providerReference: reference,
            sourceProvider: provider,
            ...sanitized
        });
        this.#references.set(reference, Object.freeze({ guildId, track, media }));
        if (provider === "spotify" || provider === "apple_music") {
            this.#bridgePolicies.set(track, Object.freeze(allowedBridgeProviders.map((bridgeProvider) => DISCORD_PLAYER_PROVIDER_IDENTIFIERS[bridgeProvider])));
        }
        while (this.#references.size > this.#options.maximumResolvedReferences) {
            const oldest = this.#references.keys().next().value;
            if (oldest === undefined)
                break;
            this.#references.delete(oldest);
        }
        return Object.freeze({ ...media });
    }
    async resolve(input) {
        if (this.#shutdownStarted) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime is stopping.", true);
        }
        const cancellationError = new MusicPlaybackError("MUSIC.MEDIA_RESOLUTION_TIMEOUT", "Media resolution was cancelled.", true);
        aborted(input.signal, cancellationError);
        if (input.provider === "attachment" &&
            !input.query.toLowerCase().startsWith("https://")) {
            throw new MusicPlaybackError("MUSIC.MEDIA_SOURCE_NOT_ALLOWED", "Attachment media must use a secure remote locator.", false);
        }
        const identifier = DISCORD_PLAYER_PROVIDER_IDENTIFIERS[input.provider];
        if (!this.#player.extractors.isRegistered(identifier)) {
            throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The selected media provider is not registered.", true);
        }
        const result = await this.#player.search(input.query, {
            searchEngine: `ext:${identifier}`,
            ignoreCache: true
        });
        aborted(input.signal, cancellationError);
        const candidates = [];
        for (const track of result.tracks.slice(0, input.maximumResults)) {
            try {
                candidates.push(this.#remember(track, input.provider, input.guildId, input.allowedBridgeProviders));
            }
            catch {
                // Invalid provider metadata is skipped without poisoning siblings.
            }
        }
        return Object.freeze(candidates);
    }
    #requireReference(providerReference, guildId) {
        const resolved = this.#references.get(providerReference);
        if (resolved === undefined) {
            throw new MusicPlaybackError("MUSIC.MEDIA_NOT_FOUND", "The resolved media reference has expired.", false);
        }
        if (resolved.guildId !== guildId) {
            throw new MusicPlaybackError("MUSIC.MEDIA_SOURCE_NOT_ALLOWED", "The resolved media reference belongs to another guild.", false);
        }
        return resolved;
    }
    #requireQueue(guildId) {
        const queue = this.#player.nodes.get(guildId);
        if (queue === null) {
            throw new MusicPlaybackError("MUSIC.SESSION_NOT_FOUND", "No active music session exists for this guild.", false);
        }
        return queue;
    }
    #assertChannel(queue, voiceChannelId) {
        const actual = queue.channel?.id ?? queue.metadata.voiceChannelId;
        if (actual !== voiceChannelId) {
            throw new MusicPlaybackError("MUSIC.SESSION_CHANNEL_CONFLICT", "The active music session belongs to another voice channel.", false);
        }
    }
    #mediaForTrack(track) {
        if (track === null)
            return null;
        for (const value of this.#references.values()) {
            if (value.track === track)
                return value.media;
        }
        const identifier = track.extractor?.identifier;
        const sourceProvider = Object.entries(DISCORD_PLAYER_PROVIDER_IDENTIFIERS).find((entry) => entry[1] === identifier)?.[0];
        if (sourceProvider === undefined)
            return null;
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
        }
        catch {
            return null;
        }
    }
    #snapshot(queue) {
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
    async #withGuildLock(guildId, signal, operation) {
        const cancellationError = new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The guild music operation was cancelled.", true);
        aborted(signal, cancellationError);
        if (this.#shutdownStarted) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime is stopping.", true);
        }
        return await this.#guildOperations.run(guildId, signal, async () => {
            aborted(signal, cancellationError);
            if (this.#shutdownStarted) {
                throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime is stopping.", true);
            }
            return await operation();
        });
    }
    async enqueue(input) {
        return await this.#withGuildLock(input.guildId, input.signal, async () => await this.#enqueueUnlocked(input));
    }
    async #enqueueUnlocked(input) {
        if (this.#shutdownStarted) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime is stopping.", true);
        }
        const cancellationError = new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "Media playback was cancelled.", true);
        aborted(input.signal, cancellationError);
        const resolved = this.#requireReference(input.providerReference, input.guildId);
        this.#reconcileActiveSessions();
        const existing = this.#player.nodes.get(input.guildId);
        if (existing !== null) {
            this.#assertChannel(existing, input.voiceChannelId);
            if (existing.size + (existing.currentTrack === null ? 0 : 1) >=
                input.maximumQueueItems) {
                throw new MusicPlaybackError("MUSIC.QUEUE_LIMIT_REACHED", "The guild music queue reached its configured limit.", false);
            }
            existing.setMaxSize(input.maximumQueueItems);
            this.#activeSessions.add(input.guildId);
        }
        const reservationRequired = existing === null;
        if (reservationRequired) {
            if (this.#activeSessions.size + this.#pendingSessions.size >=
                this.#options.maximumActiveSessions) {
                throw new MusicPlaybackError("MUSIC.OPERATION_CAPACITY_EXHAUSTED", "The active music session capacity is temporarily exhausted.", true);
            }
            this.#pendingSessions.add(input.guildId);
        }
        try {
            const channel = await awaitWithSignal(this.#client.channels.fetch(input.voiceChannelId), input.signal, cancellationError);
            aborted(input.signal, cancellationError);
            if (!isGuildVoiceChannel(channel) ||
                channel.guildId !== input.guildId) {
                throw new MusicPlaybackError("MUSIC.SESSION_CHANNEL_CONFLICT", "The requested voice channel is not available in this guild.", false);
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => {
                controller.abort(new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "Media playback exceeded its configured deadline.", true));
            }, input.timeoutMs);
            const signal = AbortSignal.any([input.signal, controller.signal]);
            try {
                const initialized = await this.#player.play(channel, resolved.track, {
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
                });
                aborted(signal, cancellationError);
                this.#activeSessions.add(input.guildId);
                return this.#snapshot(initialized.queue);
            }
            finally {
                clearTimeout(timeout);
            }
        }
        finally {
            if (reservationRequired) {
                this.#pendingSessions.delete(input.guildId);
                if (this.#player.nodes.get(input.guildId) !== null) {
                    this.#activeSessions.add(input.guildId);
                }
            }
        }
    }
    #reconcileActiveSessions() {
        for (const guildId of this.#activeSessions) {
            if (this.#player.nodes.get(guildId) === null) {
                this.#activeSessions.delete(guildId);
            }
        }
    }
    async control(input) {
        return await this.#withGuildLock(input.guildId, input.signal, async () => await this.#controlUnlocked(input));
    }
    async #controlUnlocked(input) {
        if (this.#shutdownStarted) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime is stopping.", true);
        }
        aborted(input.signal, new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The playback control was cancelled.", true));
        const queue = this.#requireQueue(input.guildId);
        this.#assertChannel(queue, input.voiceChannelId);
        switch (input.control.kind) {
            case "pause":
                if (!queue.node.isPaused())
                    queue.node.pause();
                break;
            case "resume":
                if (queue.node.isPaused())
                    queue.node.resume();
                break;
            case "toggle":
                queue.node.setPaused(!queue.node.isPaused());
                break;
            case "skip":
                if (!queue.node.skip()) {
                    throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", "The current track cannot be skipped.", false);
                }
                break;
            case "shuffle":
                queue.tracks.shuffle();
                break;
            case "set_repeat":
                queue.setRepeatMode(input.control.mode === "track"
                    ? QueueRepeatMode.TRACK
                    : input.control.mode === "queue"
                        ? QueueRepeatMode.QUEUE
                        : QueueRepeatMode.OFF);
                break;
            case "set_autoplay":
                if (input.control.enabled) {
                    queue.setRepeatMode(QueueRepeatMode.AUTOPLAY);
                }
                else if (queue.repeatMode === QueueRepeatMode.AUTOPLAY) {
                    queue.setRepeatMode(QueueRepeatMode.OFF);
                }
                break;
            case "set_volume":
                if (!Number.isSafeInteger(input.control.volume) ||
                    input.control.volume < 0 ||
                    input.control.volume > 100) {
                    throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", "Volume must be an integer between 0 and 100.", false);
                }
                queue.node.setVolume(input.control.volume);
                break;
            case "stop":
                queue.node.stop(true);
                queue.delete();
                this.#activeSessions.delete(input.guildId);
                return null;
        }
        aborted(input.signal, new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The playback control was cancelled.", true));
        return this.#snapshot(queue);
    }
    async session(guildId, signal) {
        return await this.#withGuildLock(guildId, signal, async () => await this.#sessionUnlocked(guildId, signal));
    }
    async #sessionUnlocked(guildId, signal) {
        if (this.#shutdownStarted) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime is stopping.", true);
        }
        aborted(signal, new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The playback session query was cancelled.", true));
        const queue = this.#player.nodes.get(guildId);
        return queue === null ? null : this.#snapshot(queue);
    }
    async destroy(signal) {
        if (this.#destroyed)
            return;
        this.#shutdownStarted = true;
        const cancellationError = new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "Music runtime shutdown was cancelled.", true);
        aborted(signal, cancellationError);
        if (this.#destroyOperation === null) {
            this.#references.clear();
            this.#activeSessions.clear();
            this.#pendingSessions.clear();
            const operation = this.#player.destroy();
            this.#destroyOperation = operation;
            void operation.then(() => {
                this.#destroyed = true;
                this.#onDestroyed();
                if (this.#destroyOperation === operation) {
                    this.#destroyOperation = null;
                }
            }, () => {
                if (this.#destroyOperation === operation) {
                    this.#destroyOperation = null;
                }
            });
        }
        await awaitWithSignal(this.#destroyOperation, signal, cancellationError);
    }
}
const compatibleDiscordClient = (providerClient) => {
    if (providerClient === null ||
        typeof providerClient !== "object" ||
        !("options" in providerClient) ||
        !("channels" in providerClient) ||
        typeof providerClient
            .channels?.fetch !== "function") {
        throw new TypeError("The music provider binding requires a compatible Discord provider client.");
    }
    const client = providerClient;
    if (!client.options.intents.has(GatewayIntentBits.Guilds) ||
        !client.options.intents.has(GatewayIntentBits.GuildVoiceStates)) {
        throw new TypeError("The music provider binding requires Guilds and GuildVoiceStates intents.");
    }
    return client;
};
/**
 * Generation-aware Discord Player v7 provider binding.
 *
 * The composition root owns the bridge to its Discord gateway and passes the
 * provider client as an opaque value. Discord.js remains confined to this
 * concrete adapter and never appears in the public declaration contract.
 */
export class NodeDiscordPlayerProviderBinding {
    #client = null;
    #generation = null;
    #latestGeneration = 0;
    #activeRuntime = null;
    #releaseState = null;
    bindProviderClient(providerClient, generation) {
        if (!Number.isSafeInteger(generation) || generation < 1) {
            throw new TypeError("The Discord provider generation is invalid.");
        }
        if (this.#releaseState !== null) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The Discord music generation is being released.", true);
        }
        const client = compatibleDiscordClient(providerClient);
        if (this.#client === client && this.#generation === generation)
            return;
        if (this.#client !== null || this.#activeRuntime !== null) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The previous Discord music generation is still active.", true);
        }
        if (generation <= this.#latestGeneration) {
            throw new TypeError("The Discord provider generation must advance monotonically.");
        }
        this.#client = client;
        this.#generation = generation;
        this.#latestGeneration = generation;
    }
    async releaseProviderClient(generation, signal) {
        const cancellationError = new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The Discord music generation release was cancelled.", true);
        const activeRelease = this.#releaseState;
        if (activeRelease !== null) {
            if (activeRelease.generation !== generation)
                return;
            await awaitWithSignal(activeRelease.operation, signal, cancellationError);
            return;
        }
        if (this.#generation !== generation)
            return;
        const release = async () => {
            aborted(signal, cancellationError);
            const runtime = this.#activeRuntime;
            if (runtime !== null)
                await runtime.destroy(signal);
            if (this.#generation !== generation)
                return;
            // Runtime destruction invokes its callback before this continuation and
            // may therefore expose a null active runtime. The release state remains
            // set until all three fields are transitioned together, so create() and
            // bindProviderClient() cannot enter that window.
            this.#activeRuntime = null;
            this.#client = null;
            this.#generation = null;
        };
        let trackedOperation;
        trackedOperation = release().finally(() => {
            if (this.#releaseState?.operation === trackedOperation) {
                this.#releaseState = null;
            }
        });
        this.#releaseState = Object.freeze({
            generation,
            operation: trackedOperation
        });
        // The initiating signal already governs release(). Await the tracked
        // operation directly so even a pre-aborted release has a rejection
        // observer before the current turn completes.
        await trackedOperation;
    }
    create(options) {
        if (this.#releaseState !== null) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The Discord music generation is being released.", true);
        }
        const client = this.#client;
        if (client === null || this.#generation === null) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The Discord provider client is not bound to the music provider binding.", true);
        }
        if (this.#activeRuntime !== null) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "A Discord music runtime is already active.", true);
        }
        let runtime;
        runtime = new NodeDiscordPlayerRuntime(client, options, () => {
            if (this.#activeRuntime === runtime)
                this.#activeRuntime = null;
        });
        this.#activeRuntime = runtime;
        return runtime;
    }
}
//# sourceMappingURL=discord-player.js.map