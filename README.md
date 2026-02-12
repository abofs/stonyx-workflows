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
