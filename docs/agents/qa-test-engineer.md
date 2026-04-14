# SME Template: QA Test Engineer — Stonyx Workflows

> **Inherits from:** `beatrix-shared/docs/framework/templates/agents/qa-test-engineer.md`
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

- Four reusable workflows consumed via `workflow_call`: `ci.yml` (test runner), `npm-publish.yml` (versioning + publishing), `cascade.yml` (cross-repo dispatch), `security-audit.yml` (pnpm audit)
- `npm-publish.yml` implements a three-channel version strategy: alpha (PR), beta (merge to main or cascade trigger), stable (manual dispatch)
- Version calculation is dynamic: queries npm registry for existing versions and increments the prerelease counter (e.g., `0.2.3-alpha.0`, `0.2.3-alpha.1`)
- Cascade system: `cascade.yml` reads `dependency-map.json`, deduplicates repos, and fires `repository_dispatch` events with `cascade-publish` type to downstream dependents
- During cascade mode, `npm-publish.yml` updates all `@stonyx/*` dependencies to latest from npm (checking both beta and latest dist-tags) before building and publishing
- Concurrency groups use fixed `cascade-update` key for dispatch events to prevent race conditions, dynamic keys for regular publish flows
- `[skip ci]` convention in commit messages prevents infinite loops during automated version bump commits

## Live Knowledge

- This repo has no `package.json` or test suite of its own -- quality validation is done by verifying workflow behavior in consumer repos
- Testing changes to these workflows requires pushing to a branch and triggering the workflow from a consumer repo (e.g., stonyx-logs, stonyx-utils) pointed at the branch ref
- `dependency-map.json` is the single source of truth for the cascade graph: currently maps 10 packages with `@stonyx/utils` having the most dependents (8 repos)
- The `CASCADE_PAT` secret must have `repo` scope and is stored as an org-level secret; it is used both for `repository_dispatch` API calls and for pushing version bump commits back to main during cascade
- Alpha publishes comment on the PR with install instructions via `actions/github-script`; beta and stable create Git tags and GitHub Releases
- The `security-audit.yml` workflow runs `pnpm audit` with configurable severity level and `continue-on-error: true` so it reports but does not block
- Child repos wire into these workflows with a standard `publish.yml` template that handles `workflow_dispatch`, `pull_request`, `push`, and `repository_dispatch` triggers
