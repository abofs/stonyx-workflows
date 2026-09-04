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

## OIDC trusted publishing

All npm publishes use GitHub OIDC provenance. No npm token is stored in repo secrets -- the publish workflow authenticates directly with npm via GitHub's identity provider.

### What the OIDC identity is bound to, and what it is not

This is the part that gets re-derived wrongly, so it is written down here rather than left in a PR body.

**The npm OIDC identity is repo-bound and package-bound.** Confirmed from the npm provenance attestations on `@stonyx/orm`, `@stonyx/cron` and `@stonyx/oauth`, each of which names one repo and one workflow. A compromised publish job in repo A can publish package A and nothing else. It **cannot** publish as an arbitrary `@stonyx/*` package; anyone who can land a commit in repo A could already publish package A by committing malicious source, so the npm capability is not widened by anything reachable from a job in that repo.

**`CASCADE_PAT` is the credential with org-wide reach.** It is an org-level PAT with `repo` scope granted to every Stonyx repo, and `cascade.yml` runs `repos.createDispatchEvent()` under it. That is why `cascade.yml` validates both of its inputs and refuses to dispatch on a value that fails, and why its guards are held to a higher bar than the publish path's. It is also the credential that reaches the publish job's checkout in cascade mode -- see [Git credentials in the publish job](#git-credentials-in-the-publish-job).

The npm identity is bound. The GitHub identity is not. Do not reason about one from the other.

## Git credentials in the publish job

**No `actions/checkout` in this repo persists its credential.** Every checkout sets `persist-credentials: false`, and the only two steps that reach a git remote are handed a token explicitly at their point of use.

### What was wrong

`actions/checkout@v4` defaults `persist-credentials: true`, which writes an `http.<host>/.extraheader` Authorization entry into `.git/config`. In cascade mode `npm-publish.yml` checked out with `CASCADE_PAT` -- the org-wide `repo`-scoped PAT -- and then ran **your** code in the same job, with the credential still on disk. Four kinds of step do that, at ten call sites in the current `npm-publish.yml`:

| step | your hooks it runs | sites |
| --- | --- | --- |
| `pnpm install` | `preinstall`, `install`, `postinstall` | 1 |
| `pnpm test` | your test code itself | 1 |
| `pnpm version` | `preversion`, `version`, `postversion` | 5 |
| `pnpm publish` | `prepublishOnly`, `prepack`, `prepare` | 3 |

Any of them could read `.git/config`. The issue was originally filed naming only the first two; refinement widened it to the rest, and that is what rules out the "just split the job" fix -- `pnpm publish` **is** consumer code, so a split still stands the PAT next to lifecycle scripts. Push access to any one of the eleven `abofs/stonyx*` repos therefore yielded a credential reaching all of them, including repos the actor could not push to. No injection was required; that was the workflow operating exactly as designed ([stonyx-workflows#35](https://github.com/abofs/stonyx-workflows/issues/35)).

**It had already happened.** 21 published `@stonyx/cron` versions (`0.2.1-alpha.0`, `0.2.1-beta.0` through `beta.19`) shipped `package/.git/config` containing a real credential to the **public npm registry** -- four distinct tokens, all since revoked. The only thing that stopped the other ten packages was that each declares a narrow `files` allowlist. That is the same thin margin the `.stonyx-workflows/` note below depends on, and it is not a control anyone chose.

### What happens now

- **The cascade checkout** (`npm-publish.yml`) and **the dependency-map checkout** (`cascade.yml`) both set `persist-credentials: false`. `cascade.yml`'s dispatch step already passed the PAT explicitly as `github-token:`, so nothing there read it from disk in the first place.
- **The three ambient-token checkouts** (`ci.yml`, `self-ci.yml`, `security-audit.yml`) set it too. None of them reads git credentials, and each runs `pnpm install` lifecycle scripts, so a persisted `GITHUB_TOKEN` was a live credential sitting next to consumer code for no benefit.
- **The two steps that push** -- `Commit version bump and create tag (beta)` and `(stable)` -- receive the token through a step `env:` as `GIT_REMOTE_TOKEN`, using the **same expression the checkout uses**, so the identity that pushes is unchanged. They hand it to git through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, set **per command** rather than exported. Nothing is written to disk, nothing outlives those two `git` processes, and the credential never appears in a process argv.

`git add`, `git commit` and `git tag` in those same steps do **not** get it. That is deliberate: a consumer can point `core.hooksPath` at its own code, so a hook fired by any of the three would inherit the step's environment. This is asserted behaviourally -- `test/checkout-credentials-test.js` executes both real `run:` bodies against a `git` stub that records each invocation's argv *and* environment.

### What this means for a consumer

Nothing changes in your `publish.yml`, and nothing changes about which identity pushes your release commit or tag.

If your repo has a build step that expects to run authenticated git commands out of the checked-out workspace -- a `postinstall` that fetches a private git dependency, say -- it will now fail, and it should: that step was reading a credential it was never meant to have. Declare the dependency through the registry instead.

### Residual exposure, stated plainly

The credential is still present in the *job* while a `git pull --rebase` or `git push` runs, so a consumer-supplied git hook fired by those two commands would still see it. That is a strictly smaller window than a file on disk readable by every step, and closing it entirely means not holding a long-lived org-wide PAT in the job at all. That is [stonyx-workflows#36](https://github.com/abofs/stonyx-workflows/issues/36) -- a GitHub App installation token scoped to the specific dependent repos, minted per run -- which is on hold pending an owner decision and is **not** implemented here.

### The guard

`test/checkout-credentials-test.js` fails if any `actions/checkout` taking a token other than the ambient `github.token` omits `persist-credentials: false`. It reads raw text rather than the diagnostics YAML reader, fails closed on any shape it does not understand, and treats an unrecognised token spelling as privileged. Note that the real cascade expression *contains* the literal `github.token`; a substring test for "just the ambient token" would exempt precisely the checkout this is about.

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
