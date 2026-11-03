# Release

Canonical release reference for all `@stonyx/*` packages published through
this repo's workflows. This revision was re-verified line-by-line against
the actual files in `.github/workflows/` and `scripts/` as committed on
`dev` at the time of writing, rather than carried forward from the previous
copy of this document. Where a claim below could not be checked against
code in *this* repo — because it concerns GitHub/npm infrastructure
settings, another repo's files, or historical registry contents — it is
marked **(unverifiable from this repo's code)** rather than restated as
fact.

## The release pipeline, step by step

1. **A PR opens or is pushed into `dev` or `main`.** `npm-publish.yml`'s
   `Determine version bump type` step sees a `pull_request` event and
   outputs `type=alpha`. Verified against the step body in
   `.github/workflows/npm-publish.yml` (the `if`/`elif` chain, lines
   218–256): a non-empty `cascade-source` is checked first (→ `beta`), then
   `pull_request` (→ `alpha`), then `push` to `refs/heads/main` (→
   `stable`), then any other `push` (→ `beta`), then the `version-type`
   dispatch input, which must be exactly `patch`, `minor`, or `major` or the
   job fails.
2. **`Calculate next alpha version`** runs, checks this repo out at
   `${{ job.workflow_sha }}` into `.stonyx-workflows/`, and calls
   `scripts/derive-version.mjs`'s `deriveVersion({ channel: 'alpha', ... })`
   with registry data it fetched via `npm view`. A registry lookup that
   fails for any reason other than a genuine `404` fails the job rather than
   silently falling back to a stale local version — verified directly in
   the inlined `npmView` helper.
3. **The release artifact is packed and guarded.** `Pack and guard the
   release artifact` runs `pnpm run prepublishOnly` if declared, `pnpm pack`
   to `$RUNNER_TEMP/stonyx-pack`, moves the single resulting `.tgz` to
   `$RUNNER_TEMP/stonyx-release.tgz`, lists its entries with `tar -tzf`, and
   hard-fails if any entry matches `^package/(.*/)?\.git(/|$)` — verified
   directly against the step body; no bypass input or per-repo opt-out
   exists in the file.
4. **`Publish to NPM (alpha)`** runs `pnpm publish
   "$RUNNER_TEMP/stonyx-release.tgz" --tag alpha --access public
   --no-git-checks` when the computed version contains `alpha`. No commit or
   tag step runs on this channel — alpha publishes and never writes back to
   the branch (confirmed: no commit/tag step's `if:` condition matches the
   alpha case).
5. **`Comment on PR with alpha version`** posts the published version and a
   `pnpm add` install command to the PR, reading both values from
   `process.env` rather than interpolating them into the script body —
   verified.
6. **Merge to `dev`** (a `push` to a non-`main` branch) runs the same
   pipeline with `type=beta`: `Calculate next beta version`, the same
   pack/guard/publish sequence tagged `beta`, then `Commit version bump and
   create tag (beta)` (commits `package.json`/`pnpm-lock.yaml`, tags
   `v<version>`, pushes using a token passed through `GIT_CONFIG_*` on the
   remote-touching commands), then `Create GitHub Release (beta)`.
7. **Merge `dev` to `main`** runs with `type=stable`: `Bump version
   (stable)` runs `pnpm version patch --no-git-tag-version` (dropping the
   prerelease suffix), then the same pack/guard/publish/commit/tag/release
   sequence, publishing untagged (`latest`).
8. **A cascade dispatch** (`repository_dispatch` with `client_payload.
   source_package`) arrives at a dependent repo's own `publish.yml`, which
   passes `cascade-source` into `npm-publish.yml`. `cascade-source` non-empty
   forces `type=beta` regardless of the triggering event, and `Update all
   Stonyx dependencies to latest` runs first to bump every `@stonyx/*`
   dependency to its latest npm version before `pnpm install
   --no-frozen-lockfile` and the rest of the beta path. Verified against the
   step bodies directly.
9. **On a successful beta or stable publish**, the child repo's own
   `cascade` job (per the README's child-repo template) is gated on
   `needs.publish.outputs.version-channel == 'beta' || ... == 'stable'` and
   calls `cascade.yml`, which validates `package-name` and
   `published-version` against the npm-name and semver grammars, reads
   `dependency-map.json`, deduplicates dependents by repo, and sends one
   `repository_dispatch` per unique dependent repo. Verified against
   `.github/workflows/cascade.yml` directly, including the validation order
   (both inputs are checked before `dependency-map.json` is even read).

### Known gap: issue #60

Open issue
[abofs/stonyx-workflows#60](https://github.com/abofs/stonyx-workflows/issues/60)
(refined, priority-high; not addressed by this documentation change) covers
two gaps in step 9 above, stated as fact:

- **An alpha publish never triggers a cascade dispatch**, because the
  child-repo template's `cascade` job gate only matches `beta`/`stable`
  channels — confirmed structurally from the template in the README, which
  this document does not reproduce in full (see
  [docs/areas/cascade.md](areas/cascade.md)).
- **No release fires when a cascade run changes no dependency** — logged as
  a known gap by the issue; this document does not attempt to characterize
  the underlying mechanism, consistent with this pass being documentation
  only.

### Where `ci.yml`, `security-audit.yml` and `self-ci.yml` fit

Neither `ci.yml` nor `security-audit.yml` publishes anything — `ci.yml`
gates a consumer's PR (tests, build, docs-import check) and
`security-audit.yml` runs an advisory `pnpm audit` with
`continue-on-error: true`. `self-ci.yml` is not `workflow_call:` at all; it
runs this repo's own `pnpm test` on every PR and every push to `main`
against this repo's own tree, and — because there is no rehearsal
environment for the reusable workflows themselves (see "No rehearsal path"
below) — it is the only automated check a change to this repo's workflow
YAML or `scripts/` passes through before it is live for every consumer at
`@main`.

## Registry failures during any publish

`Calculate next alpha version` (every PR) and `Calculate next beta version`
(every push to a non-`main` branch) both query npm for current published
versions, and both fail the job outright on any registry error other than a
genuine `404` — verified directly in each step's inlined `npmView` helper
(the `catch` block checks `/E404|404 Not Found/` against stderr and returns
`null` only for that case; everything else prints `::error::` and
`process.exit(1)`). A `404` still means "not published yet" and falls back
to the local `package.json` version, which is also confirmed in code
(`latestStable = require("./package.json").version` when `latestRaw ===
null`).

## What gets published, and what stops it

Verified directly against the `Pack and guard the release artifact` step in
`npm-publish.yml`:

- It packs to `$RUNNER_TEMP/stonyx-release.tgz` once; the three `Publish to
  NPM (alpha|beta|stable)` steps all publish that same file by path, so the
  guarded bytes and the uploaded bytes are the same object.
- `pnpm run prepublishOnly` is invoked explicitly before packing, because
  `pnpm pack` runs `prepack`/`prepare` but not `prepublishOnly`, and a
  tarball publish runs no lifecycle scripts at all.
- The denylist regex is `^package/(.*/)?\.git(/|$)`, matched against `tar
  -tzf`'s entry list; a match at any depth (not just the package root)
  hard-fails the step with no bypass input and no per-repo opt-out.
- The step has internal anti-vacuity checks: it refuses to pass if the
  entry count is below 2, if `package/package.json` is absent from the
  listing, or if `tar`'s own exit status is non-zero (a truncated archive
  still lists the entries it reached, so a non-zero exit is treated as
  "the input to this guard was incomplete," not ignored).

**Not verifiable from this repo's code:** the historical incident narrative
in the previous version of this document — specific counts of published
tarballs that leaked `.git/config` (23 total, 21 credential-bearing), the
named versions (`@stonyx/cron@0.2.0`, `@stonyx/events@0.1.0`,
`@stonyx/cron@0.2.1-alpha.0` through `beta.19`), the claim that two of them
were published by hand from a workstation outside CI, and "four distinct
tokens, all since revoked" — is forensic history about the actual contents
of the public npm registry and past publishes. None of that is visible from
the workflow YAML or scripts in this checkout; confirming it would require
querying npm's registry metadata and is out of scope for this documentation
pass (which stays inside this repo's files). Likewise unverifiable from here:
the claim that "all ten published `@stonyx/*` packages currently declare a
narrow `files` allowlist" and the specific pnpm packlist basename-collision
mechanism's measured results (`pnpm 9.15.9` and `10.23.0` behavior table) —
those describe other repos' `package.json` contents and pnpm's packing
behavior under conditions not re-run in this session.

## OIDC trusted publishing

Verified from this repo's code: `npm-publish.yml` declares `permissions:
id-token: write` at the workflow level, `actions/setup-node@v4` is given
`registry-url: 'https://registry.npmjs.org'`, and no `NPM_TOKEN` or any npm
auth token is referenced anywhere in the file — the only secret the
workflow declares is `CASCADE_PAT`, used only for cascade-mode checkout and
push. This is consistent with the document's claim that no npm token is
stored in repo secrets and publishing relies on GitHub OIDC.

**Not verifiable from this repo's code:** whether npm Trusted Publishing is
actually configured correctly on npmjs.com for each package (the
README itself lists it as a prerequisite, i.e. an action taken outside this
repo); the specific attestation claims from the previous document (nine of
ten packages attest their newest version, `@stonyx/discord` has "never
produced an attestation in 109 versions," `@stonyx/cron`'s `_npmUser` having
a `trustedPublisher` block) — these are facts about npm registry metadata
for other repos' published packages, not about code in this repo, and were
not re-queried in this session. The general claim that "the npm OIDC
identity is repo-bound and package-bound" is a property of npm's trusted
publishing design and GitHub's OIDC token claims, not something this repo's
YAML asserts or enforces itself — it is asserted by the doc, plausible given
how OIDC trusted publishing is documented to work, but not verifiable by
reading this repo's code.

## The OIDC / `CASCADE_PAT` threat model

Verified from this repo's code: the npm-publishing identity (OIDC, scoped by
`id-token: write` and npm's trusted-publishing configuration) is a different,
narrower credential from `CASCADE_PAT`. `CASCADE_PAT` is the only secret
`cascade.yml` declares (`required: true`) and the only secret
`npm-publish.yml` declares (`required: false`, used only when
`cascade-source` is non-empty, for the main checkout's `token:` and for
`GIT_REMOTE_TOKEN` in the two push steps). `cascade.yml`'s dispatch step
passes it explicitly as `github-token:` to `actions/github-script@v7` rather
than relying on a persisted credential. This matches the previous document's
claim that `CASCADE_PAT` is "the credential with org-wide reach" as far as
this repo's own code goes.

**Not verifiable from this repo's code:** the actual grant/scope of
`CASCADE_PAT` as configured in GitHub's org secrets settings, whether it is
in fact granted to "all Stonyx repos" as the README's "CASCADE_PAT Setup"
section instructs, and the actual OIDC trust relationship configured on
npmjs.com for each package. All three are infrastructure/settings, not code
in this checkout, and operating or inspecting them is out of scope for this
documentation pass.

## Checkout credential handling

Verified directly against every `actions/checkout` call in all five workflow
files: `ci.yml` (two checkouts), `npm-publish.yml` (two checkouts),
`cascade.yml` (one checkout), `security-audit.yml` (one checkout), and
`self-ci.yml` (one checkout) **all** set `persist-credentials: false`. In
`npm-publish.yml`, the two steps that genuinely need to reach a git remote
(`Commit version bump and create tag (beta|stable)`) are instead handed a
token through a step-level `env: GIT_REMOTE_TOKEN`, using the same
expression the checkout would have used (`(inputs.cascade-source != '' &&
secrets.CASCADE_PAT) || github.token`), and apply it to the `pull`/`push`
git invocations via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/
`GIT_CONFIG_VALUE_0` set per command.

This matches the previous document's residual-exposure claim exactly: because
`GIT_REMOTE_TOKEN` is a step-level `env:`, the raw token is in the process
environment of **all five** `git` invocations in each of those two steps
(`add`, `commit`, `tag`, `pull`, `push`), not only the two that use the
encoded `GIT_CONFIG_VALUE_0` form. Confirmed by reading the step bodies
directly — this is not a subtle inference, the `env:` block is scoped to the
whole step in the YAML.

**Not verifiable from this repo's code:** the historical claim that this
exact gap already happened and leaked 21 real credential-bearing tarballs —
see "What gets published" above; that is the same forensic-history caveat.

## No rehearsal path

Verified from this repo's code: `npm-publish.yml` has no `on:
workflow_dispatch` of its own (it is `workflow_call`-only, so dispatch, if
any, lives in a *consumer's* `publish.yml`, not here), and no workflow file
in this repo references a canary or staging npm org. `self-ci.yml` running
`pnpm test` against this repo's own tree (confirmed: `pnpm install
--frozen-lockfile` then `pnpm test`, no other step) is, as far as this
repo's own CI configuration goes, the only automated gate before a merge to
`main` takes effect for every consumer pinned at `@main`.

**Not verifiable from this repo's code:** whether `workflow_dispatch` is
actually "frozen" at the organization or repo-settings level on
`abofs/stonyx*` repos, and whether an `stonyx-canary` npm org does or does
not exist. Both are external state (GitHub/npm account configuration), not
something expressed in this repo's YAML or scripts, and checking either is
out of scope for a documentation-only pass confined to this repo's working
directory.

## The publish workflow fetches a script into your workspace

Verified directly: the `Checkout stonyx-workflows (for version derivation
script)` step's `if:` condition is `steps.version-type.outputs.type ==
'alpha' || steps.version-type.outputs.type == 'beta'` — alpha and beta paths
only, as claimed. It checks this repo out to `.stonyx-workflows/` at
`${{ steps.workflows-ref.outputs.sha }}`, itself read from `${{
job.workflow_sha }}` with a hard failure (`::error::job.workflow_sha is
empty...`) if that is ever empty. `Remove stonyx-workflows checkout` runs
with `if: always()` immediately after the alpha/beta version-calculation
steps and well before `Pack and guard the release artifact` or any `Publish
to NPM` step — confirmed by step order in the file — so the checked-out
tree cannot reach the packed tarball via this mechanism regardless of a
consumer's own `files` allowlist.

## Summary of discrepancies / unverifiable claims found while re-checking

None of the previous document's claims about this repo's own workflow logic
were found to be *incorrect* against the current code — every mechanism
claim above was confirmed by reading the actual step bodies. What changed in
this rewrite is explicitness about **what kind of claim each statement is**.
Flagged as asserted-but-unverifiable-from-this-repo's-code (all are
infrastructure, other-repos'-files, or historical-registry-state claims,
never contradictions of the code):

1. The specific leaked-credential incident history (tarball counts, named
   versions, "four distinct tokens, all since revoked," workstation-publish
   claims) — npm registry/git history forensics.
2. "All ten published `@stonyx/*` packages currently declare a narrow
   `files` allowlist" and the pnpm-packlist basename-collision measurement
   table — other repos' `package.json` contents and a pnpm-version-specific
   behavior not re-run in this session.
3. npm provenance/attestation specifics (`@stonyx/discord`'s 109 versions,
   the `@stonyx/cron` `trustedPublisher` block, "nine of ten attest") — npm
   registry metadata for packages this repo does not contain.
4. Whether `workflow_dispatch` is actually frozen at the org/repo-settings
   level on `abofs/stonyx*`, and whether an `stonyx-canary` npm org exists —
   external GitHub/npm account configuration.
5. The actual grant/scope of `CASCADE_PAT` as an org secret, and the actual
   OIDC trust configuration for npm Trusted Publishing on npmjs.com — both
   are settings in GitHub's and npm's own UI, not expressed in this repo's
   YAML.
6. The general npm-OIDC-identity-is-repo-and-package-bound claim — a
   property of npm's trusted-publishing design, not something this repo's
   workflow code itself enforces or could be used to verify.

Everything else in this document — the version-channel selection logic, the
release-artifact `.git` denylist, the `CASCADE_PAT` usage sites, the
checkout `persist-credentials: false` pattern, the step-level `env:` token
exposure, the alpha/beta script-fetch-and-cleanup mechanism, and the
cascade-dispatch validation order — was checked directly against the
current `.github/workflows/*.yml` and `scripts/*.mjs` files in this
checkout and against the `pnpm test` run described in
[docs/index.md](index.md#build-run-test) (472 passing, 0 failing).
