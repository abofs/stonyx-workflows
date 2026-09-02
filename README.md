[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# Stonyx Workflows

Shared GitHub Actions workflows for Stonyx framework packages.

## Available Workflows

### `ci.yml`

Reusable workflow for running tests on pull requests.

**Usage:**

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
    branches: [dev, main]

concurrency:
  group: ci-${{ github.head_ref || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    uses: abofs/stonyx-workflows/.github/workflows/ci.yml@main
    # Optional: override defaults
    # with:
    #   node-version: '22'
    #   pnpm-version: '9'
```

**Inputs:**

| Input | Description | Default |
|-------|-------------|---------|
| `node-version` | Node.js version | `24.13.0` |
| `pnpm-version` | pnpm version | `9` |

---

### `npm-publish.yml`

Reusable workflow for publishing npm packages with alpha/beta/stable release stages and cascade support.

**Features:**
- **Alpha** (PR): Dynamic version calculation from npm, no commit to PR branch, no tag/release
- **Beta** (merge to main or cascade): Dynamic version calculation, commits to main, creates tag + GitHub release
- **Stable** (manual dispatch): Patch/minor/major bump, creates tag + GitHub release
- **Cascade mode**: When triggered via `cascade-source`, updates all `@stonyx/*` dependencies to latest from npm before publishing

**Note for consumers:** on the alpha and beta paths this workflow checks
`abofs/stonyx-workflows` out into `.stonyx-workflows/` in your workspace to
reach `scripts/derive-version.mjs`, and removes it again before publishing. The
checkout is pinned to the same commit your `uses:` line resolved to, so the ref
you pin governs the derivation logic as well as the workflow. No change to your
`publish.yml` is required. See
[`docs/release.md` § Workflow consumption](docs/release.md#workflow-consumption).

**Inputs:**

| Input | Description | Default |
|-------|-------------|---------|
| `version-type` | Version bump type. Must be exactly `patch`, `minor` or `major` when it is reached; **any other value, including the empty string, fails the job**. It is reached only on the final `else` of `Determine version bump type` -- that is, when `cascade-source` is empty, the event is neither `push` nor `pull_request`, and `custom-version` is empty | — |
| `custom-version` | Explicit version string. Must be a semver version (an optional leading `v` **is** accepted here) or an npm version keyword (`patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`, `from-git`) | — |
| `cascade-source` | Source package that triggered cascade (non-empty enables cascade mode) | `''` |
| `node-version` | Node.js version | `24.13.0` |
| `pnpm-version` | pnpm version | `9` |

**Validation and failure behaviour.** Every value **`npm-publish.yml`** takes
from a consumer -- the `package.json` `name` and `version`, each `@stonyx/*`
dependency key, and the inputs above -- is validated before it is used, and
reaches a shell or a `github-script` only as an environment variable, never as
program text (abofs/stonyx-workflows#32). The same is true of `cascade.yml`;
see [its section below](#cascadeyml). It is **not** yet true of
`security-audit.yml`, which still interpolates its `audit-level` input into a
shell command -- tracked as
[#34](https://github.com/abofs/stonyx-workflows/issues/34) and deliberately
untouched here.

*The grammar that is actually enforced*, identically at every one of the five
validation points:

```
name     /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i   and  1 <= length <= 214
```

In words: an optional `@scope/` prefix; the first character of the scope and of
the bare name must be alphanumeric; every remaining character must be
alphanumeric, `.`, `_` or `-`; 214 characters maximum. Note this is **not** a
synonym for "a legal npm package name" in either direction -- it is *stricter*
than npm, which tolerates `~`, `'`, `!`, `(`, `*` and `)` in legacy names, and
*looser*, because the `/i` flag accepts uppercase where npm rejects it for new
packages. No current consumer is affected by either divergence; a twelfth repo
being onboarded should be checked against the regex above and not against npm's
own rules.

Versions use two deliberately different grammars, and **the difference is the
leading `v`**:

```
package.json version          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
custom-version                /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/   (or a keyword)
cascade.yml published-version /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
```

A `package.json` `version` may **not** be `v`-prefixed, because npm does not
store one that way. The two consumer-supplied inputs *may* be, because they are
tag-shaped values a caller may reasonably pass as `v1.2.3`. A test pins all
eight copies of these regexes string-identical apart from that one `v?`.

**Six observable behaviour changes**, ordered by how often you will meet them:

1. **A registry lookup that fails for any reason other than a genuine `404`
   fails the job** -- in the alpha derivation, the beta derivation, *and* the
   cascade dependency update. `Calculate next alpha version` runs on every pull
   request and `Calculate next beta version` on every push to a non-`main`
   branch, so a transient npm outage now reds publish jobs across every
   consumer repo at once. Previously it fell through to the local
   `package.json` version and published a prerelease with the counter
   restarted at `.0`. A genuine `404` still means "not published yet" and keeps
   the existing first-publish behaviour.
2. **`cascade.yml` refuses a `published-version` that is not semver**, and a
   `package-name` that fails the name grammar, before dispatching anything.
   That is a change to a public `workflow_call` contract -- see
   [its section below](#cascadeyml).
3. **`npm view`'s stderr no longer reaches the job log on the success path.**
   The registry calls now capture stderr, which is how a `404` is told apart
   from a real failure; the consequence is that `npm WARN` and `npm notice`
   lines that used to appear in the publish log are discarded unless the call
   fails.
4. **A `package.json` `name`, `version`, or `@stonyx/*` dependency key that
   fails its grammar fails the job** rather than being passed through.
5. **A failed registry lookup during a cascade is no longer silently skipped**
   -- the dependency update reds instead of publishing against stale ranges.
6. **A `version-type` outside `patch|minor|major` fails the job**, including
   the empty string, rather than being written through to an output that
   matches no bump step and publishing the unbumped version. The empty case is
   reachable through this README's own child-repo template, which passes
   `version-type: ${{ github.event.inputs.version-type || '' }}`: a
   hand-crafted `repository_dispatch` with no `source_package` reaches that
   branch with `""`.

*The failure text*, so a red job can be grepped rather than guessed at:

```
::error::package.json name is not a valid npm package name: "..."
::error::package.json version is not a valid semver version: "..."
::error::PKG_NAME is not a valid npm package name: "..."
::error::dependency key in dependencies is not a valid npm package name: "..."
::error::custom-version is not a valid semver version or npm version keyword: "..."
::error::version-type must be one of patch, minor, major (got: ...)
::error::npm view <package> <field> failed: ...
```

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `CASCADE_PAT` | No | PAT with `repo` scope. Required when `cascade-source` is set (used for checkout token to push back to main) |

**Outputs:**

| Output | Description |
|--------|-------------|
| `published-version` | The version that was published (e.g., `0.2.3-beta.1`) |
| `package-name` | The name of the published package (e.g., `@stonyx/utils`) |
| `version-channel` | The release channel: `alpha`, `beta`, `stable`, `patch`, `minor`, `major`, or `custom`. `stable` is emitted on a push to `main`, and the child-repo template below gates its cascade job on it |

**Version Progression:**

```
PR pushes:     0.2.3-alpha.0 → 0.2.3-alpha.1 → 0.2.3-alpha.2
Merge to main: 0.2.3-beta.0
Another merge: 0.2.3-beta.1
Manual stable: 0.2.3
```

---

### `cascade.yml`

Reusable workflow that dispatches `repository_dispatch` events to downstream dependent repos after a successful publish. Reads `dependency-map.json` to determine which repos to notify.

**Inputs:**

| Input | Description |
|-------|-------------|
| `package-name` | Name of the package that was just published (e.g., `@stonyx/utils`). **Validated against the npm name grammar** -- see below |
| `published-version` | Version that was just published (e.g., `0.2.3-beta.1`). **Validated as a semver version**, with an optional leading `v` accepted -- see below |

**Two new hard failures (abofs/stonyx-workflows#32).** Both inputs are
validated at the top of the dispatch script, **before `dependency-map.json` is
indexed and before any `repository_dispatch` is sent**. A value that fails
throws, and the cascade job goes red having dispatched nothing:

```
Refusing to cascade: "..." is not a valid npm package name
Refusing to cascade: "..." is not a valid semver version
```

`package-name` must match the same grammar and the same 214-character bound
that [`npm-publish.yml` documents above](#npm-publishyml). `published-version`
must be `MAJOR.MINOR.PATCH` with an optional `-prerelease`, an optional
`+build`, and an optional leading `v`.

This is a change to a public `workflow_call` contract. It is stricter than the
publish path for a reason: this step runs under the **org-level `CASCADE_PAT`**
rather than the repo-bound OIDC identity, so a value reaching program text here
is an org-wide credential rather than a repo-bound one. When `cascade.yml` is
driven from `npm-publish.yml`'s outputs -- the wiring the child-repo template
below uses -- both values have already passed the equivalent checks, so no
existing caller is affected. A caller supplying its own values must uphold the
grammars.

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `CASCADE_PAT` | Yes | PAT with `repo` scope for cross-repo `repository_dispatch` API calls |

---

### `security-audit.yml`

Reusable workflow that runs `pnpm audit` against the calling repo. Advisory
only -- the audit step is `continue-on-error: true`, so it annotates but never
fails the job.

**Inputs:**

| Input | Description | Default |
|-------|-------------|---------|
| `audit-level` | Minimum severity level to report | `moderate` |
| `node-version` | Node.js version | `24.13.0` |
| `pnpm-version` | pnpm version | `9` |

> **Known open defect.** `audit-level` is interpolated directly into the audit
> step's shell command, so it is the one remaining place in this repo where a
> `workflow_call` input becomes shell source -- the defect class
> [#32](https://github.com/abofs/stonyx-workflows/issues/32) closed in
> `npm-publish.yml` and `cascade.yml`. It is tracked as
> [#34](https://github.com/abofs/stonyx-workflows/issues/34) and is **not**
> fixed by #32. `test/injection-test.js` carries it as a single named
> allowlist entry citing that issue, so closing #34 has to remove the entry.

---

### `self-ci.yml`

Not a reusable workflow. Runs this repo's own test suite on every pull request
and on every merge to `main`, so changes to the workflows here are gated by a
check run in this repo rather than only by a downstream consumer publishing a
real version.

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

`push` is scoped to `main` -- the same shape this README teaches consumers
above. Left unscoped it would fire alongside `pull_request` on every branch
push, producing two identical check runs for one event.

Runs `pnpm install --frozen-lockfile` then `pnpm test` on Node `24.13.0`.

---

## Development

This repo has an executable surface: a private root `package.json`, a test
suite, and one extracted script. There are no dependencies -- tests use Node
core modules only (`node:test`, `node:assert`, and for the executed workflow
cases `node:child_process`, `node:fs`, `node:module`, `node:os`, `node:path`),
and `pnpm test` runs with no `node_modules` present.

```bash
pnpm install --frozen-lockfile
pnpm test
```

### `scripts/derive-version.mjs`

Exports `deriveVersion({ channel, latestStable, allVersions })`, the prerelease
version arithmetic used by the `Calculate next alpha version` and `Calculate
next beta version` steps in `npm-publish.yml`. Registry I/O stays in the
workflow and is passed in as arguments, so the function is pure and testable
offline.

`npm-publish.yml` runs inside the *consumer's* checkout, so it checks this repo
out at `.stonyx-workflows` to reach the script -- a variation on the pattern
`cascade.yml` uses to read `dependency-map.json` -- and removes that directory
again before the publish steps. That cleanup is defence-in-depth rather than
the only barrier: `npm pack` does pack a dot-prefixed directory at the package
root, but all **ten** current consumers declare a `files` allowlist that
excludes it, so none of them would have packed it. The step is what keeps that
true for a consumer that later drops the allowlist.

Ten is the measured number, as of 2026-09-02: every `abofs/stonyx*` repo with a
`.github/workflows/publish.yml` that references a workflow from here --
`stonyx`, `stonyx-logs`, `stonyx-utils`, `stonyx-events`, `stonyx-cron`,
`stonyx-sockets`, `stonyx-rest-server`, `stonyx-oauth`, `stonyx-orm` and
`stonyx-discord`, which is exactly the ten packages `dependency-map.json`
lists. `stonyx-workflows` and `stonyx-dashboard` have no `publish.yml`. Earlier
counts of "nine" and "eleven" in this repo and in its issues are both wrong.

That checkout is pinned to `${{ job.workflow_sha }}`: **the script is always
resolved from the same commit as the workflow that imports it.** A consumer
calling `npm-publish.yml@main` gets `main`'s script; one pinned to a tag or a
SHA gets that commit's script. Without the pin the workflow ref and the script
ref resolve independently, so a merge to this repo landing mid-job would run one
commit's workflow against another commit's derivation logic, against an
irreversible publish. `job.workflow_sha` is populated for any job defined in a
reusable workflow; the preceding `Resolve stonyx-workflows ref` step fails the
job if it is ever empty rather than letting `actions/checkout` fall back to the
default branch.

### Tests

| File | Covers |
|------|--------|
| `test/derive-version-test.js` | Characterization of `deriveVersion` against a committed, read-only capture of the `@stonyx/oauth` registry state (`test/fixtures/oauth-registry-state.json`) |
| `test/workflows-test.js` | That `npm-publish.yml` calls the script and retains no inline version arithmetic, and that `self-ci.yml` retains both a push and a pull_request trigger |
| `test/publish-glue-test.js` | Executes each derivation step's real `run:` body offline against a stubbed `npm`, and pins the checkout step's `ref:` and `if:` |
| `test/lift-equivalence-test.js` | Differential proof that `deriveVersion` matches the `main@692d122` heredocs it was lifted from, across 864 input pairs |
| `test/injection-test.js` | That no consumer-controlled string reaches program text or a shell string in `npm-publish.yml` or `cascade.yml`. Executes the real `run:` bodies against a stubbed `npm`/`pnpm`/`git` and the real `cascade.yml` `script:` body against a stubbed `github` client; pins the npm-name and semver grammars and their duplicated copies; and sweeps **every** file in `.github/workflows/` for a GitHub Actions expression inside a `run:` or `script:` body |
| `test/helpers/workflow-yaml.js` | Minimal reader for the workflow YAML shapes the tests assert on: a step's `run:` body, a step's `env:` mapping, a step's `with: script:` body, and a workflow's trigger keys |

Test files are named `*-test.js`, matching the convention every `@stonyx/*`
sibling repo uses. `pnpm test` runs `scripts/run-tests.mjs` rather than
`node --test <glob>` directly, because `node --test` **exits 0 and reports
`tests 0` when its glob matches nothing** -- a rename or a pattern edit would
otherwise leave `Self CI` green while running no tests. The runner resolves the
glob, fails loudly if it matches fewer than two files, and passes that same
resolved list to `node --test`, so the list that is checked is the list that is
run.

`test/derive-version-test.js` pins **today's** derivation output, defects
included. Changing it is how [#23](https://github.com/abofs/stonyx-workflows/issues/23)
and [#24](https://github.com/abofs/stonyx-workflows/issues/24) become visible
as diffs; do not "improve" the derivation without updating those assertions
deliberately.

`test/injection-test.js` is the file that fails if someone reintroduces an
interpolation. Its rule is one sentence -- *no consumer-controlled string ever
becomes program text or a shell-string fragment* -- and its sweep is what keeps
that rule true for workflow files nobody remembered to think about. A new
`${{ ... }}` inside any `run:` or `script:` body reds it, deliberately, even
when the value looks harmless; the way past it is a named allowlist entry that
says what the expression is and why, not a widened pattern.

## Dependency Map

`dependency-map.json` at the repo root defines the static dependency tree between Stonyx packages. Each key is a package name, and `dependents` lists the downstream repos that should be notified when that package publishes.

**Format:**

```json
{
  "@stonyx/utils": {
    "dependents": [
      { "repo": "abofs/stonyx", "dep_name": "@stonyx/utils", "section": "devDependencies" }
    ]
  }
}
```

To add a new package or dependency relationship, edit `dependency-map.json` and submit a PR.

---

## Child Repo Setup

Each child repo's `.github/workflows/publish.yml` should follow this template:

```yaml
name: Publish to NPM

on:
  workflow_dispatch:
    inputs:
      version-type:
        description: 'Version type'
        required: true
        type: choice
        options:
          - patch
          - minor
          - major
      custom-version:
        description: 'Custom version (optional, overrides version-type)'
        required: false
        type: string
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
  push:
    branches: [main]
  repository_dispatch:
    types: [cascade-publish]

concurrency:
  group: ${{ github.event_name == 'repository_dispatch' && 'cascade-update' || format('publish-{0}', github.head_ref || github.ref) }}
  cancel-in-progress: true

permissions:
  contents: write
  id-token: write
  pull-requests: write

jobs:
  publish:
    if: github.event_name != 'push' || !contains(github.event.head_commit.message, '[skip ci]')
    uses: abofs/stonyx-workflows/.github/workflows/npm-publish.yml@main
    with:
      version-type: ${{ github.event.inputs.version-type || '' }}
      custom-version: ${{ github.event.inputs.custom-version || '' }}
      cascade-source: ${{ github.event.client_payload.source_package || '' }}
    secrets: inherit

  cascade:
    needs: publish
    if: needs.publish.outputs.version-channel == 'beta' || needs.publish.outputs.version-channel == 'stable'
    uses: abofs/stonyx-workflows/.github/workflows/cascade.yml@main
    with:
      package-name: ${{ needs.publish.outputs.package-name }}
      published-version: ${{ needs.publish.outputs.published-version }}
    secrets:
      CASCADE_PAT: ${{ secrets.CASCADE_PAT }}
```

**Key differences from a non-cascade setup:**
1. `repository_dispatch: types: [cascade-publish]` trigger
2. `concurrency` block with dynamic group (fixed `cascade-update` for dispatches)
3. `if` guard on `publish` job to skip `[skip ci]` commits
4. `cascade-source` input passed to `npm-publish.yml`
5. `cascade` job that calls `cascade.yml` after successful publish

---

## CASCADE_PAT Setup

Create a GitHub PAT (or fine-grained token) with `repo` scope and store it as an **org-level secret** named `CASCADE_PAT`. Grant access to all Stonyx repos.

This token is used for:
1. **`cascade.yml`** — `repos.createDispatchEvent()` API calls to trigger downstream repos
2. **`npm-publish.yml`** — checkout token during cascade mode, enabling `git push` back to `main`

Child repos pass it via `secrets: inherit` (org secrets are automatically available).

---

## Prerequisites

- npm Trusted Publishing (OIDC) configured on npmjs.com
- `pnpm-lock.yaml` present in the package repo
- `pnpm test` script defined in package.json
- All `file:../` references in `package.json` migrated to real semver ranges (use `pnpm link` for local dev)
- `CASCADE_PAT` org-level secret configured (required for cascade functionality)
