export declare class BoundedKeyedSerialExecutor {
    #private;
    constructor(maximumPendingPerKey: number);
    run<T>(key: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=serial-executor.d.ts.map