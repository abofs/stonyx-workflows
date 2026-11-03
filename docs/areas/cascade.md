# Area: the cascade workflow (`cascade.yml`)

Verified against `.github/workflows/cascade.yml` as committed on `dev` in
this session (97 lines, one job, two steps), and against the "cascade" test
coverage inside `test/injection-test.js` / `test/raw-sweep-test.js`
(executing the real `script:` body against a stubbed `github` client) from
the `pnpm test` run in [docs/index.md](../index.md#build-run-test).

## What it is

A `workflow_call` reusable workflow, called by a child repo's `cascade` job
(see the README's "Child Repo Setup" template) after a successful publish:

```yaml
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

Inputs: `package-name` (required), `published-version` (required). Secret:
`CASCADE_PAT` (required).

## Mechanism

1. **Checkout stonyx-workflows (for dependency map)** — checks this repo out
   at `ref: main` using `token: ${{ secrets.CASCADE_PAT }}`, with
   `persist-credentials: false`. The job runs no consumer code, so the only
   reason this step is lower-risk than `npm-publish.yml`'s cascade checkout
   is that nothing in this job reads git credentials from disk — the next
   step is handed the PAT explicitly instead.
2. **Dispatch to downstream dependents** — an `actions/github-script@v7`
   step. `package-name` and `published-version` are read from `process.env`
   (set via the step's `env:`), never interpolated as a `${{ }}` inside the
   script body — a comment in the file states this is because the script
   runs under the org-wide `CASCADE_PAT`, so an interpolation here would put
   an org-wide credential at risk rather than a repo-bound one. Both values
   are validated — `package-name` against the same npm name grammar used in
   `npm-publish.yml` (`/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i`,
   max 214 chars), `published-version` against a semver grammar with an
   optional leading `v` — **before** `dependency-map.json` is read or any
   dispatch happens. A failing value throws
   `Refusing to cascade: "..." is not a valid npm package name` or the
   semver equivalent, and the job goes red having dispatched nothing.
3. `dependency-map.json` (this repo's root) is indexed by `package-name`;
   its `dependents` are deduplicated by `repo` (so a repo listed under both
   `dependencies` and `devDependencies` gets exactly one dispatch); each
   unique repo receives a `repository_dispatch` with `event_type:
   'cascade-publish'` and `client_payload: { source_package, source_version
   }` via `github.rest.repos.createDispatchEvent()`.

## Known gap — issue #60

Open issue
[abofs/stonyx-workflows#60](https://github.com/abofs/stonyx-workflows/issues/60)
(already refined, priority-high, not addressed by this documentation pass)
tracks two related symptoms in this area, stated here as fact, not analysis:

1. **The cascade does not dispatch from alpha publishes.** This is a direct
   consequence of the gating condition shown above
   (`version-channel == 'beta' || version-channel == 'stable'`) in every
   child repo's `cascade` job — an alpha publish's `version-channel` output
   is `alpha`, so the `cascade` job's `if:` never evaluates true for it, and
   `cascade.yml` is never invoked at all on that path.
2. **No release fires when a cascade run changes no dependency.** Stated in
   the issue as a known gap; this document does not attempt to characterize
   the mechanism further, consistent with this documentation pass's scope
   (no feature work or bug fixing).

Neither symptom is fixed by anything in this documentation change.

## Dependency map

`dependency-map.json` is hand-maintained — nothing in this repo derives it
from any consumer's `package.json`, so a new package or dependency edge
requires a manual PR here. Format, confirmed against the actual file:

```json
{
  "@stonyx/utils": {
    "dependents": [
      { "repo": "abofs/stonyx", "dep_name": "@stonyx/utils", "section": "devDependencies" }
    ]
  }
}
```

The current file lists ten package keys (`@stonyx/logs`, `@stonyx/utils`,
`stonyx`, `@stonyx/events`, `@stonyx/cron`, `@stonyx/rest-server`,
`@stonyx/oauth`, `@stonyx/orm`, `@stonyx/discord`, `@stonyx/sockets`); four of
them (`@stonyx/oauth`, `@stonyx/orm`, `@stonyx/discord`, `@stonyx/sockets`)
currently declare an empty `dependents` array — a publish of any of those
four dispatches to nobody today, by data in this file, not by a workflow
defect.

## What the test suite pins here

The injection/credential-safety suite (`test/injection-test.js`,
`test/raw-sweep-test.js`) scans this file byte-for-byte for every `${{ }}`
and asserts each is in a named allowlist entry, and separately executes the
real `script:` body against a stubbed `github` client to assert the name/
semver validators actually throw on bad input before any dispatch call is
made, and that a well-formed call dispatches exactly the deduplicated repo
set. `test/checkout-credentials-test.js` asserts this file's checkout also
sets `persist-credentials: false`.
