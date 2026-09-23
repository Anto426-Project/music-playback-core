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
  it("does not embed a gateway-core extension protocol", () => {
    const forbiddenProtocol = [
      "@anto-project",
      "discord-bot-core",
      "provider-extension",
      "v1"
    ].join("/");
    const forbiddenSymbolFactory = ["Symbol", "for"].join(".");
    const legacyExtensionName = [
      "NodeDiscordPlayer",
      "Extension"
    ].join("");
    const repositoryFiles = [
      ...filesUnder("src"),
      ...filesUnder("tests"),
      ...filesUnder("scripts"),
      ...filesUnder("docs"),
      ...filesUnder("dist"),
      "README.md",
      "package.json",
      "package-lock.json"
    ];
    for (const file of repositoryFiles) {
      const contents = readFileSync(file, "utf8");
      assert.equal(
        contents.includes(forbiddenProtocol),
        false,
        `${file} must not embed the gateway-core extension protocol`
      );
      assert.equal(
        contents.includes(`${forbiddenSymbolFactory}(`) &&
          contents.includes("discord-bot-core"),
        false,
        `${file} must not discover a gateway-core protocol by symbol`
      );
      assert.equal(
        contents.includes(legacyExtensionName),
        false,
        `${file} must not retain the removed cross-core extension API`
      );
    }
  });

  it("keeps Discord SDKs out of the standalone music core", () => {
    const sources = filesUnder("src").filter((file) => file.endsWith(".ts"));
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(
        source,
        /from\s+["'](?:discord\.js|discord-player|discord-player-youtubei|youtube-dl-exec|@discord-player\/)/u,
        `${file} must use the provider-neutral runtime ports`
      );
      assert.doesNotMatch(
        source,
        /from\s+["'][^"']*(?:antobot|access-broker|core-db|university)/iu
      );
    }

    const packageJson = JSON.parse(
      readFileSync("package.json", "utf8")
    ) as { dependencies?: Record<string, string> };
    assert.deepEqual(packageJson.dependencies ?? {}, {});
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
