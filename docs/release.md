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

Any of them could read `.git/config`. The issue was originally filed naming only the first two; refinement widened it to the rest, and that is what rules out the "just split the job" fix -- `pnpm publish` **is** consumer code, so a split still stands the PAT next to lifecycle scripts. Push access to any one of the **twelve** `abofs/stonyx*` repos therefore yielded a credential reaching all of them, including repos the actor could not push to. Twelve, not eleven: the count that gets re-derived here is the ten published packages plus this repo, which omits the private `abofs/stonyx-dashboard`. It publishes nothing, so it is easy to miss, but it consumes `ci.yml@main` and `security-audit.yml@main` and so is inside the blast radius like everything else. (It declares no git-protocol dependencies either, so the consumer-impact assessment below holds for it unchanged.) No injection was required; that was the workflow operating exactly as designed ([stonyx-workflows#35](https://github.com/abofs/stonyx-workflows/issues/35)).

**It had already happened.** 21 published `@stonyx/cron` versions (`0.2.1-alpha.0`, `0.2.1-beta.0` through `beta.19`) shipped `package/.git/config` containing a real credential to the **public npm registry** -- four distinct tokens, all since revoked.

Two sets get conflated here, so they are separated once and for all. From a sweep of all 1,389 published tarballs across the ten published Stonyx packages -- nine `@stonyx/*` plus the unscoped core package `stonyx`:

| set | count | which |
| --- | --- | --- |
| ships `package/.git/config` at all | 23 | the 21 in the next row, plus `@stonyx/cron@0.2.0` and `@stonyx/events@0.1.0` |
| **credential-bearing** | **21** | all `@stonyx/cron`: `0.2.1-alpha.0`, `0.2.1-beta.0` through `beta.19` |
| metadata-only, no credential in any form | 2 | `@stonyx/cron@0.2.0`, `@stonyx/events@0.1.0` |

The two metadata-only artifacts were packed from a **workstation**, not from CI: `git@github.com:` SSH remotes, local branch names, and GitKraken/VS Code keys (`gk-last-accessed`, `vscode-merge-base`). Both were opened and dumped in full -- zero `http.extraheader`, zero `AUTHORIZATION`, no credential of any kind. **21 is the security number**, and the "four distinct tokens, all since revoked" accounting covers every credential-bearing artifact that exists. There are no unchecked artifacts.

**What spared the other packages was not a `files` allowlist.** The published tarballs falsify that in both directions: the leaking `@stonyx/cron` versions declared `files: ["*"]`, which excludes nothing, while `@stonyx/discord@0.1.0` and `@stonyx/sockets@0.1.0` declared the identical `["*"]` and stayed clean. The real mechanism, established on [stonyx-workflows#47](https://github.com/abofs/stonyx-workflows/pull/47), is a **basename collision in pnpm's packlist**: a top-level path in `files` whose basename matches a file inside `.git` drags that file in.

```
files: ["*"]                  -> 0 .git entries
files: ["*"] + config/        -> package/.git/config
files: ["*"] + description/   -> package/.git/description
files: ["**"] or [".git/**"]  -> the whole .git
```

Identical on pnpm 9.15.9 and 10.23.0; npm's own packer does not do this. `@stonyx/cron` declares `config/environment.js`, so it shipped exactly the one `.git` entry named `config`; `discord` and `sockets` had no colliding top-level directory. So the margin was narrower than "an allowlist" and stranger -- it turned on whether a repo happened to have a directory sharing a name with a file in `.git`.

**A narrow allowlist *would* have prevented it, and is the one thing protecting these packages today.** `@stonyx/cron@0.2.1-beta.96`, the current beta, declares `files: ["dist", "config", "README.md"]` -- `config` is precisely the colliding basename -- and packing that exact list against a real `.git` on pnpm 10.23.0, with no `.npmignore` present, ships **zero** `.git` entries: the collision needs the `*` glob to expand, so an explicit top-level path does not drag its namesake in. That is one layer, not two. The `.npmignore` those repos carry spells the rule `.git` (nine of the ten) or `.git/` (one), and under `files: ["**"]` neither excludes anything -- only `.git/**` does, and no repo uses it ([stonyx-workflows#49](https://github.com/abofs/stonyx-workflows/issues/49)). **A `files` list narrow enough to hold is still a per-consumer setting that can change without anything here noticing**, so the durable control is the one this change makes: never write a credential into `.git/config` in the first place.

### What happens now

- **The cascade checkout** (`npm-publish.yml`) and **the dependency-map checkout** (`cascade.yml`) both set `persist-credentials: false`. `cascade.yml`'s dispatch step already passed the PAT explicitly as `github-token:`, so nothing there read it from disk in the first place.
- **The three ambient-token checkouts** (`ci.yml`, `self-ci.yml`, `security-audit.yml`) set it too. None of them reads git credentials, and each runs `pnpm install` lifecycle scripts, so a persisted `GITHUB_TOKEN` was a live credential sitting next to consumer code for no benefit.
- **The two steps that push** -- `Commit version bump and create tag (beta)` and `(stable)` -- receive the token through a step `env:` as `GIT_REMOTE_TOKEN`, using the **same expression the checkout uses**, so the identity that pushes is unchanged. They hand it to git through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, set **per command** rather than exported. Nothing is written to disk, the encoded credential outlives no process but the one it is prefixed to, and the credential never appears in a process argv. Read the next paragraph before concluding anything stronger than that.

**`git add`, `git commit` and `git tag` in those same steps do get the raw token too.** `GIT_REMOTE_TOKEN` is a step-level `env:`, so it is in the environment of every process in both steps -- all five `git` invocations, not the two remote ones. What the per-command form withholds from the local three is `GIT_CONFIG_VALUE_0`, which is a base64 *encoding* of a token they already hold in plaintext. Withholding the encoding is not containment, and an earlier draft of this section said it was.

This is asserted behaviourally -- `test/checkout-credentials-test.js` executes both real `run:` bodies against a `git` stub that records each invocation's argv *and* environment, and pins `GIT_REMOTE_TOKEN === 'SENTINEL-PAT'` on `add`, `commit` and `tag` explicitly. The per-command `GIT_CONFIG_*` form is still worth keeping: it is what stops the credential landing in a config file or a process argv. It just does not scope the secret to two of the five processes.

### What this means for a consumer

Nothing changes in your `publish.yml`, and nothing changes about which identity pushes your release commit or tag.

If your repo has a build step that expects to run authenticated git commands out of the checked-out workspace -- a `postinstall` that fetches a private git dependency, say -- it will now fail, and it should: that step was reading a credential it was never meant to have. Declare the dependency through the registry instead.

### Residual exposure, stated plainly

**The raw PAT is in the environment of both push steps in full, for the whole step.** A consumer-supplied git hook fired by *any* of `commit`, `tag`, `pull` or `push` can read it -- `pre-commit`, `prepare-commit-msg`, `commit-msg` and `post-commit` included, not only the pre-push ones. Two same-class paths are open and worth naming rather than leaving implicit: a `$GITHUB_PATH` append from an earlier lifecycle script shimming `git`, and `/proc/<pid>/environ` on the runner.

This does **not** enlarge what an attacker can reach. Anyone able to repoint `core.hooksPath` already gets the token from the `pull`/`push` hooks, so the reachable credential set is unchanged; the window is five processes across two steps rather than two. And it remains far smaller than what it replaces -- a file on disk readable by every step for the whole job, across all ten consumer-code execution sites.

Closing it means not holding a long-lived org-wide PAT in the job at all, which is the only thing that closes all three paths at once. That is [stonyx-workflows#36](https://github.com/abofs/stonyx-workflows/issues/36) -- a GitHub App installation token scoped to the specific dependent repos, minted per run -- which is on hold pending an owner decision and is **not** implemented here.

### Runbook: the cascade push fails

This change moves where a git credential failure surfaces, so it gets a runbook like the registry failures above. It applies to every release path except **alpha**, which publishes and never commits, so it has no push step to fail. Both commit steps gate on the computed version string rather than the release type, so `custom`, `patch`, `minor` and `major` all land on the stable one.

**How to recognise it.** The job reds at `Commit version bump and create tag (beta)` or `Commit version bump and create tag (stable)`, on the `authed_git pull` or `authed_git push` line, typically with a `403`/`401` or `could not read Username`. Two things make this different from before:

- **It surfaces at the end of the job rather than the start.** Previously the credential was written into `.git/config` at `Checkout code` (step 1 of 26), so a bad push credential could fail there, before anything was published. Now the checkout succeeds on a token it discards, and the first thing that exercises the push credential is the push step itself (step 22 or 24 of 26) -- after the package is already on the registry.
- **`Checkout code` being green tells you nothing about the push credential.** They are the same expression, but the checkout only needs read access to one repo.

Distinguish it from the failure that looks identical but is not credential-related: `authed_git pull --rebase --autostash` can also red on a genuine rebase conflict or a non-fast-forward, which is a branch-state problem and needs no credential work at all. Read the message before assuming the credential.

**What state the repo and the registry are in when it fails.** This is the part to get right before touching anything:

| | state |
| --- | --- |
| **npm** | **Already published.** `Publish to NPM (beta)` / `(stable)` run *before* the commit step. The version is on the registry under its dist-tag. |
| the version-bump commit | Created **locally on the runner only**. Never pushed; discarded when the runner is torn down. |
| the tag | Same -- created locally, never pushed. |
| the GitHub Release | Not created. That step runs after the commit step and is skipped. |
| downstream cascade | **Not dispatched.** A consumer's `cascade` job declares `needs: publish`, so a failed publish job skips it and no dependent repo is rebuilt. |

So the failure mode is: **the registry moved and the repo did not.** `main` still carries the pre-bump version in `package.json` and has no tag for what was published.

**What to check, in order.**

1. Read the actual git error. A `403` on push to a repo the identity can read is a permissions/expiry problem; a rebase conflict is not.
2. Confirm whether the run was in cascade mode (`cascade-source` non-empty). Cascade runs push as `CASCADE_PAT`; ordinary runs push as the ambient `github.token`. Those have different failure causes, and only the first is org-wide.
3. If cascade mode: the org PAT is the usual suspect -- expiry, a revoked grant, or a repo removed from its scope. That is an owner action; do not attempt to read or rotate the secret from a job.
4. If not cascade mode: check branch protection on the target branch. `github.token` cannot push to a branch whose protection excludes it, and that is a repo setting change, not a workflow bug.
5. Confirm the identity was not silently changed. `GIT_REMOTE_TOKEN` must bind the same expression as the checkout's `token:`; `test/checkout-credentials-test.js` reds if it drifts, so a green `self-ci.yml` on `main` already rules this out for the shipped workflow.

**How to recover.**

**Fix the credential or the branch state first.** Nothing below works until the push does. Then the two paths recover differently, because they derive their versions differently:

- **Beta.** Do not re-run expecting the same version. `Calculate next beta version` derives off the registry -- `deriveVersion` takes the highest published prerelease and adds one -- so a re-run publishes `beta.N+1` and pushes the commit and tag for **that**. `beta.N` stays on the registry as a version with no tag. That is the normal close: one re-run, and the repo and registry are consistent going forward.
- **Stable.** A re-run reds at `Publish to NPM (stable)` instead. `Bump version (stable)` runs `pnpm version patch --no-git-tag-version` against the **local** `package.json`, which never moved because the push failed, so it recomputes the version that is already on the registry and npm refuses to publish it twice. Recover by landing the bump in the repo by hand: set `package.json` to the published version in a normal PR and tag it `v<version>`, matching the spelling the workflow uses. Do not create a tag the workflow will later try to create for itself.

**Re-dispatch the cascade if the release mattered downstream.** Nothing dispatched, so dependents are still pinned to the previous version. They pick it up on their next cascade or publish; if that is too slow, the owner can dispatch `cascade-publish` to the dependents directly.
**Nothing needs to change in a consumer's `publish.yml`** in any of these cases.

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
- **`.stonyx-workflows/` exists transiently in your workspace** between the version bump and the cleanup step. It is removed before publishing, so it cannot reach your tarball, and every current Stonyx package also declares a `files` allowlist that does not list it. Treat the cleanup as the control anyway, not the allowlist: it is asserted to run before the first `pnpm publish` step in `test/workflows-test.js`, whereas an allowlist is a per-consumer setting that can change without anything here noticing. If you drop yours, the cleanup step is all that is left.

This requires no change to any consumer's `publish.yml`.
