import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  NodeFfmpegMediaProbeAdapter,
  NodeYtDlpMediaProbeAdapter
} from "../src/node.js";

const executable = (
  directory: string,
  filename: string,
  body: string
): string => {
  const target = path.join(directory, filename);
  writeFileSync(target, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(target, 0o700);
  return target;
};

describe("Node media probes", () => {
  it("recognizes bounded FFmpeg and yt-dlp versions", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "music-probes-"));
    try {
      const ffmpeg = executable(
        directory,
        "ffmpeg",
        "printf 'ffmpeg version 8.1.2 test\\n'"
      );
      const ytDlp = executable(
        directory,
        "yt-dlp",
        "printf '2026.08.11\\n'"
      );

      assert.deepEqual(
        await new NodeFfmpegMediaProbeAdapter(ffmpeg).probe({
          timeoutMs: 1_000
        }),
        { state: "ready", version: "8.1.2", failureCode: null }
      );
      assert.deepEqual(
        await new NodeYtDlpMediaProbeAdapter(ytDlp).probe({
          timeoutMs: 1_000
        }),
        { state: "ready", version: "2026.08.11", failureCode: null }
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for invalid, missing and timed-out yt-dlp executables", async () => {
    assert.equal(
      (
        await new NodeYtDlpMediaProbeAdapter("/tmp/not-youtube-dl").probe({
          timeoutMs: 1_000
        })
      ).failureCode,
      "MEDIA_ENGINE.YT_DLP_CONFIGURATION_INVALID"
    );
    assert.equal(
      (
        await new NodeYtDlpMediaProbeAdapter("/tmp/yt-dlp").probe({
          timeoutMs: 1_000
        })
      ).failureCode,
      "MEDIA_ENGINE.YT_DLP_PROBE_FAILED"
    );

    const directory = mkdtempSync(path.join(tmpdir(), "music-probes-"));
    try {
      const ytDlp = executable(directory, "yt-dlp", "sleep 2");
      assert.equal(
        (
          await new NodeYtDlpMediaProbeAdapter(ytDlp).probe({
            timeoutMs: 100
          })
        ).failureCode,
        "MEDIA_ENGINE.YT_DLP_PROBE_FAILED"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
