import type { MusicPlaybackRuntime, MusicPlaybackRuntimeFactory, MusicPlaybackRuntimeOptions } from "./runtime.js";
/**
 * Discord Player v7 extension for discord-bot-core's opaque provider host.
 * The provider client exists only inside this concrete adapter and is rebound
 * whenever the owning Discord gateway advances to a new client generation.
 */
export declare class NodeDiscordPlayerExtension implements MusicPlaybackRuntimeFactory {
    #private;
    constructor();
    create(options: MusicPlaybackRuntimeOptions): MusicPlaybackRuntime;
}
//# sourceMappingURL=discord-player.d.ts.map