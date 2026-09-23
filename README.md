# Music Playback Core

Reusable, provider-neutral music playback contracts and lifecycle logic for
Anto-Project. This repository is a code artifact, not a runtime service.

## Boundary

- The root package owns media/provider models, safe provider selection,
  playback lifecycle, bounded orchestration and runtime ports.
- The `./node` entrypoint owns bounded host FFmpeg and yt-dlp probes.
- Discord SDKs, Discord Player, voice transport and provider bindings live in
  Antobot's separate `discord-music-adapter` package. This core does not depend
  on or import Discord.js, directly or indirectly.
- Product commands, permissions, localization, templates, subscription policy
  and destination selection remain in the owning product.

Consumers add this repository as a submodule tracking `main`, install it as a
workspace/file dependency, and commit the verified gitlink SHA. Generated
`dist/` artifacts are committed so a clean submodule checkout is immediately
resolvable; CI rebuilds them and verifies that they match the source.

Antobot composes this package with its Discord adapter and `discord-bot-core`.
Neither core imports or depends on the other. UniBot does not depend on Antobot
or this package: it composes only
`discord-bot-core` and its University-owned features. Sharing a technical
package never creates a runtime call or an ownership relationship between the
two products.

The yt-dlp executable is supplied and updated by the host. Dependency install
scripts remain disabled; host probes use the exact `/usr/bin/ffmpeg` and
`/usr/bin/yt-dlp` paths. Streaming belongs to the Discord adapter.
