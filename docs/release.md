# Release

This document is the canonical release reference for all `@stonyx/*` packages. Individual repos link here rather than duplicating the process.

## Release pipeline

All Stonyx packages follow a 3-stage pipeline:

| Stage | Trigger | npm tag | Example version |
|---|---|---|---|
| Alpha | PR push | `alpha` | `0.x.y-alpha.N` |
| Beta | Merge to main | `beta` | `0.x.y-beta.N` |
| Stable | Manual workflow dispatch (**currently frozen** -- see [No rehearsal path](#no-rehearsal-path)) | `latest` | `0.x.y` |

> **Target state (pending [stonyx-workflows#5](https://github.com/abofs/stonyx-workflows/issues/5)):** PRs will target `dev` (beta on merge), and `dev` merges to `main` (stable on merge). This replaces manual dispatch for stable releases.

Beta and stable releases also create a GitHub release.

## How it works

- **Versioning is automatic** -- managed by CI workflows defined in this repo (`stonyx-workflows`). No manual version bumps needed.
- **PR-based workflow** -- open a PR, push commits, and alpha builds publish automatically. Merge to main for beta.
- **Stable releases** -- nominally triggered via manual workflow dispatch in GitHub Actions (pending migration to branch-based per [stonyx-workflows#5](https://github.com/abofs/stonyx-workflows/issues/5)). `workflow_dispatch` on `abofs/stonyx*` is **frozen at present**, so the manual path documented above and in the pipeline table cannot currently be executed. This matters beyond release planning, but it does **not** mean the input validators are unreachable. Dispatch is the only trigger that reaches `custom-version`, so that input's validator genuinely cannot be exercised in production today. `version-type` is different: dispatch is its only *intended* trigger, but a malformed `repository_dispatch` carrying no `source_package` reaches it too. Measured against the real `Determine version bump type` body -- `cascade-source` empty, event neither `push` nor `pull_request`, `custom-version` empty -- every branch falls through to the final `else` and the job exits 1 with `::error::version-type must be one of patch, minor, major (got: )`. That validator is live in production today, on the one path that matters, and it is where a malformed cascade dispatch now stops instead of publishing an unbumped version. See the README's *Eight observable behaviour changes*, item 6.

## Cascade publishing

When a dependency publishes a beta or stable release, `stonyx-workflows` automatically dispatches rebuilds to downstream dependents. The dependency graph is defined in [`dependency-map.json`](../dependency-map.json) in this repo.

For example, publishing `@stonyx/utils` cascades to all packages that depend on it (`stonyx`, `@stonyx/events`, `@stonyx/cron`, etc.), which in turn cascade to their own dependents.

### A registry lookup that fails now fails the job

A cascade run updates every `@stonyx/*` dependency to its latest published version before it publishes, which means it queries the npm registry once per dependency. **A lookup that fails for any reason other than a genuine `404` now fails the job**, at `Update all Stonyx dependencies to latest`.

This is intended, and it is a change ([stonyx-workflows#32](https://github.com/abofs/stonyx-workflows/issues/32)). The previous behaviour swallowed the failure and carried on, so an npm outage was indistinguishable from "this dependency is not published yet": the cascade skipped the update and published a package pinned to stale dependency ranges, green.

If a cascade goes red here during an npm incident, **there is nothing to fix in the consumer repo** -- re-run the job once the registry is reachable. A genuine `404` still means "not published yet" and is still skipped, so the first publish of a brand-new package is unaffected.

The same `catch`-removal landed in the alpha and beta version derivations, which are not cascade-specific and run far more often. See [Registry failures during any publish](#registry-failures-during-any-publish).

### Registry failures during any publish

`Calculate next alpha version` runs on **every pull request**, and `Calculate next beta version` on **every push to a non-`main` branch**, in all ten consumer repos. Both query npm for the current published versions, and both used to fall back to the local `package.json` version when that query failed for any reason.

That fallback is gone. Measured old versus new against a registry stub returning `ENETUNREACH`: the old body exited 0 with `version=0.1.1-alpha.0`; the new body exits 1. The old behaviour silently restarted the prerelease counter from a stale local version and published over it.

The practical consequence: **a transient npm registry failure now reds publish jobs across every Stonyx repo at once**, rather than publishing a wrong version quietly. Re-run once the registry is reachable. A genuine `404` -- the first publish of a package -- still falls back to the local version, unchanged.

## What gets published, and what stops it

`npm-publish.yml` packs the release artifact once, to `$RUNNER_TEMP/stonyx-release.tgz`, inspects that file, and hands that same path to `pnpm publish`. The guarded bytes and the uploaded bytes are one object rather than two packs of the same tree ([stonyx-workflows#39](https://github.com/abofs/stonyx-workflows/issues/39)).

The step **hard-fails** if the tarball contains anything under `package/.git/`. There is no bypass input and no warn mode, for two reasons. A `skip-` flag reachable through `workflow_call` from ten repos is the guard deleting itself. And warn was already tried by accident: `pnpm publish` printed the file list to the job log on all **21** of the affected runs this pipeline actually made, nobody read it for two months, and the leak was found by a consumer five months later. (23 published tarballs carried `package/.git/config`; two of them -- `@stonyx/cron@0.2.0` and `@stonyx/events@0.1.0` -- were published by `mstonepc` from a workstation, produced no job log, and are the [#42](https://github.com/abofs/stonyx-workflows/issues/42) case this workflow cannot reach at all. They are also the only two whose `.git/config` carries no credential.) npm cannot unpublish past 72 hours, so a wrong tarball is permanent and public.

### If your publish reds here

The failure names every offending path and their count. It is telling you that your package would have shipped a `.git` directory to the public registry.

- Narrow the `files` array in `package.json`. Measured on pnpm 9.15.9 (the version this workflow pins by default) and on 10.23.0, both identical:

  | `files` | ships from `.git/` |
  |---|---|
  | `["**"]` | **the whole `.git` directory** |
  | `[".git/**"]` | the whole `.git` directory |
  | `["*"]` **plus a top-level directory whose name matches a file inside `.git`** | that one file |
  | `["*"]` on its own | nothing |

  `["*"]` on its own is **not** the cause, so do not stop looking when you find it. What ships a single `.git` file is a **basename collision in pnpm's packlist**: a top-level entry in `files` whose basename matches a file inside `.git` drags that file in. `["*"]` plus a `config/` directory ships `package/.git/config`; a `description/` directory ships `package/.git/description`. That is the original incident exactly -- `@stonyx/cron@0.2.0` declared `config/environment.js` and leaked precisely one `.git` entry, `config`, with no `HEAD`, `refs` or `objects` beside it. npm's own packer does not do this; it is pnpm-specific.

- Add `.git` to `.npmignore` if you do not declare a `files` allowlist. Note the timing: the guard reds on a tarball that **already contains** the path, so `.npmignore` fixes the next run rather than the one in front of you. Re-run the job after the change lands.

**There is no per-repo opt-out**, so a false positive halts publishing across all ten consumers at once. If you believe the guard is wrong, that is a bug in this repo and the fix is a PR here, not a workaround in yours.

Concretely, because the person reading this has a red publish and is choosing between waiting and doing something worse: open a revert PR against `main` in `abofs/stonyx-workflows`, get it merged by anyone with write access there (this repo has no branch protection, and self-merge via PR is the convention), and every consumer picks it up on its next publish run. All ten pin `abofs/stonyx-workflows/.github/workflows/npm-publish.yml@main` unpinned, so there is **no consumer-side change, no re-tag and no version bump** -- re-run the failed job once the revert is on `main`. Do not publish by hand from a workstation to get around it: that is [#42](https://github.com/abofs/stonyx-workflows/issues/42), it is how two of the leaked versions were produced, and nothing in this pipeline can see it.

### The build now runs in the workflow, not in `pnpm publish`

`pnpm pack` runs `prepack` and `prepare` but **not** `prepublishOnly`, and publishing a tarball runs **no** lifecycle scripts at all. So the guard step invokes `pnpm run prepublishOnly` explicitly before it packs. Four consumers build there -- `stonyx`, `stonyx-discord`, `stonyx-events`, `stonyx-logs` -- and without the explicit invocation their `dist/` would be absent from both the inspected tarball and the published one.

Net effect on your package: the same scripts run, once. `publish` and `postpublish` would no longer run, and no consumer declares either.

### This is a regression bar, not a live hole

All ten published `@stonyx/*` packages currently declare a narrow `files` allowlist -- measured against each repo's default branch, every one of them a `dist`-rooted list with no `*` and no `.git` -- so the configuration that produced the original leak exists in zero repos today. The guard exists so it cannot come back, and so that a mechanism nobody has characterised yet is caught by looking at the artifact rather than by predicting the mechanism.

It is **not** an anti-exfiltration control. Deliberate exfiltration needs push access to a `stonyx*` repo, and from there `postinstall` reads `.git/config` directly with no publish involved. That is [#35](https://github.com/abofs/stonyx-workflows/issues/35). Denylist breadth beyond `.git/` is [#41](https://github.com/abofs/stonyx-workflows/issues/41); a maintainer running `npm publish` from a workstation bypasses this workflow entirely and is [#42](https://github.com/abofs/stonyx-workflows/issues/42).

## OIDC trusted publishing

All npm publishes use GitHub OIDC provenance. No npm token is stored in repo secrets -- the publish workflow authenticates directly with npm via GitHub's identity provider.

Publishing a pre-packed tarball rather than a directory does not affect this. `pnpm publish` **never** publishes from a directory: both of its branches hand `npm publish <a .tgz>` to the npm CLI, in 9.15.9 as well as 10.x, and `libnpmpublish` reconstructs the package spec from the manifest rather than from the CLI argument, so the provenance path never sees which form was used. Every `@stonyx/*` package has always been a tarball publish, so this PR changes which tarball, not the mode.

Attestation is a separate question and the answer is **not** "all of them". Measured against the registry per-version across all ten packages: nine attest their newest version, and **`@stonyx/discord` has never produced an attestation in 109 versions**, including its newest on every dist-tag -- `dist.signatures` present, `dist.attestations` absent -- while `@stonyx/cron` from the same workflow has both. Its `_npmUser` is `GitHub Actions` with a `trustedPublisher` block and its job was green. That is a live instance of [#43](https://github.com/abofs/stonyx-workflows/issues/43), *"Provenance auto-enable fails silently -- a publish can ship unattested with the job green"*, and it means **a green publish job is not evidence that provenance was produced**. Check the version, not the job.

### What the OIDC identity is bound to, and what it is not

This is the part that gets re-derived wrongly, so it is written down here rather than left in a PR body.

**The npm OIDC identity is repo-bound and package-bound.** Confirmed from the npm provenance attestations on `@stonyx/orm`, `@stonyx/cron` and `@stonyx/oauth`, each of which names one repo and one workflow. A compromised publish job in repo A can publish package A and nothing else. It **cannot** publish as an arbitrary `@stonyx/*` package; anyone who can land a commit in repo A could already publish package A by committing malicious source, so the npm capability is not widened by anything reachable from a job in that repo.

**`CASCADE_PAT` is the credential with org-wide reach.** It is an org-level PAT with `repo` scope granted to every Stonyx repo, and `cascade.yml` runs `repos.createDispatchEvent()` under it. That is why `cascade.yml` validates both of its inputs and refuses to dispatch on a value that fails, and why its guards are held to a higher bar than the publish path's.

The npm identity is bound. The GitHub identity is not. Do not reason about one from the other.

## Workflow consumption

All Stonyx repos reference workflows from this repo via:

```
uses: abofs/stonyx-workflows/.github/workflows/<workflow>.yml@main
```

Changes to workflows take effect immediately when merged to `main`. Coordinate breaking changes with downstream repos before merging.

### No rehearsal path

There is **no staging path for these workflows**. Every consumer references `@main` with no pin and no opt-in, so a merge here is a deploy to all of them at once.

Nor can a change be rehearsed before it lands: `workflow_dispatch` on `abofs/stonyx*` is frozen, and the `stonyx-canary` npm org does not exist, so there is no way to drive a real publish against a candidate revision.

**`self-ci.yml`'s `node:test` suite is therefore the only gate.** A change that is not covered by an executed test in `test/` is not covered at all -- and the rollback for a bad merge is a revert PR, after the fact, with whatever published in between already on the registry. Weigh new workflow behaviour accordingly.

### The publish workflow fetches a script into your workspace

`npm-publish.yml` does not carry all of its logic inline. On the **alpha and beta paths only**, it checks `abofs/stonyx-workflows` out into `.stonyx-workflows/` inside your repo's workspace, imports `scripts/derive-version.mjs` from it to compute the next prerelease version, and removes the directory again before any `pnpm publish` step runs.

Two consequences worth knowing:

- **The ref you pin governs the script too.** The checkout is pinned to `${{ job.workflow_sha }}` -- the exact commit your `uses:` line resolved to. Pin the workflow to `@main` and you get `main`'s derivation logic; pin it to a tag or a SHA and you get that commit's. The workflow and the script are always one artifact, never two independently-resolved ones.
- **`.stonyx-workflows/` exists transiently in your workspace** between the version bump and the cleanup step. It is removed before publishing, so it cannot reach your tarball -- and every current `@stonyx/*` package also declares a `files` allowlist that would exclude it anyway. If you drop that allowlist, the cleanup step becomes the only thing keeping it out.

This requires no change to any consumer's `publish.yml`.
