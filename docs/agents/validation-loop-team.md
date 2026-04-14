# SME Template: Validation Loop Team — Stonyx Workflows

> **Inherits from:** `beatrix-shared/docs/framework/templates/agents/validation-loop-team.md`
> Load the base template first, then layer this project-specific context on top.

## Project Context

**Repo:** `abofs/stonyx-workflows`
**Framework:** Shared GitHub Actions reusable workflows for the Stonyx ecosystem
**Domain:** CI/CD automation including testing, npm publishing with alpha/beta/stable channels, dependency cascade dispatching, and security auditing

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Platform | GitHub Actions (reusable `workflow_call` workflows) |
| Runtime | Node.js 24.x (within workflow steps) |
| Package Manager | pnpm 9 (within workflow steps) |
| Scripting | Inline JavaScript via `actions/github-script@v7` and `node -e` |
| Registry | npm (OIDC trusted publishing) |
| Configuration | `dependency-map.json` (static dependency graph) |
| Release | `softprops/action-gh-release@v2` for GitHub Releases |

## Architecture Patterns

- Workflow-as-library pattern: all workflows use `workflow_call` trigger so consumer repos reference them as `uses: abofs/stonyx-workflows/.github/workflows/<name>.yml@main`
- `npm-publish.yml` is the most complex workflow with conditional steps gated on version channel (alpha/beta/stable/custom) and cascade mode
- Version resolution logic: inline Node.js scripts query npm registry via `npm view` CLI, parse all existing versions, compute next prerelease number
- Cascade dependency update: during cascade mode, iterates `dependencies` and `devDependencies` for `@stonyx/*` packages, compares beta vs latest dist-tags, picks the higher semver
- `cascade.yml` deduplicates downstream repos from `dependency-map.json` before dispatching (a repo may appear multiple times if it depends on the package in multiple sections)
- Permissions are scoped per workflow: `ci.yml` and `security-audit.yml` need only `contents: read`, while `npm-publish.yml` requires `contents: write`, `id-token: write`, and `pull-requests: write`
- Git operations in `npm-publish.yml` use `git pull --rebase` before push to handle concurrent commits on main

## Live Knowledge

- Changes to these workflows affect every Stonyx package repo -- validate workflow YAML syntax and step ordering carefully before merging
- The version calculation scripts handle edge cases: single-version packages where npm returns a string instead of an array, and first-ever prerelease where no existing versions match the prefix
- `cascade-source` input being non-empty is the sole signal for cascade mode; it toggles checkout token usage (`CASCADE_PAT` vs `github.token`), lockfile handling (`--no-frozen-lockfile` vs `--frozen-lockfile`), and dependency update steps
- Beta version bump commits use `[skip ci]` in the message to prevent re-triggering the publish workflow in an infinite loop
- The `security-audit.yml` workflow uses `continue-on-error: true` to make audit results advisory rather than blocking
- Workflow inputs have sensible defaults (Node 24.13.0, pnpm 9) but can be overridden per-consumer for version pinning flexibility
- The `dependency-map.json` must be manually updated when new Stonyx packages are added or dependency relationships change -- there is no auto-detection
