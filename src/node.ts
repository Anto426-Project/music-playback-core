import { execFile } from "node:child_process";
import path from "node:path";

import type {
  MediaEngineProbeResult,
  MediaProbePort
} from "./ports.js";

const executeVersionProbe = (
  executablePath: string,
  arguments_: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      executablePath,
      arguments_,
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        ...(signal === undefined ? {} : { signal })
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });

export class NodeFfmpegMediaProbeAdapter implements MediaProbePort {
  readonly #executablePath: string;

  public constructor(executablePath = "/usr/bin/ffmpeg") {
    this.#executablePath = executablePath;
  }

  public async probe(input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<MediaEngineProbeResult> {
    const executablePath = this.#executablePath.trim();
    if (
      !path.isAbsolute(executablePath) ||
      path.basename(executablePath) !== "ffmpeg" ||
      executablePath.length > 1_024 ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 100 ||
      input.timeoutMs > 30_000
    ) {
      return Object.freeze({
        state: "unavailable",
        version: null,
        failureCode: "MEDIA_ENGINE.CONFIGURATION_INVALID"
      });
    }

    try {
      const output = await executeVersionProbe(
        executablePath,
        ["-version"],
        input.timeoutMs,
        input.signal
      );
      const firstLine = output.split(/\r?\n/u)[0]?.trim() ?? "";
      if (
        !firstLine.toLowerCase().startsWith("ffmpeg version ") ||
        firstLine.length > 1_024
      ) {
        return Object.freeze({
          state: "unavailable",
          version: null,
          failureCode: "MEDIA_ENGINE.VERSION_UNRECOGNIZED"
        });
      }
      const version = firstLine.split(/\s+/u)[2] ?? null;
      if (
        version === null ||
        version.length < 1 ||
        version.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(version)
      ) {
        return Object.freeze({
          state: "unavailable",
          version: null,
          failureCode: "MEDIA_ENGINE.VERSION_UNRECOGNIZED"
        });
      }
      return Object.freeze({
        state: "ready",
        version,
        failureCode: null
      });
    } catch {
      return Object.freeze({
        state: "unavailable",
        version: null,
        failureCode: "MEDIA_ENGINE.PROBE_FAILED"
      });
    }
  }
}

export class NodeYtDlpMediaProbeAdapter implements MediaProbePort {
  readonly #executablePath: string;

  public constructor(executablePath = "/usr/bin/yt-dlp") {
    this.#executablePath = executablePath;
  }

  public async probe(input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<MediaEngineProbeResult> {
    const executablePath = this.#executablePath.trim();
    if (
      !path.isAbsolute(executablePath) ||
      path.basename(executablePath) !== "yt-dlp" ||
      executablePath.length > 1_024 ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 100 ||
      input.timeoutMs > 30_000
    ) {
      return Object.freeze({
        state: "unavailable",
        version: null,
        failureCode: "MEDIA_ENGINE.YT_DLP_CONFIGURATION_INVALID"
      });
    }

    try {
      const output = await executeVersionProbe(
        executablePath,
        ["--version"],
        input.timeoutMs,
        input.signal
      );
      const version = output.split(/\r?\n/u)[0]?.trim() ?? "";
      if (
        version.length < 3 ||
        version.length > 128 ||
        !/^\d{4}[0-9A-Za-z._+-]*$/u.test(version)
      ) {
        return Object.freeze({
          state: "unavailable",
          version: null,
          failureCode: "MEDIA_ENGINE.YT_DLP_VERSION_UNRECOGNIZED"
        });
      }
      return Object.freeze({ state: "ready", version, failureCode: null });
    } catch {
      return Object.freeze({
        state: "unavailable",
        version: null,
        failureCode: "MEDIA_ENGINE.YT_DLP_PROBE_FAILED"
      });
    }
  }
}
