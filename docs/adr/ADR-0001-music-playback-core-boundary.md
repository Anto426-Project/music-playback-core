# ADR-0001: Music playback core boundary

Status: accepted

The music engine is extracted as a technical library so multiple products can
reuse the same bounded lifecycle, provider policy and media-safety rules.

The package never becomes a business authority or a process. It does not own
commands, authorization, persistence, notification routing or product
presentation. Music-specific provider dependencies and the Discord Player
adapter stay in the `./discord-player` subpath. Its public declarations expose
only provider-neutral contracts. `NodeDiscordPlayerProviderBinding` accepts an
opaque provider client through explicit, generation-aware bind/release
operations; it has no dependency on, or lifecycle protocol shared with, a
gateway core. Discord.js objects never cross the concrete adapter boundary and
are released before their owning gateway generation is destroyed.

Antobot is the product composition and the only bridge between
`discord-bot-core` and this package. Antobot observes the Discord lifecycle and
calls the music binding directly; the two reusable cores never import or
coordinate with each other. UniBot consumes `discord-bot-core` only. Neither
library permits Antobot and University Platform to call each other, and neither
changes the service communication, AccessBroker or persistence boundaries
defined by the platform specification.

Provider packages are exact direct dependencies here, including the
`youtube-dl-exec` version used by the YouTubei extractor and its `mediaplex`
peer. Install-time binary downloads are disabled; deploy owns the approved
executables. The compiled
package is committed alongside source so a pinned submodule SHA is consumable
from a clean checkout, while CI rebuilds and checks the package boundary.
