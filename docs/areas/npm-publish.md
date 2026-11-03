# Area: the publish workflow (`npm-publish.yml`)

Verified against `.github/workflows/npm-publish.yml` as committed on `dev`
in this session (838 lines), cross-checked against `scripts/derive-version.mjs`
and the `pnpm test` run in [docs/index.md](../index.md#build-run-test) (472/472
passing, including `test/publish-glue-test.js`, `test/lift-equivalence-test.js`,
`test/injection-test.js`, `test/checkout-credentials-test.js` and
`test/tarball-guard-test.js`, all of which execute real bodies from this file
against stubs rather than merely parsing it).

## Inputs, secrets, outputs

- **Inputs:** `version-type` (`patch`/`minor`/`major`, dispatch-only and
  dispatch is frozen org-wide today), `custom-version` (a semver, optionally
  `v`-prefixed, or an npm version keyword), `cascade-source` (non-empty
  enables cascade mode), `node-version` (default `24.13.0`), `pnpm-version`
  (default `9`).
- **Secrets:** `CASCADE_PAT`, not required unless `cascade-source` is set.
- **Outputs:** `published-version`, `package-name`, `version-channel`
  (`alpha`/`beta`/`stable`/`patch`/`minor`/`major`/`custom`).

## Channel selection

The `Determine version bump type` step's `if`/`elif` chain, read directly
from the file (lines 218–256): a non-empty `cascade-source` → `beta`; else a
`pull_request` event → `alpha`; else a `push` to `refs/heads/main` → `stable`;
else any other `push` → `beta`; else fall through to `version-type`, which
must be exactly `patch`, `minor`, or `major` or the job fails with
`::error::version-type must be one of patch, minor, major (got: ...)`. This
matches what `docs/release.md`'s pipeline table and "Determine version bump
type" paragraph already claim — verified line-for-line against the current
file, not just read as prose.

## Version derivation (alpha/beta only)

On the alpha and beta paths, the workflow checks this repo out to
`.stonyx-workflows/` at `${{ job.workflow_sha }}` (same pin mechanism as
`ci.yml`), installs nothing beyond what's needed to `import()` the script,
calls `scripts/derive-version.mjs`'s `deriveVersion({ channel, latestStable,
allVersions })` with registry data fetched by `npm view` in the surrounding
shell, and removes `.stonyx-workflows/` again (`Remove stonyx-workflows
checkout`, `if: always()`) before any publish step runs. A registry lookup
that fails for any reason other than a genuine `404` fails the job (no
silent fallback to the stale local version) — read directly in the `npmView`
helper inlined in both `Calculate next alpha version` and `Calculate next
beta version`.

## The release-artifact guard

`Pack and guard the release artifact` packs the tree once to
`$RUNNER_TEMP/stonyx-release.tgz`, runs `pnpm run prepublishOnly` explicitly
first (because `pnpm pack` does not run it and a tarball publish runs no
lifecycle scripts at all), inspects the resulting tarball's entry list with
`tar -tzf`, and hard-fails if any entry matches
`^package/(.*/)?\.git(/|$)` — with no bypass input and no per-repo opt-out,
confirmed by reading the step body directly. The three `Publish to NPM
(alpha|beta|stable)` steps all `pnpm publish` that same tarball path, so the
bytes guarded and the bytes uploaded are the same object.

## Cascade-mode dependency bump

When `cascade-source` is non-empty, `Update all Stonyx dependencies to
latest` rewrites every `@stonyx/*` entry in `dependencies`/`devDependencies`
to the latest npm-published version (prerelease-aware) before `Install
dependencies` runs with `--no-frozen-lockfile` instead of
`--frozen-lockfile`. Every dependency key is validated against the same npm
name grammar used elsewhere in this file before it is used.

## Credential handling, verified against this file

- The main checkout's `token:` is `(inputs.cascade-source != '' &&
  secrets.CASCADE_PAT) || github.token` with `persist-credentials: false`
  — confirmed at lines 56–82.
- The two commit/push steps (`Commit version bump and create tag
  (beta|stable)`) receive `GIT_REMOTE_TOKEN` via a step-level `env:`, using
  the *same* expression as the checkout, and hand it to `git` through
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` set per
  invocation on the `pull`/`push` calls only — but `GIT_REMOTE_TOKEN` itself,
  the raw PAT, sits in the step's environment for all five `git`
  invocations in the step (`add`, `commit`, `tag` included), not just the
  two that use the encoded form. This matches `docs/release.md`'s "Git
  credentials in the publish job" section claim-for-claim against the
  current file — see [docs/release.md](../release.md) for the full
  discussion and what remains unverifiable (the actual token's scope as
  configured in GitHub/npm settings, which is infrastructure, not code).

## What the test suite pins here

`test/injection-test.js` and `test/raw-sweep-test.js` run a byte-level scan
for every `${{ }}` in this file against a named allowlist entry, and execute
the real `run:` bodies against stubbed `npm`/`pnpm`/`git` to assert no
consumer-controlled string (`cascade-source`, `custom-version`,
`version-type`, a dependency key, `github.ref_name`) ever reaches program
text or a shell-string fragment. `test/checkout-credentials-test.js` asserts
every checkout taking a non-ambient token sets `persist-credentials: false`,
and pins `GIT_REMOTE_TOKEN === 'SENTINEL-PAT'` as present in the environment
of all five `git` calls in both push steps. `test/tarball-guard-test.js`
exercises the `.git`-path denylist regex and the guard's own anti-vacuity
checks (entry count, `package/package.json` presence, tar exit status).
