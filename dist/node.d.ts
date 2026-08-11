import type { MediaEngineProbeResult, MediaProbePort } from "./ports.js";
export declare class NodeFfmpegMediaProbeAdapter implements MediaProbePort {
    #private;
    constructor(executablePath?: string);
    probe(input: {
        readonly timeoutMs: number;
        readonly signal?: AbortSignal;
    }): Promise<MediaEngineProbeResult>;
}
export declare class NodeYtDlpMediaProbeAdapter implements MediaProbePort {
    #private;
    constructor(executablePath?: string);
    probe(input: {
        readonly timeoutMs: number;
        readonly signal?: AbortSignal;
    }): Promise<MediaEngineProbeResult>;
}
//# sourceMappingURL=node.d.ts.map