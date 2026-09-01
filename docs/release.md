# Release

This document is the canonical release reference for all `@stonyx/*` packages. Individual repos link here rather than duplicating the process.

## Release pipeline

All Stonyx packages follow a 3-stage pipeline:

| Stage | Trigger | npm tag | Example version |
|---|---|---|---|
| Alpha | PR push | `alpha` | `0.x.y-alpha.N` |
| Beta | Merge to main | `beta` | `0.x.y-beta.N` |
| Stable | Manual workflow dispatch | `latest` | `0.x.y` |

> **Target state (pending [stonyx-workflows#5](https://github.com/abofs/stonyx-workflows/issues/5)):** PRs will target `dev` (beta on merge), and `dev` merges to `main` (stable on merge). This replaces manual dispatch for stable releases.

Beta and stable releases also create a GitHub release.

## How it works

- **Versioning is automatic** -- managed by CI workflows defined in this repo (`stonyx-workflows`). No manual version bumps needed.
- **PR-based workflow** -- open a PR, push commits, and alpha builds publish automatically. Merge to main for beta.
- **Stable releases** -- currently triggered via manual workflow dispatch in GitHub Actions (pending migration to branch-based per [stonyx-workflows#5](https://github.com/abofs/stonyx-workflows/issues/5)).

## Cascade publishing

When a dependency publishes a beta or stable release, `stonyx-workflows` automatically dispatches rebuilds to downstream dependents. The dependency graph is defined in [`dependency-map.json`](../dependency-map.json) in this repo.

For example, publishing `@stonyx/utils` cascades to all packages that depend on it (`stonyx`, `@stonyx/events`, `@stonyx/cron`, etc.), which in turn cascade to their own dependents.

## OIDC trusted publishing

All npm publishes use GitHub OIDC provenance. No npm token is stored in repo secrets -- the publish workflow authenticates directly with npm via GitHub's identity provider.

## Workflow consumption

All Stonyx repos reference workflows from this repo via:

```
uses: abofs/stonyx-workflows/.github/workflows/<workflow>.yml@main
```

Changes to workflows take effect immediately when merged to `main`. Coordinate breaking changes with downstream repos before merging.

### The publish workflow fetches a script into your workspace

`npm-publish.yml` does not carry all of its logic inline. On the **alpha and beta paths only**, it checks `abofs/stonyx-workflows` out into `.stonyx-workflows/` inside your repo's workspace, imports `scripts/derive-version.mjs` from it to compute the next prerelease version, and removes the directory again before any `pnpm publish` step runs.

Two consequences worth knowing:

- **The ref you pin governs the script too.** The checkout is pinned to `${{ job.workflow_sha }}` -- the exact commit your `uses:` line resolved to. Pin the workflow to `@main` and you get `main`'s derivation logic; pin it to a tag or a SHA and you get that commit's. The workflow and the script are always one artifact, never two independently-resolved ones.
- **`.stonyx-workflows/` exists transiently in your workspace** between the version bump and the cleanup step. It is removed before publishing, so it cannot reach your tarball -- and every current `@stonyx/*` package also declares a `files` allowlist that would exclude it anyway. If you drop that allowlist, the cleanup step becomes the only thing keeping it out.

This requires no change to any consumer's `publish.yml`.
