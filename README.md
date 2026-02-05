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

Reusable workflow for publishing npm packages with alpha/beta/stable release stages.

**Features:**
- **Alpha** (PR): Dynamic version calculation from npm, no commit to PR branch
- **Beta** (merge to main): Dynamic version calculation, commits to main
- **Stable** (manual dispatch): Patch/minor/major bump, creates tag + GitHub release

**Usage:**

```yaml
# .github/workflows/publish.yml
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
    branches: [main, dev]
  push:
    branches: [main]

permissions:
  contents: write
  id-token: write
  pull-requests: write

jobs:
  publish:
    uses: abofs/stonyx-workflows/.github/workflows/npm-publish.yml@main
    with:
      version-type: ${{ github.event.inputs.version-type }}
      custom-version: ${{ github.event.inputs.custom-version }}
    secrets: inherit
```

**Inputs:**

| Input | Description | Default |
|-------|-------------|---------|
| `version-type` | Version bump type (patch/minor/major) | — |
| `custom-version` | Explicit version string | — |
| `node-version` | Node.js version | `24.13.0` |
| `pnpm-version` | pnpm version | `9` |

**Version Progression:**

```
PR pushes:     0.2.3-alpha.0 → 0.2.3-alpha.1 → 0.2.3-alpha.2
Merge to main: 0.2.3-beta.0
Another merge: 0.2.3-beta.1
Manual stable: 0.2.3
```

---

## Requirements

- npm Trusted Publishing (OIDC) configured on npmjs.com
- `pnpm-lock.yaml` present in the package repo
- `pnpm test` script defined in package.json
