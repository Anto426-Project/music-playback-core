# ADR-0001: Music playback core boundary

Status: accepted

The music engine is extracted as a technical library so multiple products can
reuse the same bounded lifecycle, provider policy and media-safety rules.

The package never becomes a business authority or a process. It does not own
commands, authorization, persistence, notification routing or product
presentation. Its public declarations expose only provider-neutral contracts.
Discord Player, its extractors, the voice protocol and Discord.js are owned by
the product's separate Discord music adapter. This core has no Discord SDK
dependency, including transitive runtime dependencies.

Antobot is the product composition and the only bridge between
`discord-bot-core` and this package. Antobot observes the Discord lifecycle and
calls the music binding directly; the two reusable cores never import or
coordinate with each other. UniBot consumes `discord-bot-core` only. Neither
library permits Antobot and University Platform to call each other, and neither
changes the service communication, AccessBroker or persistence boundaries
defined by the platform specification.

Provider packages are exact direct dependencies of the Discord adapter.
Install-time binary downloads are disabled; deploy owns the approved
executables. The compiled
package is committed alongside source so a pinned submodule SHA is consumable
from a clean checkout, while CI rebuilds and checks the package boundary.
