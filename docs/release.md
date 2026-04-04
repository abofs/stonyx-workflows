# Release Instructions

This is a shared workflows repo, not a publishable npm package. There is no npm release process.

Releases are managed via the workflows themselves:
- **CI workflow updates**: merge PRs to `main`; all consuming repos reference `@main` and pick up changes automatically.
- **Breaking changes**: coordinate with downstream repos before merging. Consider tagging a release so consumers can pin to a specific version if needed.
- **Workflow dispatch**: individual workflows (e.g., `npm-publish.yml`) are triggered via `workflow_dispatch` in the consuming repos, not in this repo directly.
