# Dependency review — 2026-08-11

`npm audit --omit=dev` reports zero high or critical findings, one low finding
and three moderate findings for the exact package lock.

- `file-type` is pulled by the current `@discord-player/extractor@7.2.0` and is
  affected by GHSA-5v7r-6r5c-r473. npm's proposed fix downgrades the extractor
  and Discord Player across their v7 contract, so it is not applied.
- The related moderate entries on `@discord-player/extractor` and
  `discord-player` are dependency-chain projections of that same advisory.
- The low `esbuild` advisory is inside the transitive Discord Player tooling;
  this package never starts an esbuild development server.

Compensating controls are bounded provider operations, exact media-source
allowlists, queue/session load shedding, process deadlines and circuit opening.
CI fails on new high or critical advisories. This acceptance must be reviewed
when Discord Player publishes a compatible extractor using a fixed `file-type`.
