# Area: the CI workflow (`ci.yml`)

Verified against `.github/workflows/ci.yml` as committed on `dev` in this
session, and against `test/workflows-test.js` / the "`ci.yml` registry step,
executed with a stub npm" suite in `test/doc-imports-test.js`'s neighbourhood,
which all passed in the `pnpm test` run documented in
[docs/index.md](../index.md#build-run-test).

## What it is

A `workflow_call` reusable workflow with one job (`test`), consumed by a
child repo's own CI or publish workflow via:

```yaml
jobs:
  test:
    uses: abofs/stonyx-workflows/.github/workflows/ci.yml@main
    # with:
    #   node-version: '22'
    #   pnpm-version: '9'
```

Inputs: `node-version` (default `24.13.0`), `pnpm-version` (default `9`).
No secrets are declared, and the job holds none at runtime: its only
`GITHUB_TOKEN` use is the default `token:` GitHub Actions supplies to
`actions/checkout` and `actions/setup-node`, and every checkout in this
workflow sets `persist-credentials: false`.

## Steps, in order

1. **Checkout code** — the consumer's own repo, `persist-credentials: false`.
2. **Setup pnpm** / **Set up Node.js** — pinned to the `pnpm-version` /
   `node-version` inputs.
3. **Install dependencies** — `pnpm install --frozen-lockfile` in the
   consumer's tree.
4. **Run tests** — `pnpm test` in the consumer's tree.
5. **Build** — `pnpm run --if-present build`. Comment in the file notes the
   repo's own package resolves by self-reference to `dist/`, and not every
   consumer's `pnpm test` builds (`stonyx-events`, `stonyx-logs` are named as
   examples that don't).
6. **Resolve stonyx-workflows ref** — reads `${{ job.workflow_sha }}` (the
   commit the consumer's `uses:` line actually resolved to) into a step
   output, and fails the job with `::error::job.workflow_sha is empty...` if
   it is empty, rather than falling back to a moving ref.
7. **Checkout stonyx-workflows (for docs-import check)** — checks *this* repo
   out to `.stonyx-workflows/` inside the consumer's workspace, at the SHA
   from step 6, `persist-credentials: false`.
8. **Install docs-import check tooling** — `pnpm install --frozen-lockfile
   --ignore-scripts --ignore-workspace` inside `.stonyx-workflows/`, which is
   how this repo's own pinned `typescript` gets installed next to the
   script without touching the consumer's own `node_modules`.
9. **Install stonyx packages the docs import but the repo does not declare**
   — runs `node .stonyx-workflows/scripts/doc-registry-packages.mjs --repo .`
   to get the list of undeclared `stonyx`/`@stonyx/*` names the consumer's
   docs import, looks each up with `npm view` (skipping — not retrying — a
   genuine `E404`), and installs the rest at `@beta` into
   `$RUNNER_TEMP/stonyx-doc-registry` with `npm install --ignore-scripts`,
   retried up to 3 times 30s apart. Ends in `exit 1` on a hard failure and
   does not swallow any status (asserted by `test/workflows-test.js`).
10. **Check doc imports** — `node .stonyx-workflows/scripts/check-doc-imports.mjs
    --repo . --resolve-from "$RUNNER_TEMP/stonyx-doc-registry"`.

The docs-import check (steps 6–10) exists so that a `stonyx`/`@stonyx/*`
import a consumer copies verbatim out of their own `README.md` or
`docs/**/*.md` is actually resolvable against the real package's shipped
`exports` — see [abofs/stonyx#122](https://github.com/abofs/stonyx/issues/122)
and [docs/areas/scripts.md](scripts.md) for the mechanism. It is deliberately
kept out of `npm-publish.yml` and `cascade.yml` — `test/workflows-test.js`
asserts it does not appear in either — because those two workflows carry
secrets (`CASCADE_PAT`) and this one does not.

## What the test suite pins here

`test/workflows-test.js` asserts (among other things): the steps above exist
once each and in the order listed above; the `with:` values on both
checkouts are exact; `--ignore-scripts` is set on both installs; no step in
the docs-import portion carries `if:` or `continue-on-error:`, and neither
does the job; and no secret name appears anywhere in `ci.yml`. A separate
suite executes the registry-install step's real shell body against a stubbed
`npm` binary to check the `E404`-skip-without-retry, non-404-keep,
3-attempt-retry, and failing-name-helper behaviours described above.
