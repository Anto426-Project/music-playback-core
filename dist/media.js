import { MusicPlaybackError } from "./models.js";
import { approvedMusicProviderHosts, isMusicProviderKey } from "./provider-policy.js";
const boundedProviderText = (value, label, maximumCharacters) => {
    if (typeof value !== "string" ||
        value.length > maximumCharacters * 8) {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", `The media provider returned an invalid ${label}.`, true);
    }
    const normalized = value
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    if (normalized.length === 0) {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", `The media provider returned an empty ${label}.`, true);
    }
    return [...normalized].slice(0, maximumCharacters).join("");
};
const safeCanonicalLocator = (input) => {
    if (typeof input.value !== "string" || input.value.length > 2_048) {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The media provider returned an invalid canonical locator.", true);
    }
    let locator;
    try {
        locator = new URL(input.value);
    }
    catch {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The media provider returned an invalid canonical locator.", true);
    }
    const hostname = locator.hostname.toLowerCase();
    const expectedHosts = input.provider === "attachment"
        ? input.allowedRawMediaHosts
        : new Set(approvedMusicProviderHosts(input.provider));
    if (locator.protocol !== "https:" ||
        locator.username.length > 0 ||
        locator.password.length > 0 ||
        locator.port.length > 0 ||
        !expectedHosts.has(hostname)) {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The media provider returned a canonical locator outside its boundary.", true);
    }
    const normalized = locator.toString();
    if (normalized.length > 2_048) {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The normalized canonical locator is too long.", true);
    }
    return normalized;
};
export const sanitizeMusicMedia = (input) => {
    if (!isMusicProviderKey(input.provider) ||
        typeof input.live !== "boolean" ||
        !Number.isSafeInteger(input.maximumTrackDurationMs) ||
        input.maximumTrackDurationMs < 1 ||
        input.maximumTrackDurationMs > 24 * 60 * 60 * 1_000) {
        throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The media provider returned invalid media metadata.", true);
    }
    let durationMs = null;
    if (!input.live && input.durationMs !== 0) {
        if (typeof input.durationMs !== "number" ||
            !Number.isSafeInteger(input.durationMs) ||
            input.durationMs < 0 ||
            input.durationMs > input.maximumTrackDurationMs) {
            throw new MusicPlaybackError("MUSIC.PROVIDER_UNAVAILABLE", "The media provider returned an invalid media duration.", true);
        }
        durationMs = input.durationMs;
    }
    return Object.freeze({
        title: boundedProviderText(input.title, "title", 300),
        author: boundedProviderText(input.author, "author", 200),
        canonicalLocator: safeCanonicalLocator({
            value: input.canonicalLocator,
            provider: input.provider,
            allowedRawMediaHosts: input.allowedRawMediaHosts
        }),
        durationMs,
        live: input.live
    });
};
//# sourceMappingURL=media.js.map