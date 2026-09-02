# Stonyx Workflows Documentation

Shared GitHub Actions workflows for Stonyx framework packages. Provides reusable CI, npm publish, and cascade workflows.

## Contents

- [README](../README.md) -- workflow usage, inputs/outputs, child repo setup, and CASCADE_PAT configuration
- [Release Instructions](release.md) -- the release pipeline, the new red-publish failure modes, the OIDC/`CASCADE_PAT` threat model, and why there is no rehearsal path
- [Development](../README.md#development) -- test suite, `scripts/derive-version.mjs`, and `self-ci.yml`
- [Tests](../README.md#tests) -- what each file in `test/` covers
- [The guarantee, and everything that is not one](../README.md#the-guarantee-and-everything-that-is-not-one) -- **read this before adding a `${{ }}` to any workflow.** The one guarantee this suite makes, the diagnostics that are not one, and the three rules that bind a workflow author
- Agent briefs: [QA test engineer](agents/qa-test-engineer.md), [validation loop team](agents/validation-loop-team.md)
