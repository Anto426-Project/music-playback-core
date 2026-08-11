import { MusicPlaybackError } from "./models.js";
export class BoundedKeyedSerialExecutor {
    #maximumPendingPerKey;
    #states = new Map();
    constructor(maximumPendingPerKey) {
        if (!Number.isSafeInteger(maximumPendingPerKey) ||
            maximumPendingPerKey < 1 ||
            maximumPendingPerKey > 64) {
            throw new TypeError("The per-key pending operation limit must be from 1 to 64.");
        }
        this.#maximumPendingPerKey = maximumPendingPerKey;
    }
    run(key, signal, operation) {
        if (signal.aborted) {
            return Promise.reject(signal.reason ??
                new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The keyed music operation was cancelled.", true));
        }
        const current = this.#states.get(key);
        const pending = (current?.pending ?? 0) + 1;
        if (pending > this.#maximumPendingPerKey) {
            return Promise.reject(new MusicPlaybackError("MUSIC.OPERATION_CAPACITY_EXHAUSTED", "The keyed music operation capacity is temporarily exhausted.", true));
        }
        const previous = current?.tail ?? Promise.resolve();
        const execution = previous.catch(() => undefined).then(async () => {
            if (signal.aborted) {
                throw signal.reason ??
                    new MusicPlaybackError("MUSIC.PLAYBACK_TIMEOUT", "The keyed music operation was cancelled.", true);
            }
            return await operation();
        });
        const tail = execution.then(() => undefined, () => undefined);
        this.#states.set(key, Object.freeze({ tail, pending }));
        void tail.then(() => {
            const latest = this.#states.get(key);
            if (latest?.tail === tail) {
                this.#states.delete(key);
                return;
            }
            if (latest !== undefined) {
                this.#states.set(key, Object.freeze({ tail: latest.tail, pending: latest.pending - 1 }));
            }
        });
        return execution;
    }
}
//# sourceMappingURL=serial-executor.js.map