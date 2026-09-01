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

**Inputs:**

| Input | Description | Default |
|-------|-------------|---------|
| `version-type` | Version bump type (patch/minor/major) | — |
| `custom-version` | Explicit version string | — |
| `cascade-source` | Source package that triggered cascade (non-empty enables cascade mode) | `''` |
| `node-version` | Node.js version | `24.13.0` |
| `pnpm-version` | pnpm version | `9` |

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `CASCADE_PAT` | No | PAT with `repo` scope. Required when `cascade-source` is set (used for checkout token to push back to main) |

**Outputs:**

| Output | Description |
|--------|-------------|
| `published-version` | The version that was published (e.g., `0.2.3-beta.1`) |
| `package-name` | The name of the published package (e.g., `@stonyx/utils`) |
| `version-channel` | The release channel: `alpha`, `beta`, `patch`, `minor`, `major`, or `custom` |

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
| `package-name` | Name of the package that was just published (e.g., `@stonyx/utils`) |
| `published-version` | Version that was just published (e.g., `0.2.3-beta.1`) |

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `CASCADE_PAT` | Yes | PAT with `repo` scope for cross-repo `repository_dispatch` API calls |

---

### `self-ci.yml`

Not a reusable workflow. Runs this repo's own test suite on every push and pull
request, so changes to the workflows here are gated by a check run in this repo
rather than only by a downstream consumer publishing a real version.

```yaml
on: [push, pull_request]
```

Runs `pnpm install --frozen-lockfile` then `pnpm test` on Node `24.13.0`.

---

## Development

This repo has an executable surface: a private root `package.json`, a test
suite, and one extracted script. There are no dependencies -- tests use
`node:test` and `node:assert` only.

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
again before the publish steps, so it cannot be packed into a consumer's npm
tarball by a package that has no `files` allowlist.

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
| `test/workflows-test.js` | That `npm-publish.yml` calls the script and retains no inline version arithmetic, and that `self-ci.yml` triggers on push and pull request |
| `test/helpers/workflow-yaml.js` | Minimal reader for the two workflow YAML shapes the tests assert on |

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
