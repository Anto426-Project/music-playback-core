# Music Playback Core

Reusable, provider-neutral music playback contracts and lifecycle logic for
Anto-Project. This repository is a code artifact, not a runtime service.

## Boundary

- The root package owns media/provider models, safe provider selection,
  playback lifecycle, bounded orchestration and runtime ports.
- The `./node` entrypoint owns bounded host FFmpeg and yt-dlp probes.
- The `./discord-player` entrypoint owns Discord Player v7, its extractors,
  YouTubei, bounded yt-dlp streaming and the Discord.js provider binding.
- Only that concrete adapter imports Discord/Discord Player. The root API,
  products and their tests use provider-neutral ports and DTOs.
- `NodeDiscordPlayerProviderBinding` accepts an opaque provider client and a
  monotonic generation through explicit bind/release methods. The package does
  not know which gateway core owns that client, and no Discord.js type is
  emitted in package declarations.
- The package pins Discord Player, its official extractors, YouTubei,
  `youtube-dl-exec`, `mediaplex` and the compatible Discord.js version.
  Consumers must not declare these music dependencies themselves.
- Product commands, permissions, localization, templates, subscription policy
  and destination selection remain in the owning product.

Consumers add this repository as a submodule tracking `main`, install it as a
workspace/file dependency, and commit the verified gitlink SHA. Generated
`dist/` artifacts are committed so a clean submodule checkout is immediately
resolvable; CI rebuilds them and verifies that they match the source.

Antobot is the bridge and composition root between this package and
`discord-bot-core`: it translates the Discord core lifecycle into the explicit
music provider bind/release calls. Neither core imports or depends on the
other. UniBot does not depend on Antobot or this package: it composes only
`discord-bot-core` and its University-owned features. Sharing a technical
package never creates a runtime call or an ownership relationship between the
two products.

The yt-dlp executable is supplied and updated by the host. Dependency install
scripts remain disabled; startup probes the exact `/usr/bin/ffmpeg` and
`/usr/bin/yt-dlp` paths. The custom yt-dlp stream uses a direct, argument-array
spawn with piped audio and drained stderr, so it never buffers a whole track in
memory and never invokes a shell.
