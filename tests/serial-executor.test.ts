import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BoundedKeyedSerialExecutor } from "../src/serial-executor.js";

const deferred = <T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return Object.freeze({ promise, resolve });
};

describe("BoundedKeyedSerialExecutor", () => {
  it("serializes one guild, sheds excess work and permits another guild", async () => {
    const executor = new BoundedKeyedSerialExecutor(2);
    const firstRelease = deferred<void>();
    const events: string[] = [];
    const signal = new AbortController().signal;
    const first = executor.run("guild-1", signal, async () => {
      events.push("first-start");
      await firstRelease.promise;
      events.push("first-end");
      return 1;
    });
    const second = executor.run("guild-1", signal, async () => {
      events.push("second-start");
      return 2;
    });
    const otherGuild = executor.run("guild-2", signal, async () => {
      events.push("other-start");
      return 3;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(events, ["first-start", "other-start"]);
    await assert.rejects(
      executor.run("guild-1", signal, async () => 4),
      /capacity is temporarily exhausted/u
    );

    firstRelease.resolve(undefined);
    assert.deepEqual(await Promise.all([first, second, otherGuild]), [1, 2, 3]);
    assert.deepEqual(events, [
      "first-start",
      "other-start",
      "first-end",
      "second-start"
    ]);
  });

  it("does not start a queued operation after cancellation", async () => {
    const executor = new BoundedKeyedSerialExecutor(2);
    const firstRelease = deferred<void>();
    const signal = new AbortController().signal;
    const first = executor.run("guild-1", signal, async () => {
      await firstRelease.promise;
    });
    const controller = new AbortController();
    let secondStarted = false;
    const second = executor.run(
      "guild-1",
      controller.signal,
      async () => {
        secondStarted = true;
      }
    );
    const secondRejected = assert.rejects(second);
    controller.abort(new Error("cancel queued operation"));
    firstRelease.resolve(undefined);

    await Promise.all([first, secondRejected]);
    assert.equal(secondStarted, false);
  });
});
