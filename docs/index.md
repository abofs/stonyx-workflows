# stonyx-workflows: Architecture

## Overview

`stonyx-workflows` provides the reusable GitHub Actions workflows (CI, npm
publish, cascade, security audit) that every other `abofs/stonyx*` repository
calls via `uses: abofs/stonyx-workflows/.github/workflows/<file>.yml@<ref>`.
It has no runtime library code of its own and ships nothing to npm: this repo
*is* delivery infrastructure, not a package consumed by one. Its only
executable surface is a private root `package.json`, a `scripts/` directory
that the reusable workflows shell out to, and a `test/` suite that exercises
both the scripts and the workflow YAML itself (by reading the real files in
`.github/workflows/` and running their `run:`/`script:` bodies against
stubbed `npm`/`git`/`github` clients).

## Areas

### `ci.yml` — the CI workflow

Reusable `workflow_call` workflow a child repo's `publish.yml` (or a
dedicated `ci.yml`) calls for every pull request. After `pnpm install
--frozen-lockfile` and `pnpm test` in the consumer's own checkout, it runs
`pnpm run --if-present build`, then checks this repo out at
`${{ job.workflow_sha }}` into `.stonyx-workflows/` to run the docs-import
check: it installs that tree's pinned `typescript`, resolves which
`@stonyx/*` packages the consumer's docs import but the consumer neither is
nor declares (`scripts/doc-registry-packages.mjs`) and installs those at
`@beta` into a `$RUNNER_TEMP` scratch directory, then runs
`scripts/check-doc-imports.mjs` against the consumer repo with that directory
as `--resolve-from`. The job holds no secrets — no `NPM_TOKEN`, no
`CASCADE_PAT` — and every checkout sets `persist-credentials: false`. See
[docs/areas/ci.md](areas/ci.md) for the full step-by-step and the test
coverage that pins it.

### `npm-publish.yml` — the publish workflow

Reusable workflow that derives the next version, runs the consumer's tests,
packs and inspects the release tarball, and publishes to npm with OIDC
provenance. Version derivation differs by channel: PR pushes compute an
`alpha` prerelease, pushes to a non-`main` branch (or a cascade dispatch)
compute a `beta`, and a push to `main` drops the prerelease suffix for a
`stable` release via `pnpm version patch`. The alpha/beta arithmetic itself
lives in `scripts/derive-version.mjs`, fetched from this repo's own checkout
at the commit the consumer's `uses:` line resolved to. See
[docs/areas/npm-publish.md](areas/npm-publish.md) for the channel-selection
logic, the release-artifact guard, and the credential handling around
`CASCADE_PAT`.

### `cascade.yml` — the cascade workflow

Reusable workflow that reads `dependency-map.json` at this repo's root and
dispatches a `repository_dispatch` (`cascade-publish`) event to every
downstream dependent of a just-published package, so a dependency bump
rebuilds everything above it. It validates `package-name` and
`published-version` against the npm name grammar and a semver grammar,
respectively, before touching the map or dispatching anything, and it runs
under the org-wide `CASCADE_PAT` rather than a repo-bound identity. **Known
gap:** per the child-repo template in the README, the `cascade` job is gated
on `needs.publish.outputs.version-channel == 'beta' || ... == 'stable'`, so
an alpha publish never triggers a cascade dispatch by design of the wiring —
and open issue
[abofs/stonyx-workflows#60](https://github.com/abofs/stonyx-workflows/issues/60)
(refined, priority-high, not addressed by this documentation pass) tracks
that the cascade does not dispatch from alpha publishes, and that no release
fires when a cascade run changes no dependency. See
[docs/areas/cascade.md](areas/cascade.md).

### `security-audit.yml` — the security-audit workflow

Reusable workflow that runs `pnpm audit --audit-level ${{ inputs.audit-level
}}` against the calling repo. It is advisory only: the audit step sets
`continue-on-error: true`, so a finding annotates the job but never fails it.
It is also the one place in this repo's workflows where a `workflow_call`
input (`audit-level`) is still interpolated directly into a shell command
rather than passed through an `env:` variable — a known, tracked, and
deliberately untouched defect
([abofs/stonyx-workflows#34](https://github.com/abofs/stonyx-workflows/issues/34)),
distinct from the injection class closed elsewhere by
[#32](https://github.com/abofs/stonyx-workflows/issues/32). See the
`security-audit.yml` section of [../README.md](../README.md) for the full
writeup, which is still accurate against the current file.

### `self-ci.yml` — how this repo tests itself

Not a reusable workflow (no `workflow_call:` trigger). It runs on every pull
request and on every push to `main`, and simply does `pnpm install
--frozen-lockfile` then `pnpm test` against this repo's own tree. It exists
so a change to the workflow YAML or to `scripts/` is gated by a check run in
this repo, rather than only by a downstream consumer publishing a real
version and finding out the hard way. Because there is no rehearsal
environment for the reusable workflows (see
[docs/release.md](release.md#no-rehearsal-path)), this `node:test` suite is
this repo's only gate before a merge to `dev`/`main` goes live for every
consumer at `@main`.

### `scripts/` — the executable logic the workflows call

- **`scripts/derive-version.mjs`** exports `deriveVersion({ channel,
  latestStable, allVersions })`, the pure prerelease-version arithmetic used
  by the `Calculate next alpha version` and `Calculate next beta version`
  steps in `npm-publish.yml`. All registry I/O stays in the workflow and is
  passed in as plain arguments, so the function itself does no network or
  filesystem access and is testable offline.
- **`scripts/check-doc-imports.mjs`** checks that every `stonyx` / `@stonyx/*`
  import a consumer's docs show can actually be copied and resolved against
  that package's real `exports`, by compiling each import statement as a
  one-line TypeScript probe. Run by `ci.yml`'s `Check doc imports` step.
- **`scripts/doc-registry-packages.mjs`** prints the `stonyx` / `@stonyx/*`
  package names a repo's docs import but that the repo neither is nor
  declares as a dependency, so `ci.yml` can install just those names
  (`@beta`) into the `--resolve-from` scratch directory consumed by
  `check-doc-imports.mjs`.
- **`scripts/run-tests.mjs`** is this repo's own `pnpm test` entry point (see
  Build, Run, Test below) — it is not called by any other repo's workflow,
  only by `self-ci.yml` and `ci.yml`'s own `pnpm test` step when they run
  *this* repo's suite.

See [docs/areas/scripts.md](areas/scripts.md) for each script's contract,
exit codes, and the test file that pins it.

## Build, Run, Test

There is no running service in this repo — the test suite is the iteration
loop. Verified in this session:

```bash
pnpm install --frozen-lockfile
pnpm test
```

`pnpm install --frozen-lockfile` resolved cleanly against the committed
`pnpm-lock.yaml` (pnpm 10.23.0, Node v24.13.0) with no lockfile changes —
only the pinned `typescript` devDependency installs. `pnpm test` runs
`node scripts/run-tests.mjs`, which globs `test/**/*-test.js` (asserting at
least two files match, so a bad rename cannot silently run zero tests) and
hands that resolved list to `node --test`. Result: **472 tests passed, 0
failed, across 53 suites**, exit code 0.

What `test/` covers, per the file (see the README's
[Tests](../README.md#tests) table for the complete, file-by-file
breakdown and docs/areas/scripts.md for script-specific detail):

- `test/derive-version-test.js` — characterizes `deriveVersion` against a
  committed, read-only capture of real registry state.
- `test/workflows-test.js` — asserts structural properties of `ci.yml`,
  `npm-publish.yml`, `cascade.yml`, `security-audit.yml` and `self-ci.yml`
  read as raw text/YAML (step order, exact `with:` values, absence of
  secrets in `ci.yml`, etc.).
- `test/publish-glue-test.js`, `test/lift-equivalence-test.js` — execute the
  real version-derivation `run:` bodies against a stubbed `npm`, and
  differentially check `deriveVersion` against the pre-lift heredocs it was
  lifted from.
- `test/injection-test.js`, `test/raw-sweep-test.js`,
  `test/sweep-bypass-test.js` — the injection/credential-safety guarantee:
  every `${{ }}` in every file under `.github/workflows/` must be named in an
  allowlist, enforced by a byte-level scanner with no YAML parsing.
- `test/checkout-credentials-test.js` — asserts no `actions/checkout` using a
  non-ambient token omits `persist-credentials: false`.
- `test/tarball-guard-test.js` — exercises the release-artifact `.git`-path
  denylist in `npm-publish.yml`.
- `test/doc-imports-test.js` — exercises `scripts/check-doc-imports.mjs`
  against the fixture packages under `test/fixtures/doc-imports/`.
- `test/helpers/*.js` — the shared YAML-diagnostic reader, the raw expression
  scanner, and the allowlists the above tests assert against.

## Delivery

This repo does not deliver via npm, a CLI, or any web/iOS/Android surface. It
delivers to every other `abofs/stonyx*` repository through GitHub Actions'
**reusable workflow** mechanism:

```yaml
jobs:
  test:
    uses: abofs/stonyx-workflows/.github/workflows/ci.yml@main
```

A consumer's `.github/workflows/*.yml` references `ci.yml`, `npm-publish.yml`,
`cascade.yml`, or `security-audit.yml` from this repo by `uses:` and a ref
(every current consumer pins `@main`, unpinned — see
[docs/release.md § No rehearsal path](release.md#no-rehearsal-path)). There is
no package to `pnpm add`, no binary to install, and no runtime dependency
graph beyond what GitHub Actions resolves at `uses:` time.

## Dependencies

`package.json` declares **zero** runtime dependencies and exactly one
devDependency: `typescript` (pinned `5.9.3`), used solely by
`scripts/check-doc-imports.mjs` to type-check the import probes it builds
from consumer docs. There is no other third-party code in this repo.

The real "dependency" surface is infrastructure, not npm packages, and it
splits into two trust layers:

- **GitHub Actions itself** is what resolves a `uses:` reference to a
  specific commit, runs each job on `ubuntu-latest`, and supplies the ambient
  `github.token` / OIDC identity used for ordinary (non-cascade) checkouts
  and for npm's trusted-publishing provenance. This repo's own `workflow_call`
  contracts (inputs, secrets, outputs) are the interface GitHub Actions
  enforces at call time — see [docs/release.md](release.md) for what is
  verified about that in the current YAML versus what is asserted but
  unverifiable from code (actual OIDC trust configuration, actual secret
  values).
- **The OIDC / npm trusted-publishing mechanism** (described in
  [docs/release.md § OIDC trusted publishing](release.md#oidc-trusted-publishing))
  is responsible for authenticating `pnpm publish` to npm with no stored npm
  token, scoped per-repo/per-package by npm's provenance attestation. The
  **`CASCADE_PAT`** org-level PAT is a separate, broader credential: it is
  what `cascade.yml` uses to call `repos.createDispatchEvent()` across every
  Stonyx repo, and what `npm-publish.yml` uses as the checkout/push token in
  cascade mode. Both are GitHub/npm infrastructure concerns outside this
  repo's code — this repo's scripts do not mint, rotate, or validate either
  credential's grant, only consume a token handed to them by the workflow.

What this repo's own code *does* control, and what is verified by its test
suite:

- **Version derivation** — `scripts/derive-version.mjs`, pure and offline,
  pinned by `test/derive-version-test.js` and `test/lift-equivalence-test.js`.
- **Doc-import resolution** — `scripts/check-doc-imports.mjs`, which decides
  whether a `stonyx`/`@stonyx/*` import shown in a consumer's docs actually
  resolves against that package's shipped `exports`.
- **Doc-registry package discovery** — `scripts/doc-registry-packages.mjs`,
  which decides which package names in a consumer's docs need to be resolved
  from a registry scratch install rather than from the consumer's own
  `node_modules`.
- **The expression-safety and credential-handling guarantees** inside the
  workflow YAML itself (input validation grammars, the `${{ }}` allowlist,
  `persist-credentials: false` on every checkout) — these are code in this
  repo's `.github/workflows/*.yml`, not GitHub Actions platform behavior, and
  are exercised by `test/injection-test.js`, `test/raw-sweep-test.js`, and
  `test/checkout-credentials-test.js`.
