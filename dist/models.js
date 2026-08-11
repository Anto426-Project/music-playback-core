export const MUSIC_PROVIDER_KEYS = Object.freeze([
    "youtubei",
    "soundcloud",
    "attachment",
    "vimeo",
    "reverbnation",
    "spotify",
    "apple_music"
]);
export const MUSIC_STREAM_PROVIDER_KEYS = Object.freeze([
    "youtubei",
    "soundcloud",
    "attachment",
    "vimeo",
    "reverbnation"
]);
export class MusicPlaybackError extends Error {
    code;
    retryable;
    constructor(code, message, retryable) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.name = "MusicPlaybackError";
    }
}
//# sourceMappingURL=models.js.map