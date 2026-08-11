import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
  MusicPlaybackClient,
  type MediaProbePort,
  type MusicPlaybackControl,
  type MusicPlaybackRuntime,
  type MusicPlaybackRuntimeFactory,
  type MusicPlaybackRuntimeOptions,
  type MusicRuntimeCandidate,
  type MusicSessionSnapshot
} from "../src/index.js";

const deferred = <T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
};

class ReadyProbe implements MediaProbePort {
  public calls = 0;

  public async probe(): Promise<{
    readonly state: "ready";
    readonly version: string;
    readonly failureCode: null;
  }> {
    this.calls += 1;
    return Object.freeze({
      state: "ready",
      version: "8.1.2",
      failureCode: null
    });
  }
}

class LifecycleRuntime implements MusicPlaybackRuntime {
  readonly #resolveStarted = deferred<void>();
  readonly #destroyStarted = deferred<void>();
  readonly #releaseDestroy = deferred<void>();
  public readonly events: string[] = [];
  public sessionCalls = 0;

  public resolveStarted(): Promise<void> {
    return this.#resolveStarted.promise;
  }

  public destroyStarted(): Promise<void> {
    return this.#destroyStarted.promise;
  }

  public releaseDestroy(): void {
    this.#releaseDestroy.resolve(undefined);
  }

  public async registerProvider(): Promise<void> {}

  public async resolve(input: {
    readonly signal: AbortSignal;
  }): Promise<readonly MusicRuntimeCandidate[]> {
    this.events.push("resolve-started");
    this.#resolveStarted.resolve(undefined);
    return await new Promise<readonly MusicRuntimeCandidate[]>(
      (_resolve, reject) => {
        const rejectAfterAbort = (): void => {
          this.events.push("resolve-aborted");
          setImmediate(() => {
            this.events.push("resolve-settled");
            reject(input.signal.reason);
          });
        };
        if (input.signal.aborted) {
          rejectAfterAbort();
          return;
        }
        input.signal.addEventListener("abort", rejectAfterAbort, {
          once: true
        });
      }
    );
  }

  public async enqueue(): Promise<MusicSessionSnapshot> {
    throw new Error("unexpected enqueue");
  }

  public async control(_input: {
    readonly control: MusicPlaybackControl;
  }): Promise<MusicSessionSnapshot | null> {
    throw new Error("unexpected control");
  }

  public async session(): Promise<MusicSessionSnapshot | null> {
    this.sessionCalls += 1;
    return null;
  }

  public async destroy(signal: AbortSignal): Promise<void> {
    assert.equal(signal.aborted, false);
    this.events.push("destroy-started");
    this.#destroyStarted.resolve(undefined);
    await this.#releaseDestroy.promise;
    this.events.push("destroy-finished");
  }
}

class LifecycleFactory implements MusicPlaybackRuntimeFactory {
  public creates = 0;

  public constructor(public readonly runtime = new LifecycleRuntime()) {}

  public create(
    _options: MusicPlaybackRuntimeOptions
  ): MusicPlaybackRuntime {
    this.creates += 1;
    return this.runtime;
  }
}

class NeverSettlingRuntime implements MusicPlaybackRuntime {
  readonly #resolveStarted = deferred<void>();
  public destroyCalls = 0;

  public resolveStarted(): Promise<void> {
    return this.#resolveStarted.promise;
  }

  public async registerProvider(): Promise<void> {}

  public async resolve(): Promise<readonly MusicRuntimeCandidate[]> {
    this.#resolveStarted.resolve(undefined);
    return await new Promise<readonly MusicRuntimeCandidate[]>(() => {
      // This deliberately models a provider that ignores cancellation forever.
    });
  }

  public async enqueue(): Promise<MusicSessionSnapshot> {
    throw new Error("unexpected enqueue");
  }

  public async control(_input: {
    readonly control: MusicPlaybackControl;
  }): Promise<MusicSessionSnapshot | null> {
    throw new Error("unexpected control");
  }

  public async session(): Promise<MusicSessionSnapshot | null> {
    return null;
  }

  public async destroy(signal: AbortSignal): Promise<void> {
    assert.equal(signal.aborted, false);
    this.destroyCalls += 1;
  }
}

class FreshRuntime implements MusicPlaybackRuntime {
  public resolveCalls = 0;
  public destroyCalls = 0;

  public async registerProvider(): Promise<void> {}

  public async resolve(): Promise<readonly MusicRuntimeCandidate[]> {
    this.resolveCalls += 1;
    return Object.freeze([
      Object.freeze({
        providerReference: "reference:soundcloud:fresh",
        sourceProvider: "soundcloud" as const,
        title: "Fresh generation",
        author: "Artist",
        canonicalLocator: "https://soundcloud.com/artist/fresh",
        durationMs: 120_000,
        live: false
      })
    ]);
  }

  public async enqueue(): Promise<MusicSessionSnapshot> {
    throw new Error("unexpected enqueue");
  }

  public async control(_input: {
    readonly control: MusicPlaybackControl;
  }): Promise<MusicSessionSnapshot | null> {
    throw new Error("unexpected control");
  }

  public async session(): Promise<MusicSessionSnapshot | null> {
    return null;
  }

  public async destroy(signal: AbortSignal): Promise<void> {
    assert.equal(signal.aborted, false);
    this.destroyCalls += 1;
  }
}

class GenerationFactory implements MusicPlaybackRuntimeFactory {
  public creates = 0;

  public constructor(
    public readonly staleRuntime = new NeverSettlingRuntime(),
    public readonly freshRuntime = new FreshRuntime()
  ) {}

  public create(_options: MusicPlaybackRuntimeOptions): MusicPlaybackRuntime {
    this.creates += 1;
    if (this.creates === 1) return this.staleRuntime;
    if (this.creates === 2) return this.freshRuntime;
    throw new Error("unexpected runtime generation");
  }
}

describe("MusicPlaybackClient lifecycle exclusion", () => {
  it("does not begin startup for an already-aborted caller", async () => {
    const probe = new ReadyProbe();
    const factory = new LifecycleFactory();
    const client = new MusicPlaybackClient(factory, probe);
    const controller = new AbortController();
    const reason = new Error("cancel before start");
    controller.abort(reason);

    await assert.rejects(
      client.start(controller.signal),
      (error: unknown) => error === reason
    );

    assert.equal(probe.calls, 0);
    assert.equal(factory.creates, 0);
    assert.equal(client.health().state, "stopped");
  });

  it("aborts and drains accepted operations before destroying the runtime", async () => {
    const factory = new LifecycleFactory();
    const client = new MusicPlaybackClient(factory, new ReadyProbe(), {
      ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
      enabledProviders: Object.freeze(["soundcloud"]),
      bridgeProviderOrder: Object.freeze(["soundcloud"]),
      shutdownTimeoutMs: 1_000
    });
    await client.start();

    const resolving = client.resolve({
      guildId: "guild-1",
      query: "track",
      providerPolicies: Object.freeze([
        Object.freeze({
          provider: "soundcloud",
          enabled: true,
          priority: 0
        })
      ])
    });
    await factory.runtime.resolveStarted();

    const stopping = client.stop();
    const rejectedResolve = assert.rejects(resolving, {
      code: "MUSIC.CLIENT_NOT_STARTED"
    });
    await factory.runtime.destroyStarted();

    assert.deepEqual(factory.runtime.events, [
      "resolve-started",
      "resolve-aborted",
      "resolve-settled",
      "destroy-started"
    ]);
    await assert.rejects(client.session("guild-1"), {
      code: "MUSIC.CLIENT_NOT_STARTED"
    });
    await assert.rejects(client.start(), {
      code: "MUSIC.CLIENT_NOT_STARTED"
    });
    assert.equal(factory.runtime.sessionCalls, 0);

    factory.runtime.releaseDestroy();
    await Promise.all([stopping, rejectedResolve]);
    assert.equal(client.health().state, "stopped");
  });

  it("rejects excess work while a provider operation remains unsettled", async () => {
    const factory = new LifecycleFactory();
    const client = new MusicPlaybackClient(factory, new ReadyProbe(), {
      ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
      enabledProviders: Object.freeze(["soundcloud"]),
      bridgeProviderOrder: Object.freeze(["soundcloud"]),
      maximumConcurrentOperations: 1,
      maximumConcurrentOperationsPerGuild: 1,
      shutdownTimeoutMs: 1_000
    });
    await client.start();
    const policies = Object.freeze([
      Object.freeze({
        provider: "soundcloud" as const,
        enabled: true,
        priority: 0
      })
    ]);
    const first = client.resolve({
      guildId: "guild-1",
      query: "first",
      providerPolicies: policies
    });
    await factory.runtime.resolveStarted();

    await assert.rejects(
      client.resolve({
        guildId: "guild-1",
        query: "second",
        providerPolicies: policies
      }),
      /capacity is temporarily exhausted/u
    );

    const firstRejected = assert.rejects(first);
    const stopping = client.stop();
    await factory.runtime.destroyStarted();
    factory.runtime.releaseDestroy();
    await Promise.all([firstRejected, stopping]);
  });

  it(
    "detaches a never-settling provider operation before restarting with fresh capacity",
    { timeout: 2_000 },
    async () => {
      const factory = new GenerationFactory();
      const client = new MusicPlaybackClient(factory, new ReadyProbe(), {
        ...DEFAULT_MUSIC_PLAYBACK_CLIENT_OPTIONS,
        enabledProviders: Object.freeze(["soundcloud"]),
        bridgeProviderOrder: Object.freeze(["soundcloud"]),
        maximumConcurrentOperations: 1,
        maximumConcurrentOperationsPerGuild: 1,
        shutdownTimeoutMs: 100
      });
      const policies = Object.freeze([
        Object.freeze({
          provider: "soundcloud" as const,
          enabled: true,
          priority: 0
        })
      ]);
      await client.start();

      const staleResolve = client.resolve({
        guildId: "guild-1",
        query: "stale",
        providerPolicies: policies
      });
      await factory.staleRuntime.resolveStarted();

      const staleRejected = assert.rejects(staleResolve, {
        code: "MUSIC.CLIENT_NOT_STARTED"
      });
      await client.stop();
      await staleRejected;

      assert.equal(factory.staleRuntime.destroyCalls, 1);
      assert.equal(client.health().state, "stopped");

      const recoveredHealth = await client.restart();
      assert.equal(recoveredHealth.state, "ready");
      assert.equal(factory.creates, 2);

      const resolved = await client.resolve({
        guildId: "guild-1",
        query: "fresh",
        providerPolicies: policies
      });

      assert.equal(factory.freshRuntime.resolveCalls, 1);
      assert.equal(resolved.items[0]?.title, "Fresh generation");
      await client.stop();
      assert.equal(factory.freshRuntime.destroyCalls, 1);
    }
  );
});
