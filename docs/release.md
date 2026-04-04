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
