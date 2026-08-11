import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const filesUnder = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  });

describe("music core architecture", () => {
  it("confines every music SDK to the concrete Discord Player adapter", () => {
    const sources = filesUnder("src").filter((file) => file.endsWith(".ts"));
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      if (file === path.join("src", "discord-player.ts")) {
        assert.match(source, /from\s+["']discord\.js["']/u);
        assert.match(source, /from\s+["']discord-player["']/u);
        assert.match(source, /from\s+["']@discord-player\/extractor["']/u);
        assert.match(source, /from\s+["']discord-player-youtubei["']/u);
        assert.match(source, /from\s+["']youtube-dl-exec["']/u);
        assert.match(
          source,
          /createStream:\s*createSafeYoutubeStream/u,
          "the upstream unsafe yt-dlp fallback must stay replaced"
        );
        assert.match(source, /spawn\(\s*APPROVED_YT_DLP_PATH/u);
        assert.doesNotMatch(
          source,
          /youtubeDlRuntime\.exec/u,
          "streaming must not use youtube-dl-exec's whole-output buffer"
        );
      } else {
        assert.doesNotMatch(
          source,
          /from\s+["'](?:discord\.js|discord-player|discord-player-youtubei|youtube-dl-exec|@discord-player\/)/u,
          `${file} must use the provider-neutral runtime ports`
        );
      }
      assert.doesNotMatch(
        source,
        /from\s+["'][^"']*(?:antobot|access-broker|core-db|university)/iu
      );
    }

    const packageJson = JSON.parse(
      readFileSync("package.json", "utf8")
    ) as { dependencies?: Record<string, string> };
    assert.deepEqual(packageJson.dependencies ?? {}, {
      "@discord-player/extractor": "7.2.0",
      "discord-player": "7.2.0",
      "discord-player-youtubei": "3.0.0-beta.4",
      "discord.js": "14.27.0",
      "mediaplex": "1.0.0",
      "youtube-dl-exec": "3.1.4"
    });
  });

  it("emits provider-neutral public declarations", () => {
    const declarations = filesUnder("dist")
      .filter((file) => file.endsWith(".d.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const declarationCode = declarations
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    assert.doesNotMatch(
      declarationCode,
      /(?:from\s+["']|import\s*\(["'])(?:discord\.js|discord-player|discord-player-youtubei|youtube-dl-exec|@discord-player\/)|\b(?:Client|GuildQueue|Track|Player)\b/u
    );
  });
});
