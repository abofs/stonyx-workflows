[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

# Stonyx Workflows

Shared GitHub Actions workflows for Stonyx framework packages.

## Available Workflows

> **Editing a file in `.github/workflows/`?** Adding a `${{ }}` to one is not
> free. It needs an **allowlist entry** saying why it is safe there, and if it
> sits in a `run:` or `script:` body it needs a **second entry** in the
> step-scoped allowlist as well. Nothing else: no count to bump anywhere.
> Measured on this tree (suite total **319**) -- a **one-line** `run:`-body
> expression in `ci.yml` is
> 310 pass / 9 fail with no entry, 316 / 3 with the first, 319 / 0 with both;
> an expression in a `with:` or `concurrency:` position needs only the first
> and is 313 / 6 without it, 319 / 0 with it; an `env:` position is **312 / 7**
> without it, not 6, because `env` introduces a chain no entry yet states and
> the context calibration reds alongside the six -- and 319 / 0 with it at step
> or job level. (A *workflow*-level `env:` with a correct entry is 318 / 1: one
> top-level context name is snapshotted in a calibration, a separate open
> finding this PR does not touch.) **An expression INSIDE a block-scalar
> `run: |` body is a third case, and it is not pinnable at all** -- every line
> in there sits under a `(scalar)` link and no entry may name one, so writing
> both entries correctly is still 312 / 7. Bind the value through a step `env:`
> and read the shell variable in the body: **319 / 0** with one entry. Both
> rules, and the properties of the runner they are shaped around, are stated
> in full under
> [The guarantee, and everything that is not one](#the-guarantee-and-everything-that-is-not-one).

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

**Note for consumers:** on the alpha and beta paths this workflow checks
`abofs/stonyx-workflows` out into `.stonyx-workflows/` in your workspace to
reach `scripts/derive-version.mjs`, and removes it again before publishing. The
checkout is pinned to the same commit your `uses:` line resolved to, so the ref
you pin governs the derivation logic as well as the workflow. No change to your
`publish.yml` is required. See
[`docs/release.md` § Workflow consumption](docs/release.md#workflow-consumption).

**Inputs:**

| Input | Description | Default |
|-------|-------------|---------|
| `version-type` | Version bump type. Must be exactly `patch`, `minor` or `major` when it is reached; **any other value, including the empty string, fails the job**. It is reached only on the final `else` of `Determine version bump type` -- that is, when `cascade-source` is empty, the event is neither `push` nor `pull_request`, and `custom-version` is empty | — |
| `custom-version` | Explicit version string. Must be a semver version (an optional leading `v` **is** accepted here) or an npm version keyword (`patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, `prerelease`, `from-git`) | — |
| `cascade-source` | Source package that triggered cascade (non-empty enables cascade mode) | `''` |
| `node-version` | Node.js version | `24.13.0` |
| `pnpm-version` | pnpm version | `9` |

**Validation and failure behaviour.** Every value **`npm-publish.yml`** takes
from a consumer -- the `package.json` `name` and `version`, each `@stonyx/*`
dependency key, and the inputs above -- is validated before it is used, and
reaches a shell or a `github-script` only as an environment variable, never as
program text (abofs/stonyx-workflows#32). The same is true of `cascade.yml`;
see [its section below](#cascadeyml). It is **not** yet true of
`security-audit.yml`, which still interpolates its `audit-level` input into a
shell command -- tracked as
[#34](https://github.com/abofs/stonyx-workflows/issues/34) and deliberately
untouched here.

*The grammar that is actually enforced*, identically at every one of the five
validation points:

```
name     /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i   and  1 <= length <= 214
```

In words: an optional `@scope/` prefix; the first character of the scope and of
the bare name must be alphanumeric; every remaining character must be
alphanumeric, `.`, `_` or `-`; 214 characters maximum. Note this is **not** a
synonym for "a legal npm package name" in either direction -- it is *stricter*
than npm, which tolerates `~`, `'`, `!`, `(`, `*` and `)` in legacy names, and
*looser*, because the `/i` flag accepts uppercase where npm rejects it for new
packages. No current consumer is affected by either divergence; an eleventh repo
being onboarded should be checked against the regex above and not against npm's
own rules.

Versions use two deliberately different grammars, and **the difference is the
leading `v`**:

```
package.json version          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
custom-version                /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/   (or a keyword)
cascade.yml published-version /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
```

A `package.json` `version` may **not** be `v`-prefixed, because npm does not
store one that way. The two consumer-supplied inputs *may* be, because they are
tag-shaped values a caller may reasonably pass as `v1.2.3`. A test pins all
eight copies of these regexes string-identical apart from that one `v?`.

**Eight observable behaviour changes.** They are *not* ordered by how often you
will meet them -- item 3 is the only one every publish run in every consumer
meets, and items 2, 6 and 8 are unreachable for every consumer as wired today.
Read the whole list rather than the top of it:

1. **A registry lookup that fails for any reason other than a genuine `404`
   fails the job** -- in the alpha derivation, the beta derivation, *and* the
   cascade dependency update. `Calculate next alpha version` runs on every pull
   request and `Calculate next beta version` on every push to a non-`main`
   branch, so a transient npm outage now reds publish jobs across every
   consumer repo at once. Previously it fell through to the local
   `package.json` version and published a prerelease with the counter
   restarted at `.0`. A genuine `404` still means "not published yet" and keeps
   the existing first-publish behaviour.
2. **`cascade.yml` refuses a `published-version` that is not semver**, and a
   `package-name` that fails the name grammar, before dispatching anything.
   That is a change to a public `workflow_call` contract -- see
   [its section below](#cascadeyml).
3. **`npm view`'s stderr no longer reaches the job log on the success path.**
   The registry calls now capture stderr, which is how a `404` is told apart
   from a real failure; the consequence is that `npm WARN` and `npm notice`
   lines that used to appear in the publish log are discarded unless the call
   fails.
4. **A `package.json` `name`, `version`, or `@stonyx/*` dependency key that
   fails its grammar fails the job** rather than being passed through.
5. **A failed registry lookup during a cascade is no longer silently skipped**
   -- the dependency update reds instead of publishing against stale ranges.
6. **A `version-type` outside `patch|minor|major` fails the job**, including
   the empty string, rather than being written through to an output that
   matches no bump step and publishing the unbumped version. The empty case is
   reachable through this README's own child-repo template, which passes
   `version-type: ${{ github.event.inputs.version-type || '' }}`: a
   hand-crafted `repository_dispatch` with no `source_package` reaches that
   branch with `""`.
7. **A registry lookup that *succeeds* but returns output that is not JSON
   fails the job.** Item 1 covers a lookup that fails; this one does not fail
   -- `npm` exits 0 and prints something else, which is what a registry proxy
   or a captive-portal error page does. Pre-fix the `JSON.parse` of
   `npm view <pkg> versions --json` sat inside the same `try` as the lookup, so
   unparseable output took the missing-package fallback; it is now its own
   hard-fail. Measured with a stub exiting 0 and printing
   `<html>502 Bad Gateway</html>` for `versions --json` and a healthy
   `dist-tags.latest`: old body exit 0 `version=0.1.1-alpha.0`, new body exit 1.
   Same two steps as item 1, so the same every-PR / every-push reach.
8. **`custom-version` is no longer word-split.** It was interpolated unquoted
   into `pnpm version ${{ inputs.custom-version }} --no-git-tag-version`, so a
   multi-word value arrived as several argv elements; it is now a quoted
   expansion behind the semver/keyword validator. Measured with
   `custom-version: "prerelease --preid rc"` -- a documented npm form: old
   `pnpm argv: version prerelease --preid rc --no-git-tag-version`, exit 0; new
   exits 1 with `::error::custom-version is not a valid semver version or npm
   version keyword`. Only single-token values (a semver, optionally
   `v`-prefixed, or one npm version keyword) are accepted now. Dispatch-only,
   and dispatch is frozen, so no consumer can currently reach it.

*The failure text*, so a red job can be grepped rather than guessed at:

```
::error::package.json name is not a valid npm package name: "..."
::error::package.json version is not a valid semver version: "..."
::error::PKG_NAME is not a valid npm package name: "..."
::error::dependency key in dependencies is not a valid npm package name: "..."
::error::custom-version is not a valid semver version or npm version keyword: "..."
::error::version-type must be one of patch, minor, major (got: ...)
::error::npm view <package> <field> failed: ...
::error::npm view <package> versions --json returned unparseable output
```

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `CASCADE_PAT` | No | PAT with `repo` scope. Required when `cascade-source` is set (used for checkout token to push back to main) |

**Outputs:**

| Output | Description |
|--------|-------------|
| `published-version` | The version that was published (e.g., `0.2.3-beta.1`) |
| `package-name` | The name of the published package (e.g., `@stonyx/utils`) |
| `version-channel` | The release channel: `alpha`, `beta`, `stable`, `patch`, `minor`, `major`, or `custom`. `stable` is emitted on a push to `main`, and the child-repo template below gates its cascade job on it |

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
| `package-name` | Name of the package that was just published (e.g., `@stonyx/utils`). **Validated against the npm name grammar** -- see below |
| `published-version` | Version that was just published (e.g., `0.2.3-beta.1`). **Validated as a semver version**, with an optional leading `v` accepted -- see below |

**Two new hard failures (abofs/stonyx-workflows#32).** Both inputs are
validated at the top of the dispatch script, **before `dependency-map.json` is
indexed and before any `repository_dispatch` is sent**. A value that fails
throws, and the cascade job goes red having dispatched nothing:

```
Refusing to cascade: "..." is not a valid npm package name
Refusing to cascade: "..." is not a valid semver version
```

`package-name` must match the same grammar and the same 214-character bound
that [`npm-publish.yml` documents above](#npm-publishyml). `published-version`
must be `MAJOR.MINOR.PATCH` with an optional `-prerelease`, an optional
`+build`, and an optional leading `v`.

This is a change to a public `workflow_call` contract. It is stricter than the
publish path for a reason: this step runs under the **org-level `CASCADE_PAT`**
rather than the repo-bound OIDC identity, so a value reaching program text here
is an org-wide credential rather than a repo-bound one. When `cascade.yml` is
driven from `npm-publish.yml`'s outputs -- the wiring the child-repo template
below uses -- both values have already passed the equivalent checks, so no
existing caller is affected. A caller supplying its own values must uphold the
grammars.

**Secrets:**

| Secret | Required | Description |
|--------|----------|-------------|
| `CASCADE_PAT` | Yes | PAT with `repo` scope for cross-repo `repository_dispatch` API calls |

---

### `security-audit.yml`

Reusable workflow that runs `pnpm audit` against the calling repo. Advisory
only -- the audit step is `continue-on-error: true`, so it annotates but never
fails the job.

**Inputs:**

| Input | Description | Default |
|-------|-------------|---------|
| `audit-level` | Minimum severity level to report | `moderate` |
| `node-version` | Node.js version | `24.13.0` |
| `pnpm-version` | pnpm version | `9` |

> **Known open defect.** `audit-level` is interpolated directly into the audit
> step's shell command, so it is the one remaining place in this repo where a
> `workflow_call` input becomes shell source -- the defect class
> [#32](https://github.com/abofs/stonyx-workflows/issues/32) closed in
> `npm-publish.yml` and `cascade.yml`. It is tracked as
> [#34](https://github.com/abofs/stonyx-workflows/issues/34) and is **not**
> fixed by #32. It is carried as a named allowlist entry citing that issue in
> **two** places -- `test/helpers/expression-allowlist.js`, which is the
> repo-wide guarantee, and `test/helpers/interpolation-sweep.js`, which is the
> diagnostic that names the step -- so closing #34 has to remove both.
>
> **Deleting the entry is not evidence.** A deleted entry and a never-consulted
> entry look identical from a green suite. #34 must, with its fix in place and
> the entry deleted, re-apply the original sink line
> (`pnpm audit --audit-level ${{ inputs.audit-level }}`) to its **own fixed**
> `security-audit.yml` and observe the suite go red -- run against the live
> allowlists, not local empty ones, so the proof is about the artefact rather
> than one indirection away from it. The mechanism is already proven in
> `test/raw-sweep-test.js` and `test/sweep-bypass-test.js`; #34 owes the run,
> not a citation.
>
> #34's remediation will introduce an expression of its own -- an
> `AUDIT_LEVEL: ${{ inputs.audit-level }}` step `env:` line, or whatever shape
> it takes -- and that line needs its **own** allowlist entry saying why the
> new position is safe. Both halves are measured in `test/raw-sweep-test.js`.
>
> Two rules bind whatever #34 writes, because both are properties of the
> **workflow file** rather than of the test:
>
> - An expression inside a shell `#` comment is a **live sink**, never exempt.
>   The runner substitutes `${{ }}` into the run script textually before bash
>   parses it, and a `workflow_call` input can contain a newline -- measured
>   under `bash --noprofile --norc -e` with
>   `inputs.audit-level = "moderate\ntouch /tmp/canary/PWNED\n#"`: exit 0, and
>   the canary written. So a fix that leaves the old command in a comment has
>   not closed the sink. Reference the issue and the input **by name**.
> - An allowlist entry pins an **exact source line and the key that line is
>   written under**, not just a step and an expression. Moving the line into a
>   different context kills its entry, which is the point: #34's remediation is
>   precisely a line that moves. See
>   [The guarantee, and everything that is not one](#the-guarantee-and-everything-that-is-not-one).

---

### `self-ci.yml`

Not a reusable workflow. Runs this repo's own test suite on every pull request
and on every merge to `main`, so changes to the workflows here are gated by a
check run in this repo rather than only by a downstream consumer publishing a
real version.

```yaml
on:
  push:
    branches: [main]
  pull_request:
```

`push` is scoped to `main` -- the same shape this README teaches consumers
above. Left unscoped it would fire alongside `pull_request` on every branch
push, producing two identical check runs for one event.

Runs `pnpm install --frozen-lockfile` then `pnpm test` on Node `24.13.0`.

---

## Development

This repo has an executable surface: a private root `package.json`, a test
suite, and one extracted script. There are no dependencies -- tests use Node
core modules only (`node:test`, `node:assert`, and for the executed workflow
cases `node:child_process`, `node:crypto`, `node:fs`, `node:module`, `node:os`,
`node:path`, `node:url`, `node:vm`),
and `pnpm test` runs with no `node_modules` present.

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
again before the publish steps. That cleanup is defence-in-depth rather than
the only barrier: `npm pack` does pack a dot-prefixed directory at the package
root, but all **ten** current consumers declare a `files` allowlist that
excludes it, so none of them would have packed it. The step is what keeps that
true for a consumer that later drops the allowlist.

Ten is the measured number, as of 2026-09-02: every `abofs/stonyx*` repo with a
`.github/workflows/publish.yml` that references a workflow from here --
`stonyx`, `stonyx-logs`, `stonyx-utils`, `stonyx-events`, `stonyx-cron`,
`stonyx-sockets`, `stonyx-rest-server`, `stonyx-oauth`, `stonyx-orm` and
`stonyx-discord`, which is exactly the ten packages `dependency-map.json`
lists. `stonyx-workflows` and `stonyx-dashboard` have no `publish.yml`. Earlier
counts of "nine" and "eleven" in this repo and in its issues are both wrong.

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
| `test/workflows-test.js` | That `npm-publish.yml` calls the script and retains no inline version arithmetic, and that `self-ci.yml` retains both a push and a pull_request trigger |
| `test/publish-glue-test.js` | Executes each derivation step's real `run:` body offline against a stubbed `npm`, and pins the checkout step's `ref:` and `if:` |
| `test/lift-equivalence-test.js` | Differential proof that `deriveVersion` matches the `main@692d122` heredocs it was lifted from, across 864 input pairs. Those heredocs are read from `test/fixtures/npm-publish-692d122.yml`, a frozen copy of the pre-lift workflow pinned by blob SHA -- **do not refresh it**, it is the text the equivalence is measured against |
| `test/injection-test.js` | That no consumer-controlled string reaches program text or a shell string in `npm-publish.yml` or `cascade.yml`. Executes the real `run:` bodies against a stubbed `npm`/`pnpm`/`git` and the real `cascade.yml` `script:` body against a stubbed `github` client; pins the npm-name and semver grammars and their duplicated copies; **runs the raw `${{ }}` guarantee** over every file in `.github/workflows/`; and runs the diagnostic sweeps below over the same files, asserting each reports nothing |
| `test/sweep-bypass-test.js` | That the **diagnostic** sweep can go red, and that the reader underneath it reports rather than guesses. Runs each mutation that used to defeat it -- a duplicated step name, a folded `run: >`, a `format('{0}', ...)` expression, an exemption outliving its sink, and the bypass-6 shapes (an unnamed step, a key nested in an earlier block scalar, a quoted key) -- against deliberately broken workflow text. Also pins the AC4 fixture to its blob SHA, calibrates the `run:`/`script:` key-line pin in both directions, and carries the `#34` re-arming case |
| `test/raw-sweep-test.js` | That the guarantee holds and can go **red**. Re-runs every bypass family raised across the PR #38 reviews -- unnamed steps, a `run:` nested in a block scalar, a quoted `"run":`, four multi-line flow/plain scalar shapes, a single-line flow mapping under `with:`, a whole `.yaml` file, an explicit `? run` key, an escaped key, a next-line alias, a duplicate step name, `run: >`, `format('{0}', ...)`, `eval "..."`, a dead entry -- and asserts the raw scan reports each. Includes the **eight dedented context forgeries** that were green before round 6, each moving the org-level `CASCADE_PAT` into a shell body, with a decoy `}` as the kill mutation; a **brand-new** credential with a fresh, well-formed entry and nothing deleted; and the discriminator's own false-positive figure and monotonicity. Also keeps **one** check on the scanner's independence -- a whitelist over every occurrence of the token `import` in its source -- calibrated against the four spellings that defeated its predecessors, and with the disclosed gap (a load site written without the token `import`) committed as its own calibration |
| `test/checkout-credentials-test.js` | That no `actions/checkout` leaves its credential in `.git/config` for the consumer code that runs after it (#35). Reds if a checkout taking a token other than the ambient `github.token` omits `persist-credentials: false`, and the stricter property this repo holds -- that **no** checkout persists. Non-vacuity is measured four ways: the SHA-pinned `main@692d122` blob (the real bytes that shipped the defect, unseen by this guard) reds; twelve mutations of the **live** files red (the line deleted, or written as `true`, `'false '`, `False`, `no`, `0`); synthetic reds each carry a matched control; and the `github.token`-substring trap is pinned, since the real cascade expression contains that spelling. Also executes both real push-step `run:` bodies against a `git` stub recording argv **and environment**, so "exactly `pull` and `push` carry the credential, and `add`/`commit`/`tag` do not" is measured rather than read |
| `test/helpers/checkout-credentials.js` | The #35 guard, off raw text -- `match`, `split`, `trim`, and nothing imported from `workflow-yaml.js`. Fail-closed at every judgement: a checkout it cannot bound to a step **throws**, a duplicate `token:` **throws**, an unrecognised token spelling counts as **privileged**, and an unrecognised `persist-credentials` value counts as **not disabled**. `checkoutUsesLineCount` counts the population off raw text with code sharing nothing with the reader, so a checkout the reader cannot see reds on the count |
| `test/helpers/raw-expression-scan.js` | **The guarantee.** A raw byte scan for `${{` over every file in `.github/workflows/`, enumerated with no extension filter. Understands no YAML: `indexOf`, `slice`, `split`, `trim`, and not one regex. An occurrence with no allowlist entry reds, an entry matching no occurrence reds, an opener that does not close on its own line reds, a malformed entry reds, and a `\x`/`\u`/`\U`/end-of-line backslash reds -- those four escapes are the complete set a YAML double-quoted scalar can use to build an opener out of bytes that do not contain one, so the scan reports them rather than guessing which scalar style a line is in. `structuralContexts` derives the CHAIN of keys a line is written under -- `jobs > dispatch > steps > with` -- from indentation and the first colon, marking any link that already carries a value as `(scalar)`, so an exemption cannot follow its line from `with:` into `run:` and a payload written inside a body cannot spell its own context. The three styles that could still forge it -- multi-line double-quoted, single-quoted and flow -- are closed by `walk`, whose quote and flow-depth state persists across the line break, so a line that began inside an open scalar cannot open a mapping. What the key still does not model is **who receives the value**; that one is disclosed below |
| `test/helpers/expression-allowlist.js` | The named exceptions the guarantee reads: one entry per `(context, line, expression)` triple, each pinning the exact source line, the key that line is written under, the expression, an occurrence count and a reason. The counts are derived from the files rather than snapshotted, so an entry added with its expression does not require bumping a literal. An entry whose `why` is shorter than 60 characters, or which names none of its own expression's references, is refused -- a reason that could be pasted onto any entry is not a reason |
| `test/helpers/interpolation-sweep.js` | The **diagnostic** `${{ }}` sweep as a pure function of `(file, text)`, plus the step-scoped `ALLOWLIST` and `NON_BODY_KEY_LINES`. Names which step and which sink an expression sits in, and pins the `run:`/`script:` body population so the executed tests cannot go vacuous. Returns problem strings rather than asserting, **which is the point**: `injection-test.js` asserts the array is empty for the real workflows and `sweep-bypass-test.js` asserts it is non-empty for broken ones. Same code, both directions |
| `test/helpers/workflow-yaml.js` | **Diagnostics only** -- no guarantee depends on it. Minimal reader for the workflow YAML shapes the tests assert on: a step's `run:` body, `env:` mapping and `with: script:` body, a workflow's trigger keys, `${{ }}` expression extraction, and the raw-text `run:`/`script:` key-line count. Every step list item is a step, named or not; the name-taking wrappers **throw** on an ambiguous name rather than returning the first match; a list item in a shape it cannot resolve **throws, never skips**; and a step with no such key raises a typed `MissingStepKeyError` (`code === 'MISSING_STEP_KEY'`) so callers can tell "has none" from "could not read the one it has" without matching on message text |
| `test/fixtures/security-audit-e07e185.yml` | A frozen copy of `security-audit.yml` at `e07e185`, pinned by blob SHA, with a local copy of its allowlist entry. **Do not refresh it.** #34 will delete both the live sink and the live entry; these mutations are measured against the text they were measured against, and re-pointing them at the live file is what destroys the test |

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

`test/injection-test.js` is the file that fails if someone reintroduces an
interpolation -- one of two, deliberately: `test/raw-sweep-test.js` asserts the
same property per file, and both enumerate the directory through the same
proven enumerator, so either alone catches a live sink. Its rule is one
sentence -- *no consumer-controlled string ever becomes program text or a
shell-string fragment*.

#### The guarantee, and everything that is not one

One check in this suite is a **guarantee**; the rest are **diagnostics**, and
knowing which is which is the whole subject of
[#37](https://github.com/abofs/stonyx-workflows/issues/37).

> **Every `${{ }}` occurrence in every file under `.github/workflows/` --
> enumerated by directory listing with no extension filter, found by a raw byte
> scan with no YAML understanding whatsoever -- must appear in an allowlist
> keyed by (file, structural context, exact source line, expression) with a
> stated reason. And no line in that directory may carry a backslash escape
> that could construct an opener the scan cannot see.**

That is `test/helpers/raw-expression-scan.js` against
`test/helpers/expression-allowlist.js`. It reads bytes, and it calls no reader.

**How that last claim is known: by reading the file.** The scanner is a short,
self-contained module that imports one line. One mechanical check sits beside it
-- a whitelist over every occurrence of the token `import` in its source,
calibrated against an indented static import, a dynamic `import()`, a computed
specifier and a `file://` URL -- and its job is to stop a load site being added
without anyone noticing, not to defeat an engineer who means it. A load site
written without the token `import` is not seen; that gap is disclosed under
*Honest gaps* and committed as a calibration of its own. Rounds 2, 3 and 4 tried
five layered pins instead, including a `node:module` loader hook; all five were
walked past green at the tree they shipped on, and they produced four defects of
their own and no live sink, so round 5 removed them. What is left is calibrated
against the four spellings that defeated its predecessors, and it fails on each
of them: measured on this tree, a static import of the extractor, an indented
one, a dynamic `import()` of a relative specifier and one of an absolute
`file://` URL are each **318 pass / 1 fail**, as is removing every static import
so the non-vacuity guard has nothing to see. Fewer moving parts, each able to
fail.

The reason it is shaped that way is worth reading before changing it. The
earlier sweep was founded on a YAML reader, and #37 found a sequence of shapes
that made the reader disagree with the file while the guard agreed with the
reader -- a duplicated step name, a folded `run: >`, a `format('{0}', ...)`
expression, an exemption outliving its sink, an `eval "..."` relocation, an
unnamed step, a `run:` key nested in an earlier block scalar, a quoted
`"run":` key, multi-line plain and quoted scalars, a single-line flow mapping
under `with:`, a `.yaml` file extension, an explicit `? run` key, an escaped
key, a next-line alias. Each was found *after* the previous fix shipped: every
round of layered population pins bought another round of shapes, so the
guarantee stopped being founded on a reader instead of being given one more
pin. None of those shapes can hide three bytes from a byte scan.

Those are the **known-closed** shapes, not a proof that no shape remains. What
the design buys is a direction: within the population it sweeps, an
unanticipated *shape* fails **closed** -- the occurrence is counted, no entry
matches, the suite reds -- and where bytes alone cannot settle the question the
scan **reports** rather than skipping, which is why a `\x24`, `\u`, `\U` or
end-of-line backslash anywhere in `.github/workflows/` is a red rather than a
silence.

"Fails closed" is a claim about shape. The exposure that remains is
**population**: the scan enumerates `.github/workflows/` and nothing else, so a
`${{ }}` in `.github/actions/**/action.yml` -- an ordinary GitHub Actions
location -- would be unswept and would fail **open**. No such directory exists
in this repo today, which makes that drift rather than a live hole, but it is
the boundary, and it is where the next round should look first. The key is also
an exemption for a **line**, not for a destination: swapping
`uses: actions/checkout@v4` for a third-party action leaves
`token: ${{ secrets.CASCADE_PAT }}` and its context byte-identical and the suite
green, with the entry's recorded reason now false. Reviewing **whatever consumes
the value** -- a `uses:`, or the `run:` line that reads the `env:` var the entry
approves -- is a human obligation here. Measured on this tree, and it lands on
`#34`'s own prescribed remediation: `AUDIT_LEVEL: ${{ inputs.audit-level }}` in
a step `env:`, both old entries deleted, a correct new entry written, and the
body reading `run: eval "pnpm audit --audit-level $AUDIT_LEVEL"` is **319 pass
/ 0 fail** -- the same figure as the safe landing state, which is the point: the
suite cannot tell them apart. The entry's reason -- *"an `env:` value is data the
runner sets, not source that bash parses"* -- is then false about the file it
describes, and nothing reds. **Passing a value through `env:` is not on its own
sufficient guidance**, and `#34` should hear that before it writes the `env:`
line: the line that reads `$AUDIT_LEVEL` is part of the same review, and the
difference between `"$AUDIT_LEVEL"` and `eval "… $AUDIT_LEVEL"` is a human
judgement this suite does not make. A mechanical floor is available and cheap --
no `eval` in any `run:` body, green today and non-vacuous the moment one
appears -- and is deliberately not added here, because it is a rule about shell
rather than about `${{ }}` and belongs with `#34`.

**The structural context was forgeable by three YAML shapes. It is not any
more, and this section used to say the fix needed a parser, which was false.**
The allowlist key carries the chain of keys a line is written under. Which lines
can *legitimately* establish a context turns on one property, measured against
Psych 5.3.1 / libyaml 0.2.5: can a scalar's content sit at an indentation less
than or equal to its own key line's? For a literal block `|`, a folded block `>`
and a plain multi-line scalar the answer is **no** -- content at or left of the
key is a sibling key or a parse error -- so the owning key is unavoidably an
ancestor and appears in the chain as a `(scalar)` link, and `entryShapeProblems`
refuses any entry whose `context` names one.
That is **three** styles, not the four this section and two other files claimed
for a round. For a **multi-line double-quoted or single-quoted scalar, or a flow
collection spanning lines, the answer is yes**: a continuation may sit at exactly
the indentation a legitimate key would occupy.

Indented under the opener that still reds, because the chain lengthens.
**Dedented to the enclosing key's own content indent it did not**, because the
forged frame pops before the payload line is read and the derived chain comes
out byte-identical to the line it replaced:

```yaml
      - name: Forged context dedent
        run: "true
        with:
          node-version: ${{ inputs.node-version }}
        "
```

valid YAML whose `run` resolves to a shell string carrying a live expression,
with the guarantee reporting **nothing at all** -- not even a dead entry,
because the pre-existing `with:` entry genuinely matched the forged line. On the
previous tree that was **294 pass / 0 fail**, and so were the single-quoted and
flow spellings of it; the same transform reached **34 of the 36** allowlist
entries, including every credential in the repo and every consumer-supplied
`inputs.*`. It did not require deleting anything either: a **brand-new**
`secrets.CASCADE_PAT` in a forged body, with one fresh entry that passes every
shape check, was also 294 / 0.

**What closed it is not a parser.** The three forgeable styles are not defined
by indentation or by colons -- each is defined by *an opener that has not closed
yet*, which is a fact about bytes on the **previous** line, and the scanner was
throwing that away at every newline. `structuralContexts` now carries quote and
flow-collection state across the break, so a line that began inside an open
scalar is data and may not open a mapping. One `while` loop, one character of
lookahead, no regex and no YAML reader: the *understands no YAML* property the
guarantee is sold on is intact. Re-measured on this tree, the same three
dedented spellings on the real `ci.yml` are **313 pass / 6 fail** each, and all
five real workflows still sweep clean with no new allowlist entry.
`test/raw-sweep-test.js` carries **ten** spellings as committed cases --
including a decoy `}`, which is ordinary content inside a double-quoted scalar
and is the one that separates this from a plausible implementation, and two
that pin the flow-depth half of the walk. Both of those widenings were
invisible: measured on this tree with the two rows deleted, unclamping the flow
depth is 317 / 0 and clearing it at a `#` is 317 / 0 (of 317), and with the
rows present each is 318 / 1 on its own row.

**And that was still not the whole of it.** For two rounds this section said
the chain *"now closes all five scalar styles and both flow collections"*, and
it did not: the round-7 rule marks the link a dirty line CONTRIBUTES, and a
contributed link is only reachable from a line indented under it. A payload
written **at or left of its own opener** popped that frame -- the one frame
guaranteed `(scalar)` -- before its own position was recorded, and derived an
ordinary-looking chain that an ordinary-looking entry could then name.

The premise the rule was derived from was also wrong, and it is corrected
above: the *"a continuation may sit at any indent GREATER THAN the enclosing
block mapping's"* qualifier is not a rule **libyaml** enforces, and *"a payload
can lengthen a chain, never shorten one"* is true only of the three block and
plain styles. Re-derived here rather than re-asserted -- 63 documents, key at
content indent `m = 0..6` inside a nested mapping, continuation at indent
`p = 0..8`, `Psych.load` on each: **63 / 63** keep the payload inside the
scalar, including every case where the continuation sits LEFT of its own key
and every case at column 0. There is no lower bound **in libyaml**.

**That qualifier is not vacuous, though -- it is a real boundary in two other
readers, and the sentence above is libyaml's answer rather than YAML's.** The
same 63 documents, measured on this tree through two other widely used
implementations: **js-yaml 5.4.1 is 35 / 63** (`deficient indentation`) and
**eemeli/`yaml` 2.9.0 is 35 / 63** (`Missing closing "quote`) -- and the 35 are
the *same* 35 in both, exactly the cells where `p > m`. Both enforce the
qualifier libyaml drops: neither accepts a continuation at or left of its own
key line, at any `m`. On the real file that boundary is a single column. The
forged step appended to `npm-publish.yml` writes its `run:` key at column 8, so
sweeping the payload across indents 0..12 gives **libyaml 13 / 13 live**, while
js-yaml and `yaml` reject 0..8 outright and agree with libyaml only at 9..12.
The shape is therefore live under **all three** readers at `p >= 9`, and under
**libyaml alone** at `p <= 8`.

The guard does not split that hair, deliberately: it refuses the payload at
**every** indent, which is a superset of what any one reader accepts, so the
over-coverage is **fail-closed**. An indent only libyaml would take is refused
anyway, and no reader being stricter than libyaml reopens anything.

**The disclosed limitation is the other direction: GitHub Actions' own YAML
parser has never been tested here, in any round of this PR.** Every figure in
this README and in `test/helpers/` that says "measured against Psych 5.3.1 /
libyaml 0.2.5" uses libyaml as a **proxy for the runner**, and that proxy has
never been validated against the runner. The 63-cell grid above is the reason
that matters: implementations disagree by a whole boundary on precisely the
property these rules turn on, so "libyaml accepts it" does not establish "the
runner accepts it", in either direction. This does not weaken the guard, which
refuses the whole range and is not derived from any parser -- it means the
**motivation** attached to each row, *"this shape is live on the runner"*, rests
on an equivalence nobody here has measured. Validating it needs the runner, not
another library.

The marking is now taken from the **line's own state** rather than from a frame
the pop loop can reach, so it survives any indent. Measured on this tree, one
forged step appended to the real `npm-publish.yml` with the payload swept across
indents 0..12: all thirteen keep `${{ inputs.custom-version }}` live inside the
`run:` string **under libyaml** -- the four at indents 9..12 under all three
readers named above -- thirteen of thirteen now derive a `(scalar)` link, and
the entry written for the derived context is refused at all thirteen. The same
twelve-line diff, with that entry, was **309 pass / 0 fail** at `2c7d7bd` and is
**313 / 6** here.

So the chain and the marking together close **all five scalar styles and both
flow collections, at every indent** -- which is the claim this section should
have been making, and the qualifier it was missing. Re-measured on this tree as
live edits to the real files: the multi-line double-quoted forgery on `ci.yml`
is 313 / 6, the same shape moving `secrets.CASCADE_PAT` into a shell body in
`npm-publish.yml` is 312 / 7, the ordinary `run: |` forgery is 311 / 8, and the
dedented forgery that used to be green is 313 / 6.

**And the refusal lives in the entry, not only in the chain.** Round 6 shipped
*"no entry can name such a context, so copying it will not work"* in the
contributor-facing hint, in the scanner's header, in the allowlist's header and
here, and enforced it **nowhere**: `entryShapeProblems` had seven refusals and
not one looked at the link. Copy the `(scalar)` context the red prints -- which
is exactly what the allowlist header tells you to do with the other four fields
-- into an otherwise well-formed entry and the guarantee returned **zero
problems** with an org-level PAT live in a `curl` command line. The only thing
refusing it was one assertion over the five shipped files in
`test/raw-sweep-test.js`, which no allowlist edit can clear, so the
contributor's edit and the attacker's edit were the same edit.
`entryShapeProblems` now refuses any entry whose `context` names a `(scalar)`
link, and `rawSweepProblems` calls it for every entry, so the refusal reds at
the guarantee where the sentence says it does. It costs the suite nothing --
no live entry names one -- and the price it does carry is stated in the banner
above and in the rules below: an expression inside a block-scalar body is not
pinnable where it sits, in any spelling.

**The gap that remains is not a YAML shape, and no parser closes it either.**
The key is `(file, context, line, expression)` and it **does not model who
receives the value**. Deleting
`token: ${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}`
from `actions/checkout`'s `with:` and re-adding it byte-identically under
`uses: attacker/telemetry-action@v1` leaves file, chain, line and expression all
unchanged -- **319 pass / 0 fail on this tree, and 294 / 0 at `1a98115`:
the discriminator makes no difference to it, and a real YAML parser would make
none either**, because parsing cannot fix a key that is asking the wrong
question. This one is a human obligation on the diff, and it is a cheap one: the
forgery above produced only first-party-looking lines, whereas this leaves
`uses: attacker/telemetry-action@v1` sitting in the diff, which is the loudest
line a workflow change can carry. **Read what consumes the value, not only the
line the entry pins.**

The sweeps in `test/helpers/interpolation-sweep.js` and the reader in
`test/helpers/workflow-yaml.js` are **diagnostics only**. They say which step
and which sink an expression sits in, which is what makes a red actionable, and
they feed the tests that execute real `run:` bodies. If either is wrong, a
message gets less helpful; nothing goes unswept.

Green still means the guard is armed, not that the workflows are clean. The one
open `${{ }}` sink in this repo is allowlisted with its issue number, on
purpose, and it is not the only open issue against these workflows -- **#35**
and **#36** are untouched by this suite and by this PR.

The rules that bind anyone writing a workflow file here are about the **file**,
not about the test. **The entry**, **the second entry** and **the absent
count** are what a `${{ }}` costs. **The `#`-comment sink** is the property of
the runner those checks are shaped around, and **entries, never widened
patterns** is the rule the checks themselves are built to:

- **Any new `${{ }}` needs an allowlist entry**, in
  `test/helpers/expression-allowlist.js`, pinning
  `{ line, context, expression, occurrences, why }` -- the exact source line,
  **trimmed but otherwise byte-for-byte**, and the **chain** of keys that line
  is written under, innermost last, so the exemption cannot follow its line into
  a different sink. A context is a path, not a single key: `jobs > dispatch >
  steps > with`, `on > workflow_call > outputs > package-name`, or just
  `concurrency` for a top-level key. It is never `run` -- a one-line `run:`
  body's own line sits under `steps`, and a line that **began inside an open
  scalar** gets a `(scalar)` link *wherever it is indented*, which
  `entryShapeProblems` **refuses**: an entry naming one
  is reported rather than honoured, so a `(scalar)` context is the one thing in
  the message you must not copy. (The *wherever it is indented* is the round-9
  correction. This rule used to be written as "a line **inside** a body", and
  it was enforced only for lines indented under their opener: a payload
  dedented back out to column 0 through column 8 derived no `(scalar)` link at
  all.) **Copy the other four fields out of the
  failure message**, which prints the context, the trimmed line, the expression
  and the line numbers verbatim. The `why` has
  to say what the expression is and why it is safe *here*. Adding the entry
  **is** the review, and the reviewer reading it is what holds it to account:
  the mechanical checks are a floor -- a reason under 60 characters, or one
  naming none of its own expression's references, is refused -- and a floor
  stops bulk paste, not bad reasoning.
- **And if the expression sits in a `run:` or `script:` body, that is a second
  entry**, in the step-scoped `ALLOWLIST` in
  `test/helpers/interpolation-sweep.js`. The first entry satisfies the
  guarantee; this one satisfies the diagnostic that names the step and the sink.
  Both reds name their own file, so the message tells you which of the two you
  still owe. **It is a different shape from the first, in two ways that cost an
  iteration if you copy rather than read**: its fields are
  `{ step, line, expression, occurrences, why }` -- **`step`, not `context`**,
  the step's `name:` exactly as written -- and its `line` is the line **of the
  body**, with the `run: ` or `script: ` key prefix already removed. Writing
  `line: 'run: echo "${{ … }}"'` here, which is the value you have just typed
  into the other file, is *worse* than leaving the entry out -- **315 / 4**
  against 316 / 3, because the dead-entry check fires as well as the unpinned
  one. Measured on this tree, adding a **one-line**
  `run:`-body expression to `ci.yml`: no entry anywhere **310 pass / 9 fail**;
  with the first entry and nothing else **316 / 3**; with both **319 / 0**.
  **Both entries together do not cover an expression written INSIDE a
  block-scalar `run: |` body.** Every line in such a body derives a `run
  (scalar)` link, the guarantee entry has to name it, and an entry that names a
  `(scalar)` link is refused -- so there is no pair of entries that clears it,
  and no third file to edit either: measured on this tree, the ordinary
  multi-line step below is **312 / 7** with both entries written correctly, and
  one of the seven is `the live entries are all well-formed` -- the guarantee
  refusing the entry by name. It is not a shape this
  repo needs. Bind the value through the step's `env:` and read the shell
  variable in the body -- which is what `npm-publish.yml` already does for
  eleven of its twenty-five expressions, against one in a `run:` line --
  and the same step is **319 / 0** with one entry and no second file touched:

  ```yaml
  - name: Print the versions
    env:
      PNPM_VERSION: ${{ inputs.pnpm-version }}
    run: |
      echo "building with pnpm"
      echo "$PNPM_VERSION"
  ```
- **The occurrence total is derived, not pinned to a literal.** The three
  independent counts in `test/raw-sweep-test.js` -- the scanner's records, a
  raw `split('${{')`, and the allowlist's own `occurrences` sum -- have to
  agree with each other, and they move with the file. Adding an expression with
  a correct entry does not require editing a number anywhere, and no test holds
  a snapshot of which keys the five current files happen to use -- so an
  ordinary construct written under a key none of them uses costs the entries
  above and nothing more. Measured: a job-level `if:` on `ci.yml`'s only job is
  312 pass / 7 fail unallowlisted and **319 / 0 with one entry in one file**,
  wherever in that file's list the entry is written.
- **An expression inside a shell `#` comment is a live sink.** The runner
  substitutes `${{ }}` into the run script textually before bash parses it, and
  a `workflow_call` input can contain a newline, so a commented-out command
  still executes. Never quote a removed expression in a comment; reference the
  issue and the input by name.
- **The way past a check is an entry, never a widened pattern.** Pinning an
  exemption to a step rather than to a line let it follow its expression into an
  `eval "..."` wrapper, or into a comment left behind by the very fix that
  closed the sink; pinning it to the trimmed line alone let it follow the line
  itself out of a `with:` input and into a `run:` body, which is why the key
  carries the context too. An entry whose line has moved, or whose line now sits
  under a different key, is reported as **dead**, which is how a fixed sink
  loses its exemption. The step-scoped `ALLOWLIST` in
  `test/helpers/interpolation-sweep.js` and `NON_BODY_KEY_LINES` beside it
  follow the same rule: both are re-derived from the file every run. **This
  binds the key's own shape too**, which is the least obvious form of it: the
  `line` field is the source line minus leading and trailing whitespace and
  **nothing else**. Normalising it further -- collapsing internal double spaces
  so that an entry written for `a:  ${{ x }}` also exempts `a: ${{ x }}` -- is a
  widened pattern wearing a tidy-up's clothes, and it was green at 293 pass /
  0 fail until `test/raw-sweep-test.js` grew a case for it. The one check that
  cannot be given a per-line entry would be the exception that proves the rule,
  so the escape report has one: `ESCAPE_ALLOWLIST` in
  `test/helpers/expression-allowlist.js` pins a `(line, escape)` pair with a
  reason, and a dead entry reds, so the remedy for a false positive is never to
  shrink `CONSTRUCTING_ESCAPES` or the lines it reads. It is empty today, and
  that is asserted rather than assumed.

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
