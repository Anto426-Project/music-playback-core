import type { MusicPlaybackRuntime, MusicPlaybackRuntimeFactory, MusicPlaybackRuntimeOptions } from "./runtime.js";
/**
 * Generation-aware Discord Player v7 provider binding.
 *
 * The composition root owns the bridge to its Discord gateway and passes the
 * provider client as an opaque value. Discord.js remains confined to this
 * concrete adapter and never appears in the public declaration contract.
 */
export declare class NodeDiscordPlayerProviderBinding implements MusicPlaybackRuntimeFactory {
    #private;
    bindProviderClient(providerClient: unknown, generation: number): void;
    releaseProviderClient(generation: number, signal: AbortSignal): Promise<void>;
    create(options: MusicPlaybackRuntimeOptions): MusicPlaybackRuntime;
}
//# sourceMappingURL=discord-player.d.ts.map