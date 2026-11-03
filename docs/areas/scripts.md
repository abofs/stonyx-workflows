# Area: `scripts/`

Verified against the four files under `scripts/` as committed on `dev` in
this session, and against the test files that exercise them, all passing in
the `pnpm test` run documented in
[docs/index.md](../index.md#build-run-test).

## `scripts/derive-version.mjs`

Exports one function:

```js
export function deriveVersion({ channel, latestStable, allVersions }) { ... }
```

Given the current prerelease `channel` (`'alpha'` or `'beta'`), the
registry's `dist-tags.latest` (or the local `package.json` version when that
lookup failed with a genuine `404`), and every published version for the
package, it computes the next bumped patch version
(`maj.min.(pat+1)`), finds the highest existing `-<channel>.N` suffix already
published for that patch, and returns `N+1` (or `0` if none exists). No
network, filesystem, or clock access — all I/O is the caller's
responsibility (`npm-publish.yml`'s `Calculate next alpha version` / `Calculate
next beta version` steps do the `npm view` calls and pass the results in).

Called by: `npm-publish.yml`, via a dynamic `import()` of
`.stonyx-workflows/scripts/derive-version.mjs` from inside a `node -e` block,
on the alpha and beta channels only.

Pinned by: `test/derive-version-test.js` (characterization against a
committed capture of real `@stonyx/oauth` registry state — deliberately
including today's known defects, tracked as
[#23](https://github.com/abofs/stonyx-workflows/issues/23) and
[#24](https://github.com/abofs/stonyx-workflows/issues/24), so that fixing
them later shows up as an intentional diff here) and
`test/lift-equivalence-test.js` (864 input pairs checked against the
pre-lift heredocs this function was lifted from, frozen in
`test/fixtures/npm-publish-692d122.yml`).

## `scripts/check-doc-imports.mjs`

CLI: `node check-doc-imports.mjs --repo <dir> [--file <path>]...
[--resolve-from <dir>]...`. Exit 0 clean, 1 on failures, 2 on a usage error.

Scans `README.md` and `docs/**/*.md` (or the `--file` paths given), extracts
`import ... from`, `export ... from`, and side-effect `import '...'`
statements whose spec matches `stonyx`, `stonyx/<subpath>`, `@stonyx/<pkg>`,
or `@stonyx/<pkg>/<subpath>` out of fenced code blocks tagged as JS/TS (or
untagged), and compiles each as a one-statement virtual `.mts` probe
type-checked with `module`/`moduleResolution: NodeNext`,
`verbatimModuleSyntax`, and `noUncheckedSideEffectImports` against the
repo's own pinned TypeScript (loaded only from next to this script — a
`typescript` resolved from outside this tooling tree, e.g. the consumer's
own `node_modules`, is refused with exit 2). Beyond raw TypeScript
diagnostics (`TS2307` unresolved, `TS2614`/`TS2305` no such member, `TS1484`
type-imported-as-value), it layers its own checks: `DEFAULT-NAME` (a default
import's binding must match the default export's declared name),
`WILDCARD-NO-FILE` (a wildcard `exports` key must map to a file that
exists), `NOT-EXPORTED` (for packages shipping no types), and `UNEXTRACTED`
(a stonyx-spec import sitting in a fence that wasn't extracted as a
statement — including a commented-out one — still fails, so the check
cannot pass by simply not seeing an import).

Called by: `ci.yml`'s `Check doc imports` step, for every repo that calls
`ci.yml`.

Pinned by: `test/doc-imports-test.js`, against hand-written fixture packages
under `test/fixtures/doc-imports/` (`core` named `stonyx`, `discord`,
untyped `dashboard`, `unbuilt`), asserting exact `file:line: CODE` output for
each red case (missing member, unexported subpath, default-name mismatch,
type-as-value, trailing slash, wildcard-to-missing-file, unbuilt package,
etc.) and exact green behavior for correct imports, anonymous defaults, and
`--resolve-from` resolution. Also asserts that only `ci.yml` runs this
script and that `npm-publish.yml`/`cascade.yml`/`security-audit.yml`/
`self-ci.yml` do not.

## `scripts/doc-registry-packages.mjs`

CLI: `node doc-registry-packages.mjs [--repo <dir>]`. Prints one package
name per line (sorted), exit 0, or 2 on a usage error.

Reuses `check-doc-imports.mjs`'s own `declaredNames`, `discoverDocFiles`,
`extractImports`, and `splitSpec` exports to find every `stonyx`/`@stonyx/*`
import spec in a repo's docs, then filters to names that (a) match the
*stricter* lowercase-only grammar `/^(?:stonyx|@stonyx\/[a-z0-9][a-z0-9-]*)$/`
and (b) are **not** already the repo's own name or listed in any of
`dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`.
Anything outside that grammar (e.g. `@stonyx/Orm`) is deliberately left for
`check-doc-imports.mjs` to fail as unresolved rather than ever reaching
`npm`.

Called by: `ci.yml`'s `Install stonyx packages the docs import but the repo
does not declare` step, which feeds this script's output to `npm view` /
`npm install` for the `--resolve-from` scratch directory.

Pinned by: `test/doc-imports-test.js` (self and declared-dependency-field
exclusion, grammar-outside names dropped, CLI exit codes).

## `scripts/run-tests.mjs`

Not called by any consumer workflow. This is `pnpm test`'s own entry point
inside this repo (see [docs/index.md § Build, Run, Test](../index.md#build-run-test)):
it globs `test/**/*-test.js`, fails loudly if fewer than two files match
(because `node --test <glob>` silently exits 0 reporting zero tests on a
glob match of nothing), and passes that same resolved file list to `node
--test` so the list that's checked for non-vacuity is the list that actually
runs.
