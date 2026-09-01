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
| Scripting | Inline JavaScript via `actions/github-script@v7` and `node -e`; extracted ESM modules under `scripts/` |
| Registry | npm (OIDC trusted publishing) |
| Configuration | `dependency-map.json` (static dependency graph) |
| Release | `softprops/action-gh-release@v2` for GitHub Releases |

## Architecture Patterns

- Four reusable workflows consumed via `workflow_call`: `ci.yml` (test runner), `npm-publish.yml` (versioning + publishing), `cascade.yml` (cross-repo dispatch), `security-audit.yml` (pnpm audit)
- Plus `self-ci.yml`, which is **not** reusable: it triggers on `push` to `main` and on `pull_request`, so this repo's own changes are gated by a check run here without running twice per event (see #22)
- `npm-publish.yml` implements a three-channel version strategy: alpha (PR), beta (merge to main or cascade trigger), stable (manual dispatch)
- Version calculation is dynamic: queries npm registry for existing versions and increments the prerelease counter (e.g., `0.2.3-alpha.0`, `0.2.3-alpha.1`)
- Cascade system: `cascade.yml` reads `dependency-map.json`, deduplicates repos, and fires `repository_dispatch` events with `cascade-publish` type to downstream dependents
- During cascade mode, `npm-publish.yml` updates all `@stonyx/*` dependencies to latest from npm (checking both beta and latest dist-tags) before building and publishing
- Concurrency groups use fixed `cascade-update` key for dispatch events to prevent race conditions, dynamic keys for regular publish flows
- `[skip ci]` convention in commit messages prevents infinite loops during automated version bump commits

## Live Knowledge

- This repo has an executable surface (added by #22): a private root `package.json`, a zero-dependency `node:test` suite under `test/`, and `scripts/derive-version.mjs`. Run it with `pnpm install --frozen-lockfile && pnpm test`
- Most changes can now be validated locally: the suite reads the workflow YAML from disk, executes the derivation steps' real `run:` bodies against a stubbed `npm`, and proves the derivation against a committed registry fixture -- no consumer repo and no network involved
- What still needs a consumer repo: anything depending on the runner's own context (OIDC publishing, `repository_dispatch` delivery, cascade end-to-end). Those are not covered by the local suite
- `pnpm test` runs `scripts/run-tests.mjs`, not `node --test` directly, because `node --test` exits 0 reporting `tests 0` when its glob matches nothing. The runner fails loudly instead. Test files are named `*-test.js`
- `dependency-map.json` is the single source of truth for the cascade graph: currently maps 10 packages with `@stonyx/utils` having the most dependents (8 repos)
- The `CASCADE_PAT` secret must have `repo` scope and is stored as an org-level secret; it is used both for `repository_dispatch` API calls and for pushing version bump commits back to main during cascade
- Alpha publishes comment on the PR with install instructions via `actions/github-script`; beta and stable create Git tags and GitHub Releases
- The `security-audit.yml` workflow runs `pnpm audit` with configurable severity level and `continue-on-error: true` so it reports but does not block
- Child repos wire into these workflows with a standard `publish.yml` template that handles `workflow_dispatch`, `pull_request`, `push`, and `repository_dispatch` triggers
