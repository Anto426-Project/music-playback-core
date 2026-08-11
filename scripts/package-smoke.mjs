import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const temporary = mkdtempSync(
  path.join(tmpdir(), "music-playback-core-smoke-")
);

const run = (command, arguments_, cwd) => {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_cache: path.join(temporary, ".npm-cache")
    }
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed:\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
};

try {
  const sourcePackage = JSON.parse(
    readFileSync(path.join(process.cwd(), "package.json"), "utf8")
  );
  run(
    "npm",
    ["pack", "--pack-destination", temporary],
    process.cwd()
  );
  const filename =
    `${sourcePackage.name.replace(/^@/u, "").replace("/", "-")}-${sourcePackage.version}.tgz`;
  const tarball = path.join(temporary, filename);

  const consumer = path.join(temporary, "consumer");
  const consumerNodeModules = path.join(consumer, "node_modules");
  const installedScope = path.join(
    consumerNodeModules,
    "@anto-project"
  );
  mkdirSync(installedScope, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", installedScope], consumer);
  renameSync(
    path.join(installedScope, "package"),
    path.join(installedScope, "music-playback-core")
  );

  for (const dependency of Object.keys(sourcePackage.dependencies ?? {})) {
    const link = path.join(consumerNodeModules, dependency);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(
      path.join(process.cwd(), "node_modules", dependency),
      link,
      "dir"
    );
  }

  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "music-playback-core-smoke-consumer",
        private: true,
        type: "module",
        dependencies: {
          "@anto-project/music-playback-core": `file:${tarball}`
        }
      },
      null,
      2
    )
  );
  writeFileSync(
    path.join(consumer, "smoke.mjs"),
    [
      'import { MusicPlaybackError } from "@anto-project/music-playback-core";',
      'import { NodeFfmpegMediaProbeAdapter } from "@anto-project/music-playback-core/node";',
      'import { NodeDiscordPlayerProviderBinding } from "@anto-project/music-playback-core/discord-player";',
      'if (new MusicPlaybackError("MUSIC.CONTROL_INVALID", "safe", false).code !== "MUSIC.CONTROL_INVALID") process.exit(2);',
      'if (!(new NodeFfmpegMediaProbeAdapter("/invalid/ffmpeg"))) process.exit(3);',
      'if (typeof NodeDiscordPlayerProviderBinding !== "function") process.exit(4);'
    ].join("\n")
  );
  run("node", ["smoke.mjs"], consumer);

  const packageJson = JSON.parse(
    readFileSync(path.join(consumer, "node_modules/@anto-project/music-playback-core/package.json"), "utf8")
  );
  assert.equal(packageJson.name, "@anto-project/music-playback-core");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
