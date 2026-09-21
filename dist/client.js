import { MUSIC_PROVIDER_KEYS, MUSIC_STREAM_PROVIDER_KEYS, MusicPlaybackError } from "./models.js";
import { isMusicProviderKey, normalizeMusicProviderPolicies, selectMusicProvider } from "./provider-policy.js";
import { sanitizeMusicMedia } from "./media.js";
export const DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS = Object.freeze({
    ffmpegPath: "/usr/bin/ffmpeg",
    enabledProviders: MUSIC_PROVIDER_KEYS,
    bridgeProviderOrder: Object.freeze([
        "youtubei",
        "soundcloud"
    ]),
    allowedRawMediaHosts: Object.freeze([
        "cdn.discordapp.com",
        "media.discordapp.net"
    ]),
    connectionTimeoutMs: 15_000,
    mediaProbeTimeoutMs: 5_000,
    providerRegistrationTimeoutMs: 15_000,
    mediaResolutionTimeoutMs: 12_000,
    playbackTimeoutMs: 20_000,
    sessionReadTimeoutMs: 5_000,
    shutdownTimeoutMs: 10_000,
    maximumConcurrentOperations: 64,
    maximumConcurrentOperationsPerGuild: 4,
    maximumActiveSessions: 32,
    maximumQueryLength: 500,
    maximumSearchResults: 25,
    maximumResolvedReferences: 2_000,
    maximumTrackDurationMs: 6 * 60 * 60 * 1_000
});
const abortError = (fallback, signal) => signal.reason ?? fallback;
const executeBounded = async (operation, timeoutMs, timeoutError, callerSignal) => {
    if (callerSignal?.aborted === true) {
        throw abortError(new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music operation was cancelled.", true), callerSignal);
    }
    const controller = new AbortController();
    const signals = callerSignal === undefined
        ? [controller.signal]
        : [controller.signal, callerSignal];
    const signal = AbortSignal.any(signals);
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => {
        rejectAbort = reject;
    });
    const onAbort = () => {
        rejectAbort?.(abortError(new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music operation was cancelled.", true), signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
        controller.abort(timeoutError());
    }, timeoutMs);
    try {
        return await Promise.race([operation(signal), aborted]);
    }
    finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
    }
};
const uniqueProviders = (providers, label) => {
    if (!Array.isArray(providers) ||
        Object.getPrototypeOf(providers) !== Array.prototype ||
        providers.length > MUSIC_PROVIDER_KEYS.length) {
        throw new TypeError(`${label} must be a plain bounded array.`);
    }
    const result = [];
    for (let index = 0; index < providers.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(providers, String(index));
        if (descriptor === undefined ||
            !("value" in descriptor) ||
            !isMusicProviderKey(descriptor.value)) {
            throw new TypeError(`${label} contains an invalid provider.`);
        }
        result.push(descriptor.value);
    }
    if (new Set(result).size !== result.length) {
        throw new TypeError(`${label} cannot contain duplicate providers.`);
    }
    return Object.freeze(result);
};
const normalizedDnsHostname = (value) => {
    if (typeof value !== "string") {
        throw new TypeError("Raw media hosts must be DNS hostnames.");
    }
    const host = value.trim().toLowerCase();
    let parsed;
    try {
        parsed = new URL(`https://${host}/`);
    }
    catch {
        throw new TypeError("Raw media hosts must be DNS hostnames.");
    }
    if (host.length === 0 ||
        host.length > 253 ||
        parsed.hostname !== host ||
        parsed.port.length > 0 ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        parsed.pathname !== "/" ||
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".") ||
        !host.includes(".") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".lan") ||
        host.includes(":") ||
        /^\d+(?:\.\d+){3}$/u.test(host)) {
        throw new TypeError("Raw media hosts must be explicit DNS hostnames.");
    }
    return host;
};
const normalizedDnsHostnames = (values) => {
    if (!Array.isArray(values) ||
        Object.getPrototypeOf(values) !== Array.prototype ||
        values.length > 256) {
        throw new TypeError("Raw media hosts must be a plain bounded array.");
    }
    const result = [];
    for (let index = 0; index < values.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
            throw new TypeError("Raw media hosts must be a dense data array.");
        }
        result.push(normalizedDnsHostname(descriptor.value));
    }
    if (new Set(result).size !== result.length) {
        throw new TypeError("Raw media hosts cannot contain duplicates.");
    }
    return Object.freeze(result);
};
const boundedInteger = (value, minimum, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
    }
    return value;
};
const validateOptions = (options) => {
    const enabledProviders = uniqueProviders(options.enabledProviders, "Enabled providers");
    const bridgeProviderOrder = uniqueProviders(options.bridgeProviderOrder, "Bridge provider order");
    if (bridgeProviderOrder.some((provider) => !MUSIC_STREAM_PROVIDER_KEYS.includes(provider))) {
        throw new TypeError("Metadata bridges require streaming providers.");
    }
    const enabledBridgeProviderOrder = bridgeProviderOrder.filter((provider) => enabledProviders.includes(provider));
    if (enabledProviders.some((provider) => provider === "spotify" || provider === "apple_music") &&
        enabledBridgeProviderOrder.length === 0) {
        throw new TypeError("Metadata sources require at least one enabled streaming bridge.");
    }
    if (options.ffmpegPath !== "/usr/bin/ffmpeg") {
        throw new TypeError("The FFmpeg path is invalid.");
    }
    const hosts = normalizedDnsHostnames(options.allowedRawMediaHosts);
    const maximumConcurrentOperations = boundedInteger(options.maximumConcurrentOperations, 1, 1_024, "maximumConcurrentOperations");
    const maximumConcurrentOperationsPerGuild = boundedInteger(options.maximumConcurrentOperationsPerGuild, 1, 64, "maximumConcurrentOperationsPerGuild");
    if (maximumConcurrentOperationsPerGuild > maximumConcurrentOperations) {
        throw new TypeError("The per-guild operation limit cannot exceed the global limit.");
    }
    return Object.freeze({
        ffmpegPath: options.ffmpegPath,
        enabledProviders,
        bridgeProviderOrder: Object.freeze(enabledBridgeProviderOrder),
        allowedRawMediaHosts: Object.freeze(hosts),
        connectionTimeoutMs: boundedInteger(options.connectionTimeoutMs, 100, 120_000, "connectionTimeoutMs"),
        mediaProbeTimeoutMs: boundedInteger(options.mediaProbeTimeoutMs, 100, 30_000, "mediaProbeTimeoutMs"),
        providerRegistrationTimeoutMs: boundedInteger(options.providerRegistrationTimeoutMs, 100, 120_000, "providerRegistrationTimeoutMs"),
        mediaResolutionTimeoutMs: boundedInteger(options.mediaResolutionTimeoutMs, 100, 120_000, "mediaResolutionTimeoutMs"),
        playbackTimeoutMs: boundedInteger(options.playbackTimeoutMs, 100, 120_000, "playbackTimeoutMs"),
        sessionReadTimeoutMs: boundedInteger(options.sessionReadTimeoutMs, 100, 30_000, "sessionReadTimeoutMs"),
        shutdownTimeoutMs: boundedInteger(options.shutdownTimeoutMs, 100, 60_000, "shutdownTimeoutMs"),
        maximumConcurrentOperations,
        maximumConcurrentOperationsPerGuild,
        maximumActiveSessions: boundedInteger(options.maximumActiveSessions, 1, 1_000, "maximumActiveSessions"),
        maximumQueryLength: boundedInteger(options.maximumQueryLength, 1, 2_000, "maximumQueryLength"),
        maximumSearchResults: boundedInteger(options.maximumSearchResults, 1, 100, "maximumSearchResults"),
        maximumResolvedReferences: boundedInteger(options.maximumResolvedReferences, 1, 50_000, "maximumResolvedReferences"),
        maximumTrackDurationMs: boundedInteger(options.maximumTrackDurationMs, 1, 24 * 60 * 60 * 1_000, "maximumTrackDurationMs")
    });
};
const stoppedHealth = () => Object.freeze({
    state: "stopped",
    mediaEngine: null,
    providers: Object.freeze([])
});
const healthFor = (provider, state, failureCode) => Object.freeze({ provider, state, failureCode });
const normalizeProbeResult = (value) => {
    if (value === null || typeof value !== "object") {
        throw new TypeError("The media probe result is invalid.");
    }
    if (value.state === "ready") {
        if (typeof value.version !== "string" ||
            value.version.length < 1 ||
            value.version.length > 128 ||
            /[\u0000-\u001f\u007f]/u.test(value.version) ||
            value.failureCode !== null) {
            throw new TypeError("The ready media probe result is invalid.");
        }
        return Object.freeze({
            state: "ready",
            version: value.version,
            failureCode: null
        });
    }
    if (value.state !== "unavailable" ||
        value.version !== null ||
        typeof value.failureCode !== "string" ||
        !/^[A-Z][A-Z0-9_.-]{2,127}$/u.test(value.failureCode)) {
        throw new TypeError("The unavailable media probe result is invalid.");
    }
    return Object.freeze({
        state: "unavailable",
        version: null,
        failureCode: value.failureCode
    });
};
const boundedReference = (value, label) => {
    if (typeof value !== "string" ||
        value.length < 1 ||
        value.length > 512 ||
        value.trim() !== value ||
        /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", `The music runtime returned an invalid ${label}.`, true);
    }
    return value;
};
const boundedIdentity = (value, label) => {
    if (typeof value !== "string" ||
        value.length < 1 ||
        value.length > 128 ||
        value.trim() !== value ||
        /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", `${label} is invalid.`, false);
    }
    return value;
};
const isRepeatMode = (value) => value === "off" || value === "track" || value === "queue";
const normalizeControl = (control) => {
    if (control === null || typeof control !== "object") {
        throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", "The playback control is invalid.", false);
    }
    switch (control.kind) {
        case "pause":
        case "resume":
        case "toggle":
        case "skip":
        case "shuffle":
        case "stop":
            return Object.freeze({ kind: control.kind });
        case "set_repeat":
            if (!isRepeatMode(control.mode)) {
                throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", "The repeat mode is invalid.", false);
            }
            return Object.freeze({ kind: control.kind, mode: control.mode });
        case "set_autoplay":
            if (typeof control.enabled !== "boolean") {
                throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", "The autoplay value is invalid.", false);
            }
            return Object.freeze({
                kind: control.kind,
                enabled: control.enabled
            });
        case "set_volume":
            if (!Number.isSafeInteger(control.volume) ||
                control.volume < 0 ||
                control.volume > 100) {
                throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", "The playback volume is invalid.", false);
            }
            return Object.freeze({ kind: control.kind, volume: control.volume });
        default:
            throw new MusicPlaybackError("MUSIC.CONTROL_INVALID", "The playback control kind is invalid.", false);
    }
};
const clientNotReadyError = (message) => new MusicPlaybackError("MUSIC.CLIENT_NOT_STARTED", message, true);
export class MusicPlaybackClient {
    #factory;
    #mediaProbe;
    #options;
    #allowedRawMediaHosts;
    #runtime = null;
    #startOperation = null;
    #stopOperation = null;
    #startupController = null;
    #lifecycleState = "stopped";
    #inFlightOperations = new Map();
    #providerFailureCounts = new Map();
    #currentHealth = stoppedHealth();
    constructor(factory, mediaProbe, options = DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS) {
        this.#factory = factory;
        this.#mediaProbe = mediaProbe;
        this.#options = validateOptions(options);
        this.#allowedRawMediaHosts = new Set(this.#options.allowedRawMediaHosts);
    }
    health() {
        return this.#currentHealth;
    }
    async start(signal) {
        if (signal?.aborted === true) {
            throw abortError(new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "Music startup was cancelled.", true), signal);
        }
        if (this.#lifecycleState === "stopping") {
            throw clientNotReadyError("The music playback client is stopping.");
        }
        if (this.#startOperation !== null) {
            if (signal === undefined)
                return this.#startOperation;
            return executeBounded(async () => await this.#startOperation, 120_000, () => new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music client did not start in time.", true), signal);
        }
        if (this.#runtime !== null) {
            if (this.#currentHealth.state === "stopped") {
                throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The previous music runtime shutdown is incomplete.", true);
            }
            return this.#currentHealth;
        }
        if (this.#startOperation === null) {
            const controller = new AbortController();
            this.#lifecycleState = "starting";
            this.#startupController = controller;
            this.#startOperation = this.#startInternal(controller.signal).finally(() => {
                if (this.#startupController === controller) {
                    this.#startupController = null;
                }
                this.#startOperation = null;
                if (this.#lifecycleState === "starting") {
                    this.#lifecycleState =
                        this.#runtime === null ? "stopped" : "running";
                }
            });
        }
        if (signal === undefined)
            return this.#startOperation;
        return executeBounded(async () => await this.#startOperation, 120_000, () => new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music client did not start in time.", true), signal);
    }
    async #startInternal(startupSignal) {
        let mediaEngine;
        try {
            mediaEngine = normalizeProbeResult(await executeBounded((signal) => this.#mediaProbe.probe({
                timeoutMs: this.#options.mediaProbeTimeoutMs,
                signal
            }), this.#options.mediaProbeTimeoutMs, () => new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The media engine probe timed out.", true), startupSignal));
        }
        catch (error) {
            if (startupSignal.aborted)
                throw error;
            mediaEngine = Object.freeze({
                state: "unavailable",
                version: null,
                failureCode: "MEDIA_ENGINE.PROBE_FAILED"
            });
        }
        if (mediaEngine.state !== "ready") {
            this.#currentHealth = Object.freeze({
                state: "unavailable",
                mediaEngine,
                providers: Object.freeze(MUSIC_PROVIDER_KEYS.map((provider) => healthFor(provider, this.#options.enabledProviders.includes(provider)
                    ? "unavailable"
                    : "disabled", this.#options.enabledProviders.includes(provider)
                    ? "MEDIA_ENGINE.UNAVAILABLE"
                    : null)))
            });
            return this.#currentHealth;
        }
        let runtime;
        try {
            const runtimeOptions = Object.freeze({
                ffmpegPath: this.#options.ffmpegPath,
                connectionTimeoutMs: this.#options.connectionTimeoutMs,
                probeTimeoutMs: this.#options.mediaProbeTimeoutMs,
                maximumResolvedReferences: this.#options.maximumResolvedReferences,
                maximumPendingOperationsPerGuild: this.#options.maximumConcurrentOperationsPerGuild,
                maximumActiveSessions: this.#options.maximumActiveSessions,
                maximumTrackDurationMs: this.#options.maximumTrackDurationMs,
                allowedRawMediaHosts: this.#options.allowedRawMediaHosts,
                bridgeProviderOrder: this.#options.bridgeProviderOrder
            });
            runtime = this.#factory.create(runtimeOptions);
        }
        catch {
            this.#currentHealth = Object.freeze({
                state: "unavailable",
                mediaEngine,
                providers: Object.freeze(MUSIC_PROVIDER_KEYS.map((provider) => healthFor(provider, this.#options.enabledProviders.includes(provider)
                    ? "unavailable"
                    : "disabled", this.#options.enabledProviders.includes(provider)
                    ? "MUSIC.RUNTIME_CREATION_FAILED"
                    : null)))
            });
            return this.#currentHealth;
        }
        this.#runtime = runtime;
        this.#providerFailureCounts.clear();
        const providers = [];
        for (const provider of MUSIC_PROVIDER_KEYS) {
            if (!this.#options.enabledProviders.includes(provider)) {
                providers.push(healthFor(provider, "disabled", null));
                continue;
            }
            try {
                await executeBounded((signal) => runtime.registerProvider(provider, signal), this.#options.providerRegistrationTimeoutMs, () => new MusicPlaybackError("MUSIC.PROVIDER_REGISTRATION_TIMEOUT", "Provider registration timed out.", true), startupSignal);
                providers.push(healthFor(provider, "ready", null));
            }
            catch (error) {
                providers.push(healthFor(provider, "unavailable", error instanceof MusicPlaybackError ? error.code : "MUSIC.PROVIDER_REGISTRATION_FAILED"));
            }
        }
        if (startupSignal.aborted) {
            await this.#destroyRuntime(runtime);
            if (this.#runtime === runtime)
                this.#runtime = null;
            throw abortError(new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "Music startup was cancelled.", true), startupSignal);
        }
        const hasStreamingProvider = providers.some((provider) => provider.state === "ready" &&
            MUSIC_STREAM_PROVIDER_KEYS.includes(provider.provider));
        const hasReadyBridge = providers.some((provider) => provider.state === "ready" &&
            this.#options.bridgeProviderOrder.includes(provider.provider));
        if (!hasReadyBridge) {
            for (let index = 0; index < providers.length; index += 1) {
                const provider = providers[index];
                if (provider !== undefined &&
                    provider.state === "ready" &&
                    (provider.provider === "spotify" ||
                        provider.provider === "apple_music")) {
                    providers[index] = healthFor(provider.provider, "unavailable", "MUSIC.METADATA_BRIDGE_UNAVAILABLE");
                }
            }
        }
        const hasFailure = providers.some((provider) => provider.state === "unavailable");
        this.#currentHealth = Object.freeze({
            state: hasStreamingProvider
                ? hasFailure
                    ? "degraded"
                    : "ready"
                : "unavailable",
            mediaEngine,
            providers: Object.freeze(providers)
        });
        return this.#currentHealth;
    }
    stop() {
        if (this.#stopOperation !== null)
            return this.#stopOperation;
        this.#lifecycleState = "stopping";
        this.#stopOperation = this.#stopInternal().finally(() => {
            this.#lifecycleState = "stopped";
            this.#stopOperation = null;
        });
        return this.#stopOperation;
    }
    async restart(signal) {
        if (signal?.aborted === true) {
            throw abortError(new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "Music recovery was cancelled.", true), signal);
        }
        await this.stop();
        return await this.start(signal);
    }
    async #stopInternal() {
        const stopReason = clientNotReadyError("The music playback client is stopping.");
        this.#startupController?.abort(stopReason);
        for (const controller of this.#inFlightOperations.keys()) {
            controller.abort(stopReason);
        }
        this.#currentHealth = stoppedHealth();
        if (this.#startOperation !== null) {
            try {
                await this.#startOperation;
            }
            catch {
                // A cancelled or failed startup has no live runtime to expose.
            }
        }
        await this.#drainInFlightOperations();
        const runtime = this.#runtime;
        if (runtime !== null) {
            await this.#destroyRuntime(runtime);
            this.#detachRuntimeOperations(runtime);
            if (this.#runtime === runtime)
                this.#runtime = null;
        }
    }
    #detachRuntimeOperations(runtime) {
        for (const [controller, entry] of this.#inFlightOperations) {
            if (entry.runtime === runtime)
                this.#inFlightOperations.delete(controller);
        }
    }
    async #drainInFlightOperations() {
        const operations = [...this.#inFlightOperations.values()]
            .map((entry) => entry.operation)
            .filter((operation) => operation !== null);
        if (operations.length === 0)
            return;
        try {
            await executeBounded(async () => {
                await Promise.allSettled(operations);
            }, this.#options.shutdownTimeoutMs, () => new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "Music operations did not drain in time.", true));
        }
        catch {
            // Shutdown remains bounded even if a provider ignores cancellation.
        }
    }
    async #destroyRuntime(runtime) {
        await executeBounded((signal) => runtime.destroy(signal), this.#options.shutdownTimeoutMs, () => new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime did not stop in time.", true));
    }
    #readyRuntime() {
        if (this.#lifecycleState !== "running" ||
            this.#runtime === null ||
            this.#currentHealth.state === "stopped" ||
            this.#currentHealth.state === "unavailable") {
            throw new MusicPlaybackError("MUSIC.CLIENT_NOT_STARTED", "The music playback client is not ready.", true);
        }
        return this.#runtime;
    }
    #executeTrackedOperation(runtime, guildId, operation, timeoutMs, timeoutError, callerSignal) {
        if (this.#lifecycleState !== "running" ||
            this.#runtime !== runtime) {
            return Promise.reject(clientNotReadyError("The music playback client is not ready."));
        }
        const guildOperationCount = [...this.#inFlightOperations.values()]
            .filter((entry) => entry.guildId === guildId).length;
        if (this.#inFlightOperations.size >=
            this.#options.maximumConcurrentOperations ||
            guildOperationCount >=
                this.#options.maximumConcurrentOperationsPerGuild) {
            return Promise.reject(new MusicPlaybackError("MUSIC.OPERATION_CAPACITY_EXHAUSTED", "The music operation capacity is temporarily exhausted.", true));
        }
        const controller = new AbortController();
        this.#inFlightOperations.set(controller, Object.freeze({ guildId, runtime, operation: null }));
        const operationSignal = callerSignal === undefined
            ? controller.signal
            : AbortSignal.any([controller.signal, callerSignal]);
        const boundedOperation = executeBounded((signal) => {
            const providerOperation = Promise.resolve().then(() => operation(runtime, signal));
            this.#inFlightOperations.set(controller, Object.freeze({ guildId, runtime, operation: providerOperation }));
            void providerOperation.then(() => {
                if (this.#inFlightOperations.get(controller)?.operation ===
                    providerOperation) {
                    this.#inFlightOperations.delete(controller);
                }
            }, () => {
                if (this.#inFlightOperations.get(controller)?.operation ===
                    providerOperation) {
                    this.#inFlightOperations.delete(controller);
                }
            });
            return providerOperation;
        }, timeoutMs, timeoutError, operationSignal);
        return boundedOperation.finally(() => {
            if (this.#inFlightOperations.get(controller)?.operation === null) {
                this.#inFlightOperations.delete(controller);
            }
        });
    }
    #readyProviders() {
        return new Set(this.#currentHealth.providers
            .filter((provider) => provider.state === "ready")
            .map((provider) => provider.provider));
    }
    #recordProviderFailure(provider) {
        if (this.#lifecycleState !== "running")
            return;
        const failures = (this.#providerFailureCounts.get(provider) ?? 0) + 1;
        this.#providerFailureCounts.set(provider, failures);
        if (failures < 3)
            return;
        const providers = this.#currentHealth.providers.map((entry) => entry.provider === provider && entry.state === "ready"
            ? healthFor(provider, "unavailable", "MUSIC.PROVIDER_CIRCUIT_OPEN")
            : entry);
        const hasReadyStreamingProvider = providers.some((entry) => entry.state === "ready" &&
            MUSIC_STREAM_PROVIDER_KEYS.includes(entry.provider));
        this.#currentHealth = Object.freeze({
            state: hasReadyStreamingProvider ? "degraded" : "unavailable",
            mediaEngine: this.#currentHealth.mediaEngine,
            providers: Object.freeze(providers)
        });
    }
    #recordProviderSuccess(provider) {
        this.#providerFailureCounts.delete(provider);
    }
    #normalizeCandidate(candidate, selectedProvider) {
        if (candidate === null ||
            typeof candidate !== "object" ||
            candidate.sourceProvider !== selectedProvider) {
            throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The music runtime returned an invalid provider result.", true);
        }
        const sanitized = sanitizeMusicMedia({
            provider: candidate.sourceProvider,
            title: candidate.title,
            author: candidate.author,
            canonicalLocator: candidate.canonicalLocator,
            durationMs: candidate.durationMs,
            live: candidate.live,
            allowedRawMediaHosts: this.#allowedRawMediaHosts,
            maximumTrackDurationMs: this.#options.maximumTrackDurationMs
        });
        return Object.freeze({
            providerReference: boundedReference(candidate.providerReference, "provider reference"),
            sourceProvider: candidate.sourceProvider,
            ...sanitized
        });
    }
    async resolve(input) {
        const runtime = this.#readyRuntime();
        const guildId = boundedIdentity(input.guildId, "Guild id");
        const providerPolicies = normalizeMusicProviderPolicies(input.providerPolicies);
        const selection = selectMusicProvider({
            query: input.query,
            ...(input.preferredProvider === undefined
                ? {}
                : { preferredProvider: input.preferredProvider }),
            providerPolicies,
            readyProviders: this.#readyProviders(),
            allowedRawMediaHosts: this.#allowedRawMediaHosts,
            maximumQueryLength: this.#options.maximumQueryLength
        });
        const maximumResults = Math.min(input.maximumResults ?? this.#options.maximumSearchResults, this.#options.maximumSearchResults);
        if (!Number.isSafeInteger(maximumResults) || maximumResults <= 0) {
            throw new MusicPlaybackError("MUSIC.MEDIA_QUERY_INVALID", "The media result limit is invalid.", false);
        }
        const enabledProviders = new Set(providerPolicies
            .filter((policy) => policy.enabled)
            .map((policy) => policy.provider));
        const readyProviders = this.#readyProviders();
        const allowedBridgeProviders = this.#options.bridgeProviderOrder.filter((provider) => enabledProviders.has(provider) && readyProviders.has(provider));
        if ((selection.provider === "spotify" ||
            selection.provider === "apple_music") &&
            allowedBridgeProviders.length === 0) {
            throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "No enabled streaming provider can bridge this metadata source.", true);
        }
        let resolved;
        try {
            resolved = await this.#executeTrackedOperation(runtime, guildId, (activeRuntime, signal) => activeRuntime.resolve({
                guildId,
                provider: selection.provider,
                query: selection.normalizedQuery,
                maximumResults,
                allowedBridgeProviders,
                signal
            }), this.#options.mediaResolutionTimeoutMs, () => new MusicPlaybackError("MUSIC.MEDIA_RESOLUTION_TIMEOUT", "The media provider did not answer in time.", true), input.signal);
        }
        catch (error) {
            if (input.signal?.aborted !== true &&
                !(error instanceof MusicPlaybackError &&
                    (error.code === "MUSIC.OPERATION_CAPACITY_EXHAUSTED" ||
                        error.code === "MUSIC.CLIENT_NOT_STARTED"))) {
                this.#recordProviderFailure(selection.provider);
            }
            if (error instanceof MusicPlaybackError)
                throw error;
            throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The selected media provider is temporarily unavailable.", true);
        }
        const resolvedLength = Array.isArray(resolved)
            ? resolved.length
            : null;
        if (resolvedLength === null ||
            Object.getPrototypeOf(resolved) !== Array.prototype ||
            resolvedLength < 1 ||
            resolvedLength > maximumResults) {
            throw new MusicPlaybackError(resolvedLength === 0
                ? "MUSIC.MEDIA_NOT_FOUND"
                : "MUSIC.PROVIDER_UNAVAILABLE", resolvedLength === 0
                ? "No media matched the query."
                : "The music runtime returned an invalid result collection.", resolvedLength !== 0);
        }
        const items = [];
        for (let index = 0; index < resolved.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(resolved, String(index));
            if (descriptor === undefined || !("value" in descriptor)) {
                throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The music runtime returned a sparse result collection.", true);
            }
            items.push(this.#normalizeCandidate(descriptor.value, selection.provider));
        }
        this.#recordProviderSuccess(selection.provider);
        return Object.freeze({
            query: selection.normalizedQuery,
            selectedProvider: selection.provider,
            items: Object.freeze(items)
        });
    }
    #normalizeSnapshot(snapshot, guildId, voiceChannelId) {
        if (snapshot === null)
            return null;
        if (snapshot === undefined ||
            typeof snapshot !== "object" ||
            snapshot.guildId !== guildId ||
            (voiceChannelId !== undefined &&
                snapshot.voiceChannelId !== voiceChannelId) ||
            !["connecting", "playing", "paused", "idle"].includes(snapshot.state) ||
            !Number.isSafeInteger(snapshot.queuedItemCount) ||
            snapshot.queuedItemCount < 0 ||
            snapshot.queuedItemCount > 10_000 ||
            !isRepeatMode(snapshot.repeatMode) ||
            typeof snapshot.autoplay !== "boolean" ||
            !Number.isSafeInteger(snapshot.volume) ||
            snapshot.volume < 0 ||
            snapshot.volume > 100) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime returned an invalid session snapshot.", true);
        }
        const current = snapshot.current;
        if (current !== null &&
            (typeof current !== "object" ||
                !isMusicProviderKey(current
                    .sourceProvider))) {
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music runtime returned an invalid current track.", true);
        }
        const typedCurrent = current;
        const normalizedCurrent = typedCurrent === null
            ? null
            : this.#normalizeCandidate(typedCurrent, typedCurrent.sourceProvider);
        return Object.freeze({
            guildId,
            voiceChannelId: boundedIdentity(snapshot.voiceChannelId, "Voice channel id"),
            state: snapshot.state,
            current: normalizedCurrent,
            queuedItemCount: snapshot.queuedItemCount,
            repeatMode: snapshot.repeatMode,
            autoplay: snapshot.autoplay,
            volume: snapshot.volume
        });
    }
    async enqueue(input) {
        const runtime = this.#readyRuntime();
        const guildId = boundedIdentity(input.guildId, "Guild id");
        const voiceChannelId = boundedIdentity(input.voiceChannelId, "Voice channel id");
        boundedInteger(input.maximumQueueItems, 1, 10_000, "maximumQueueItems");
        boundedInteger(input.defaultVolume, 0, 100, "defaultVolume");
        const providerReference = boundedReference(input.media.providerReference, "provider reference");
        try {
            const snapshot = await this.#executeTrackedOperation(runtime, guildId, (activeRuntime, signal) => activeRuntime.enqueue({
                guildId,
                voiceChannelId,
                providerReference,
                maximumQueueItems: input.maximumQueueItems,
                defaultVolume: input.defaultVolume,
                timeoutMs: this.#options.playbackTimeoutMs,
                signal
            }), this.#options.playbackTimeoutMs, () => new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "Playback did not start in time.", true), input.signal);
            const normalized = this.#normalizeSnapshot(snapshot, guildId, voiceChannelId);
            if (normalized === null) {
                throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The runtime did not create a music session.", true);
            }
            return normalized;
        }
        catch (error) {
            if (error instanceof MusicPlaybackError)
                throw error;
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The audio playback engine is temporarily unavailable.", true);
        }
    }
    async control(input) {
        const runtime = this.#readyRuntime();
        const guildId = boundedIdentity(input.guildId, "Guild id");
        const voiceChannelId = boundedIdentity(input.voiceChannelId, "Voice channel id");
        const control = normalizeControl(input.control);
        try {
            const snapshot = await this.#executeTrackedOperation(runtime, guildId, (activeRuntime, signal) => activeRuntime.control({
                guildId,
                voiceChannelId,
                control,
                signal
            }), this.#options.playbackTimeoutMs, () => new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The playback control timed out.", true), input.signal);
            return this.#normalizeSnapshot(snapshot, guildId, voiceChannelId);
        }
        catch (error) {
            if (error instanceof MusicPlaybackError)
                throw error;
            throw new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The playback control could not be applied.", true);
        }
    }
    async session(guildIdInput, signal) {
        const runtime = this.#readyRuntime();
        const guildId = boundedIdentity(guildIdInput, "Guild id");
        const snapshot = await this.#executeTrackedOperation(runtime, guildId, (activeRuntime, operationSignal) => activeRuntime.session(guildId, operationSignal), this.#options.sessionReadTimeoutMs, () => new MusicPlaybackError("MUSIC.MEDIA_ENGINE_UNAVAILABLE", "The music session read timed out.", true), signal);
        return this.#normalizeSnapshot(snapshot, guildId);
    }
}
//# sourceMappingURL=client.js.map