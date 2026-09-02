import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSteps, readWorkflow, stepEnv, stepRunBody, stepScriptBody } from './helpers/workflow-yaml.js';

// Consumer-controlled-string injection sinks in the reusable workflows, for
// abofs/stonyx-workflows#32.
//
// The convention this suite enforces is one sentence: no consumer-controlled
// string ever becomes program text or a shell-string fragment. A consumer owns
// its own `package.json` `name`, its dependency keys, and the
// `workflow_call`/`workflow_dispatch` inputs, so every one of those is hostile
// input to a workflow that eleven repos share.
//
// Six of the seven sinks are proven here BY EXECUTION: the real `run:` body is
// extracted from the YAML, dropped into a throwaway workspace with a fake
// `npm`/`pnpm` on PATH, and run under the same shell GitHub Actions uses
// (`bash -eo pipefail`). A payload that executes writes into `$CANARY_DIR`;
// the assertion is that the directory stays empty and the step fails loudly.
//
// The seventh (AC5, the two `actions/github-script` sinks) splits in two, and
// the split is the point:
//
//   - The `${{ }}` SUBSTITUTION cannot be executed offline. The runner does it
//     textually before the script is parsed and there is no offline engine for
//     it, so the absence of any expression inside either `script:` body is
//     asserted statically and cannot be more than that.
//   - The guards' POST-SUBSTITUTION BEHAVIOUR is ordinary JavaScript, precisely
//     because the fix removed every expression from the body. It is therefore
//     executed here: the real `script:` text is extracted and run as an async
//     function with a stubbed `github` client, zero dependencies, nothing
//     dispatched. A `/throw new Error/` grep used to stand in for this and was
//     green against four separate deletions of the guard it named.
//
// One structural-only case remains and is labelled where it lives: AC1's
// `execFileSync` property (`builds no shell command string from a package
// name`). No executed case can red it, because the name grammar admits no
// shell-active character, so for every name that reaches `npmView` a shell
// command line and an argv produce the same invocation. Defence in depth
// working as designed, and stated rather than papered over.

const npmPublish = readWorkflow('npm-publish.yml');
const cascade = readWorkflow('cascade.yml');
const registry = JSON.parse(readFileSync(new URL('./fixtures/oauth-registry-state.json', import.meta.url), 'utf8'));

const WORKFLOWS = { 'npm-publish.yml': npmPublish, 'cascade.yml': cascade };

const ALPHA_STEP = 'Calculate next alpha version';
const BETA_STEP = 'Calculate next beta version';
const DEPS_STEP = 'Update all Stonyx dependencies to latest';
const NAME_STEP = 'Get package name';
const VERSION_STEP = 'Get package version';
const CUSTOM_STEP = 'Bump version (custom)';
const COMMENT_STEP = 'Comment on PR with alpha version';
const DISPATCH_STEP = 'Dispatch to downstream dependents';

// The payloads refinement executed against the pre-fix file. They are kept
// verbatim so this suite is the same experiment, not a paraphrase of it.
const JS_BREAKOUT = `@stonyx/x'; require("fs").writeFileSync(process.env.CANARY_DIR + "/PWNED_JS", "x"); const zz='`;
const SHELL_SUBST = '@stonyx/x$(touch "$CANARY_DIR/PWNED_EXECSYNC")';
const SHELL_SEMICOLON = '@stonyx/x; touch "$CANARY_DIR/PWNED_SH" #';
const OUTPUT_FORGERY = '@stonyx/x\nversion=9.9.9-EVIL\nmalicious=1';

// The grammar tables. Module scope rather than inside AC4's describe block
// because `cascade.yml` carries its own copy of the same grammar and is fed
// the same strings through the executed dispatch harness below -- one table,
// both enforcement points, so a divergence between them shows up as a failure
// rather than as an untested copy.
const ILLEGAL_NAMES = {
  'leading dot': '.stonyx',
  'leading underscore': '_stonyx',
  'contains a space': '@stonyx/rest server',
  'contains a newline': OUTPUT_FORGERY,
  'contains a backtick': '@stonyx/x`id`',
  'contains a pipe': '@stonyx/x|id',
  'contains a backslash': '@stonyx/x\\u0000',
  'empty': '',
  'over 214 characters': '@stonyx/' + 'a'.repeat(220),
  'breaks out of a JS string literal': JS_BREAKOUT,
};

// Guard against the opposite failure: a validator so tight it rejects the
// repos that actually use this workflow would be a production incident on
// every one of them.
const LEGAL_NAMES = ['@stonyx/oauth', '@stonyx/rest-server', 'stonyx', '@stonyx/logs', 'some.pkg', 'a'];

/** Strip the YAML block-scalar indentation without assuming a fixed depth. */
function dedent(body) {
  const lines = body.split('\n');
  const widths = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^(\s*)/)[1].length);
  const strip = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => l.slice(strip)).join('\n');
}

/**
 * A fake `npm` that answers only from an explicit table.
 *
 * Keys are the joined argv, with `*` usable in place of the package name so a
 * case can serve a hostile name it cannot spell in advance. An unlisted
 * invocation is a hard error, so a step that queried something unexpected
 * cannot pass quietly. Every invocation is logged, which is how a case proves
 * `npm` was reached with the payload as ONE argv element rather than as shell
 * text.
 */
function npmStubSource(table, logPath) {
  return [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');`,
    `const table = ${JSON.stringify(table)};`,
    "const exact = args.join(' ');",
    "const wild = args.length > 1 ? [args[0], '*', ...args.slice(2)].join(' ') : exact;",
    'const hit = Object.prototype.hasOwnProperty.call(table, exact) ? table[exact] : table[wild];',
    'if (!hit) {',
    "  process.stderr.write('npm ERR! unexpected invocation in test stub: ' + exact + '\\n');",
    '  process.exit(1);',
    '}',
    "if (hit.stderr) process.stderr.write(hit.stderr + '\\n');",
    'if (hit.exit) process.exit(hit.exit);',
    "process.stdout.write((hit.stdout ?? '') + '\\n');",
    '',
  ].join('\n');
}

/** The registry as it really is for @stonyx/oauth, from the committed fixture. */
const OAUTH_REGISTRY = {
  'view * dist-tags.latest': { stdout: registry.distTags.latest },
  'view * versions --json': { stdout: JSON.stringify(registry.versions) },
  'view * dist-tags.beta': { stdout: registry.distTags.beta ?? '' },
};

const NOT_PUBLISHED = {
  'view * dist-tags.latest': { exit: 1, stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/x - Not found" },
  'view * versions --json': { exit: 1, stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/x - Not found" },
  'view * dist-tags.beta': { exit: 1, stderr: "npm ERR! code E404\nnpm ERR! 404 Not Found - GET https://registry.npmjs.org/x - Not found" },
};

const REGISTRY_OUTAGE = {
  'view * dist-tags.latest': { exit: 1, stderr: 'npm ERR! code ENETUNREACH\nnpm ERR! network request to https://registry.npmjs.org failed' },
  'view * versions --json': { exit: 1, stderr: 'npm ERR! code ENETUNREACH\nnpm ERR! network request to https://registry.npmjs.org failed' },
  'view * dist-tags.beta': { exit: 1, stderr: 'npm ERR! code ENETUNREACH\nnpm ERR! network request to https://registry.npmjs.org failed' },
};

/**
 * Execute one workflow step's real `run:` body in a throwaway workspace laid
 * out the way the runner lays one out, and return everything an assertion
 * could want to look at.
 */
function runStep(stepName, {
  workflow = 'npm-publish.yml',
  packageJson = { name: '@stonyx/oauth', version: '0.1.0' },
  env = {},
  npm = OAUTH_REGISTRY,
} = {}) {
  const body = stepRunBody(WORKFLOWS[workflow], stepName);
  const workspace = mkdtempSync(join(tmpdir(), 'wf32-inj-'));

  try {
    const bin = join(workspace, 'bin');
    const canaryDir = join(workspace, 'canary');
    mkdirSync(bin);
    mkdirSync(canaryDir);
    mkdirSync(join(workspace, '.stonyx-workflows', 'scripts'), { recursive: true });

    // The real derivation script, at the path the checkout step puts it.
    copyFileSync(
      new URL('../scripts/derive-version.mjs', import.meta.url),
      join(workspace, '.stonyx-workflows', 'scripts', 'derive-version.mjs'),
    );

    // `name` is written raw rather than through JSON.stringify of an object
    // literal only where it must carry a real newline; JSON.stringify already
    // escapes one to `\n`, which is what a hostile package.json would contain
    // and what `require()` turns back into a newline.
    writeFileSync(join(workspace, 'package.json'), JSON.stringify(packageJson, null, 2));
    writeFileSync(join(workspace, 'dependency-map.json'), readFileSync(new URL('../dependency-map.json', import.meta.url)));

    const npmLog = join(workspace, 'npm-args.log');
    writeFileSync(npmLog, '');
    const npmStub = join(bin, 'npm');
    writeFileSync(npmStub, npmStubSource(npm, npmLog));
    chmodSync(npmStub, 0o755);

    // `git` is stubbed for the commit/tag steps: it records its argv so a
    // case can prove a branch name arrived as one argument rather than as
    // shell text, and it never touches a real repository.
    const gitLog = join(workspace, 'git-args.log');
    writeFileSync(gitLog, '');
    const gitStub = join(bin, 'git');
    writeFileSync(gitStub, [
      `#!${process.execPath}`,
      `require('fs').appendFileSync(${JSON.stringify(gitLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      '',
    ].join('\n'));
    chmodSync(gitStub, 0o755);

    const pnpmLog = join(workspace, 'pnpm-args.log');
    writeFileSync(pnpmLog, '');
    const pnpmStub = join(bin, 'pnpm');
    writeFileSync(pnpmStub, ['#!/bin/sh', `printf '%s\\n' "$*" >> '${pnpmLog}'`, 'exit 0', ''].join('\n'));
    chmodSync(pnpmStub, 0o755);

    const githubOutput = join(workspace, 'github-output');
    writeFileSync(githubOutput, '');

    const scriptPath = join(workspace, 'step.sh');
    writeFileSync(scriptPath, dedent(body) + '\n');

    // The shell GitHub Actions uses for a `run:` block.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
      cwd: workspace,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: githubOutput,
        CANARY_DIR: canaryDir,
        ...env,
      },
      encoding: 'utf8',
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: readFileSync(githubOutput, 'utf8'),
      outputKeys: readFileSync(githubOutput, 'utf8').split('\n').filter(Boolean),
      pnpmArgs: readFileSync(pnpmLog, 'utf8').trim(),
      npmCalls: readFileSync(npmLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
      gitArgs: readFileSync(gitLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
      canaries: readdirSync(canaryDir),
      packageJson: JSON.parse(readFileSync(join(workspace, 'package.json'), 'utf8')),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * Shorthand for the derivation steps, which take the package name from the
 * step's `env:` after the fix and from `package.json` before it. Both are set
 * to the same value so a case stays honest under either shape -- and so the
 * mutation check (restoring the old body) genuinely reds these tests.
 */
const runDerivation = (stepName, name, opts = {}) => runStep(stepName, {
  packageJson: { name, version: '0.1.0' },
  env: { PKG_NAME: name },
  ...opts,
});

const DERIVATION_STEPS = [[ALPHA_STEP, 'alpha', '0.1.1-alpha.22'], [BETA_STEP, 'beta', '0.1.1-beta.128']];

describe('AC1 -- S1a/S1b: alpha/beta derivation blocks (#32)', () => {
  // Red state, measured on a6e8a9e: `const pkg = '$PKG_NAME';` lets the
  // payload close the JS string literal, so the injected statement runs
  // inside the derivation program. The step still exits 0 with a well-formed
  // version, which is why nothing downstream notices.
  for (const [stepName] of DERIVATION_STEPS) {
    test(`"${stepName}" does not execute a JS-string-breakout package name`, () => {
      const run = runDerivation(stepName, JS_BREAKOUT);

      assert.deepEqual(run.canaries, [], 'a payload in the package name must not execute');
      assert.notEqual(run.status, 0, 'an illegal package name must fail the step, not derive a version');
      assert.match(run.stderr, /not a valid npm package name/, 'the failure must name its cause');
      assert.equal(run.pnpmArgs, '', 'no version may be bumped from an unvalidated name');
    });

    // Red state: `execSync('npm view ' + pkg + ...)` hands the name to
    // /bin/sh, so `$(...)` is expanded before npm is ever reached. This one
    // needs no quote at all.
    test(`"${stepName}" does not shell-expand a $(...) package name`, () => {
      const run = runDerivation(stepName, SHELL_SUBST);

      assert.deepEqual(run.canaries, [], 'the name must never reach a shell as a string fragment');
      assert.notEqual(run.status, 0, 'an illegal package name must fail the step');
      assert.match(run.stderr, /not a valid npm package name/);
    });
  }

  // The happy path is the thing that must not move: eleven repos share this
  // file and every one of them references it at @main.
  for (const [stepName, channel, expected] of DERIVATION_STEPS) {
    test(`"${stepName}" still derives ${expected} for a valid name`, () => {
      const run = runDerivation(stepName, '@stonyx/oauth');

      assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);
      assert.equal(run.output.trim(), `version=${expected}`, `${channel} derivation output must be byte-identical`);
      assert.equal(run.pnpmArgs, `version ${expected} --no-git-tag-version`);
    });

    // Happy-path pin only, and labelled as such: for a LEGAL name a shell
    // command line and an argv produce the same invocation, so this cannot by
    // itself distinguish execSync from execFileSync. It pins that both lookups
    // still happen against the right package.
    test(`"${stepName}" still makes both registry lookups against the given package`, () => {
      const run = runDerivation(stepName, '@stonyx/oauth');

      assert.deepEqual(run.npmCalls, [
        ['view', '@stonyx/oauth', 'dist-tags.latest'],
        ['view', '@stonyx/oauth', 'versions', '--json'],
      ]);
    });
  }

  // The discriminating half of S1b, and the reason env-passing alone is not
  // enough: a name read from process.env that is then concatenated into a
  // shell command string is still a shell-injection sink. Restoring
  // `execSync('npm view ' + pkg + ...)` in either body reds this.
  for (const [stepName] of [...DERIVATION_STEPS, [DEPS_STEP]]) {
    test(`"${stepName}" builds no shell command string from a package name`, () => {
      const body = stepRunBody(npmPublish, stepName);

      assert.ok(
        !/[^e]execSync\s*\(/.test(body) && !body.startsWith('execSync('),
        'execSync takes a shell command line; every registry call must use execFileSync',
      );
      assert.match(body, /execFileSync\("npm", \[/, 'npm must be invoked with an explicit argv');
      assert.ok(
        !/["']npm view ["']\s*\+|\+\s*["'] dist-tags/.test(body),
        'no registry command may be assembled by string concatenation',
      );
    });
  }
});

describe('AC2 -- S2: Update all Stonyx dependencies to latest (#32)', () => {
  const withDeps = (deps) => ({
    packageJson: { name: '@stonyx/orm', version: '0.3.0', dependencies: deps },
    npm: {
      'view @stonyx/cron dist-tags.latest': { stdout: '0.2.0' },
      'view @stonyx/cron dist-tags.beta': { stdout: '0.2.1-beta.95' },
      'view stonyx dist-tags.latest': { stdout: '1.4.0' },
      'view stonyx dist-tags.beta': { stdout: '' },
    },
  });

  // Red state, measured on a6e8a9e: the dependency KEY is concatenated into
  // `execSync('npm view ' + depName + ...)`, so `;` starts a second command.
  // `catch (e) {}` on the next line then hides that anything happened.
  test('a shell-metacharacter dependency key does not execute', () => {
    const run = runStep(DEPS_STEP, withDeps({ [SHELL_SEMICOLON]: '^0.1.0' }));

    assert.deepEqual(run.canaries, [], 'a dependency key must never reach a shell as a string fragment');
    assert.notEqual(run.status, 0, 'an illegal dependency key must fail the step');
    assert.match(run.stderr, /not a valid npm package name/);
  });

  test('a $(...) dependency key does not execute', () => {
    const run = runStep(DEPS_STEP, withDeps({ [SHELL_SUBST]: '^0.1.0' }));

    assert.deepEqual(run.canaries, []);
    assert.notEqual(run.status, 0);
  });

  test('valid dependency keys are still rewritten to the resolved versions', () => {
    const run = runStep(DEPS_STEP, withDeps({ '@stonyx/cron': '^0.1.0', stonyx: '^1.0.0', express: '^4.0.0' }));

    assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);
    assert.deepEqual(run.packageJson.dependencies, {
      // beta 0.2.1-beta.95 outranks latest 0.2.0, and a prerelease is pinned
      // exactly rather than caret-ranged -- unchanged from before the fix.
      '@stonyx/cron': '0.2.1-beta.95',
      stonyx: '^1.4.0',
      // Not a Stonyx package: never queried, never touched.
      express: '^4.0.0',
    });
    for (const call of run.npmCalls) {
      assert.equal(call[0], 'view');
      assert.ok(['@stonyx/cron', 'stonyx'].includes(call[1]), `unexpected npm view target ${JSON.stringify(call[1])}`);
    }
  });
});

describe('AC3 -- S1/S2 fail loudly instead of catch (e) {} (#32)', () => {
  // Red state: `catch (e) {}` and the derivation blocks' try/catch make a
  // registry outage indistinguishable from "package not published yet". A
  // cascade during an npm blip silently skipped the dependency; a derivation
  // silently restarted the prerelease counter at .0 and published over it.
  for (const [stepName] of DERIVATION_STEPS) {
    test(`"${stepName}" fails the job when npm view fails for a non-404 reason`, () => {
      const run = runDerivation(stepName, '@stonyx/oauth', { npm: REGISTRY_OUTAGE });

      assert.notEqual(run.status, 0, 'a registry outage must fail the job, not fall back to the local version');
      assert.match(run.stderr, /ENETUNREACH|npm view .* failed/, 'the diagnostic must reach stderr');
      assert.equal(run.output.trim(), '', 'no version may be emitted from a failed lookup');
    });

    // ...and the one case the fallback exists for must keep working, or the
    // first publish of a new package breaks in all eleven repos.
    test(`"${stepName}" still falls back to the local version on a genuine E404`, () => {
      const run = runDerivation(stepName, '@stonyx/oauth', { npm: NOT_PUBLISHED });

      assert.equal(run.status, 0, `an unpublished package is not an error; stderr was:\n${run.stderr}`);
      const channel = stepName.includes('alpha') ? 'alpha' : 'beta';
      assert.equal(run.output.trim(), `version=0.1.1-${channel}.0`);
    });
  }

  test(`"${DEPS_STEP}" fails the job when npm view fails for a non-404 reason`, () => {
    const run = runStep(DEPS_STEP, {
      packageJson: { name: '@stonyx/orm', version: '0.3.0', dependencies: { '@stonyx/cron': '^0.1.0' } },
      npm: REGISTRY_OUTAGE,
    });

    assert.notEqual(run.status, 0, 'a transient npm failure must not be swallowed into "not found on npm"');
    assert.match(run.stderr, /ENETUNREACH|npm view .* failed/);
  });

  test(`"${DEPS_STEP}" still skips a dependency that is genuinely absent`, () => {
    const run = runStep(DEPS_STEP, {
      packageJson: { name: '@stonyx/orm', version: '0.3.0', dependencies: { '@stonyx/cron': '^0.1.0' } },
      npm: NOT_PUBLISHED,
    });

    assert.equal(run.status, 0, `E404 is "not published", not a failure; stderr was:\n${run.stderr}`);
    assert.equal(run.packageJson.dependencies['@stonyx/cron'], '^0.1.0', 'an absent dependency is left alone');
  });
});

describe('AC4 -- npm naming grammar is enforced before any sink (#32)', () => {
  // Not a restatement of AC1/AC2: those pin the two exploit payloads, this
  // pins the grammar itself, so a validator narrowed to "reject quotes" (which
  // would keep AC1 green) still reds here.
  for (const [stepName] of DERIVATION_STEPS) {
    for (const [label, name] of Object.entries(ILLEGAL_NAMES)) {
      test(`"${stepName}" rejects a name that ${label}`, () => {
        const run = runDerivation(stepName, name);
        assert.notEqual(run.status, 0, `${JSON.stringify(name)} is not a legal npm package name`);
        assert.deepEqual(run.canaries, []);
      });
    }
  }

  for (const name of LEGAL_NAMES) {
    test(`"${ALPHA_STEP}" accepts the legal name ${JSON.stringify(name)}`, () => {
      const run = runDerivation(ALPHA_STEP, name);
      assert.equal(run.status, 0, `${name} must be accepted; stderr was:\n${run.stderr}`);
    });
  }
});

// The SUBSTITUTION half of AC5 -- structural by construction, stated rather
// than papered over.
//
// `actions/github-script` receives its `script:` after the runner has already
// substituted `${{ }}` expressions into the text. That substitution happens in
// the runner, before the JS is parsed, and there is no offline implementation
// of it: nothing in this repo can evaluate a GitHub Actions expression. So the
// pre-fix shape of these two sinks cannot be reproduced here.
//
// What is asserted instead is the property that makes the sink impossible: no
// `${{ }}` expression appears inside the script text at all, an `env:` mapping
// carries the values, and the script reads them from `process.env`.
//
// The BEHAVIOUR half is a separate describe block below and it is executed --
// once no expression remains, the script body is plain JavaScript.
describe('AC5 -- S3/S5: no expression reaches either github-script body (#32)', () => {
  const SINKS = [
    { workflow: 'npm-publish.yml', step: COMMENT_STEP, vars: { PACKAGE_NAME: 'package-name', PUBLISHED_VERSION: 'package-version' } },
    { workflow: 'cascade.yml', step: DISPATCH_STEP, vars: { PACKAGE_NAME: 'package-name', PUBLISHED_VERSION: 'published-version' } },
  ];

  for (const { workflow, step, vars } of SINKS) {
    // Guards the extractor: if stepScriptBody silently returned '' every
    // assertion below would pass against an empty string.
    test(`${workflow} "${step}" has a substantial script: block`, () => {
      assert.ok(stepScriptBody(WORKFLOWS[workflow], step).length > 100, 'script body should be substantial');
    });

    test(`${workflow} "${step}" interpolates no expression into JS source`, () => {
      const script = stepScriptBody(WORKFLOWS[workflow], step);
      assert.ok(
        !script.includes('${{'),
        `a \${{ }} expression inside the script becomes JS source text before the script is parsed:\n${script}`,
      );
    });

    test(`${workflow} "${step}" passes its values through env: and reads process.env`, () => {
      const env = stepEnv(WORKFLOWS[workflow], step);
      const script = stepScriptBody(WORKFLOWS[workflow], step);

      for (const [key, source] of Object.entries(vars)) {
        assert.ok(env[key], `step should declare env.${key}; got ${JSON.stringify(env)}`);
        assert.match(env[key], new RegExp(`\\$\\{\\{.*${source}.*\\}\\}`), `env.${key} should carry the ${source} value`);
        assert.ok(script.includes(`process.env.${key}`), `script should read process.env.${key}`);
      }
    });
  }

  // S5 is the critical half: this script runs with the org-level CASCADE_PAT,
  // not the repo-bound OIDC identity. Pin the token wiring so a future edit
  // cannot quietly move the script off that credential -- or onto a wider one.
  test('cascade.yml dispatch still runs under CASCADE_PAT', () => {
    const step = parseSteps(cascade).find((s) => s.name === DISPATCH_STEP);
    assert.match(step.body, /github-token: \$\{\{ secrets\.CASCADE_PAT \}\}/);
  });
});

// The BEHAVIOUR half of AC5, EXECUTED.
//
// This block replaces an `assert.match(script, /throw new Error/)`, which was
// green against all four of: deleting the package-name guard, deleting the
// published-version guard, keeping a guard but weakening its regex to
// always-match, and keeping both guards verbatim but moving them below the
// dispatch loop. It asserted that the string `throw` survived somewhere, which
// is not the property anyone cares about.
//
// The accepted AC5 limit is about `${{ }}` SUBSTITUTION, which has no offline
// engine. It does not extend to what the guards do afterwards: because the fix
// removed every expression from this body, the body is plain JavaScript, and
// `actions/github-script` runs it as the body of an async function with
// `require`, `github`, `context` and `core` in scope. So that is what happens
// here -- the real `script:` text, a stubbed `github` client that records
// rather than dispatches, zero dependencies, no network, nothing published.
describe('AC5 -- S5: cascade.yml refuses hostile input before it dispatches (#32, executed)', () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const nodeRequire = createRequire(import.meta.url);
  const DEP_MAP_URL = new URL('../dependency-map.json', import.meta.url);

  /**
   * Run the real dispatch script the way `actions/github-script` runs it.
   *
   * `require` is shimmed for one reason only: the script reads
   * `dependency-map.json` by a path relative to the runner's checkout root, and
   * this keeps the case independent of the test process's cwd. Everything else
   * is the real module.
   */
  async function runDispatch({ packageName, publishedVersion = '0.1.1-beta.128' }) {
    const script = dedent(stepScriptBody(cascade, DISPATCH_STEP));
    const dispatched = [];
    const logged = [];

    const github = {
      rest: {
        repos: {
          createDispatchEvent: async (args) => { dispatched.push(args); return { status: 204 }; },
        },
      },
    };
    const scriptRequire = (id) => {
      const mod = nodeRequire(id);
      if (id !== 'fs' && id !== 'node:fs') return mod;
      return {
        ...mod,
        readFileSync: (path, ...rest) => mod.readFileSync(path === 'dependency-map.json' ? DEP_MAP_URL : path, ...rest),
      };
    };
    const consoleStub = { log: (...args) => logged.push(args.join(' ')), error: (...args) => logged.push(args.join(' ')) };

    const previous = { PACKAGE_NAME: process.env.PACKAGE_NAME, PUBLISHED_VERSION: process.env.PUBLISHED_VERSION };
    const apply = (key, value) => { if (value === undefined) delete process.env[key]; else process.env[key] = value; };
    apply('PACKAGE_NAME', packageName);
    apply('PUBLISHED_VERSION', publishedVersion);

    let error = null;
    try {
      const fn = new AsyncFunction('require', 'github', 'context', 'core', 'console', script);
      await fn(scriptRequire, github, {}, {}, consoleStub);
    } catch (e) {
      error = e;
    } finally {
      apply('PACKAGE_NAME', previous.PACKAGE_NAME);
      apply('PUBLISHED_VERSION', previous.PUBLISHED_VERSION);
    }

    return { error, dispatched, logged, repos: dispatched.map((d) => `${d.owner}/${d.repo}`) };
  }

  // The happy path first, so every hostile case below is known to be running
  // against a harness that CAN dispatch. Without this the whole block could
  // pass by never reaching the API at all.
  test('a legal package name still dispatches to exactly its mapped dependents', async () => {
    const one = await runDispatch({ packageName: '@stonyx/logs' });
    assert.equal(one.error, null, `legal input must not throw: ${one.error && one.error.message}`);
    assert.deepEqual(one.repos, ['abofs/stonyx']);

    const six = await runDispatch({ packageName: 'stonyx' });
    assert.equal(six.error, null);
    assert.deepEqual(six.repos, [
      'abofs/stonyx-cron',
      'abofs/stonyx-rest-server',
      'abofs/stonyx-oauth',
      'abofs/stonyx-orm',
      'abofs/stonyx-discord',
      'abofs/stonyx-sockets',
    ]);
  });

  test('the dispatched payload still carries the source package and version', async () => {
    const { dispatched } = await runDispatch({ packageName: '@stonyx/logs', publishedVersion: '0.1.1-beta.128' });

    assert.deepEqual(dispatched, [{
      owner: 'abofs',
      repo: 'stonyx',
      event_type: 'cascade-publish',
      client_payload: { source_package: '@stonyx/logs', source_version: '0.1.1-beta.128' },
    }]);
  });

  for (const [label, name] of Object.entries(ILLEGAL_NAMES)) {
    test(`a package-name that ${label} throws before any dispatch`, async () => {
      const { error, dispatched } = await runDispatch({ packageName: name });

      assert.notEqual(error, null, `${JSON.stringify(name.slice(0, 40))} must be refused, not indexed into the map`);
      assert.match(error.message, /is not a valid npm package name/);
      assert.deepEqual(dispatched, [], 'createDispatchEvent must never be reached with an unvalidated name');
    });
  }

  test('an absent package-name throws rather than dispatching', async () => {
    const { error, dispatched } = await runDispatch({ packageName: undefined });

    assert.notEqual(error, null);
    assert.match(error.message, /is not a valid npm package name/);
    assert.deepEqual(dispatched, []);
  });

  for (const name of LEGAL_NAMES) {
    test(`the legal package name ${JSON.stringify(name)} is not refused`, async () => {
      const { error } = await runDispatch({ packageName: name });
      assert.equal(error, null, `${name} must be accepted; threw: ${error && error.message}`);
    });
  }

  // The version guard is independently reachable: a name that passes must not
  // carry a hostile version through on its coat-tails.
  const ILLEGAL_VERSIONS = {
    'is empty': '',
    'is not a version at all': 'latest',
    'contains a newline': '0.1.1-beta.128\nmalicious=1',
    'carries a shell payload': '1.0.0; touch /tmp/PWNED_CASCADE',
    'breaks out of a JS string literal': `1.0.0'; throw new Error("owned"); const zz='`,
    'is only a partial version': '0.1',
  };
  for (const [label, version] of Object.entries(ILLEGAL_VERSIONS)) {
    test(`a published-version that ${label} throws before any dispatch`, async () => {
      const { error, dispatched } = await runDispatch({ packageName: '@stonyx/logs', publishedVersion: version });

      assert.notEqual(error, null, `${JSON.stringify(version)} must be refused`);
      assert.match(error.message, /is not a valid semver version/);
      assert.deepEqual(dispatched, [], 'createDispatchEvent must never be reached with an unvalidated version');
    });
  }

  for (const version of ['0.1.1-beta.128', '1.2.3', 'v1.2.3', '0.1.1-beta.1+build.5']) {
    test(`the legal published-version ${JSON.stringify(version)} still dispatches`, async () => {
      const { error, repos } = await runDispatch({ packageName: '@stonyx/logs', publishedVersion: version });
      assert.equal(error, null, `${version} must be accepted; threw: ${error && error.message}`);
      assert.deepEqual(repos, ['abofs/stonyx']);
    });
  }

  // `depMap[packageName]` is a bare object index. The grammar rejects
  // `__proto__` outright; `constructor` and `toString` pass it and resolve to
  // inherited functions, which the `!entry.dependents` early return catches.
  // Pinned because the early return is the only thing standing between them
  // and `entry.dependents.map`.
  for (const key of ['constructor', 'toString', 'valueOf']) {
    test(`the inherited key ${JSON.stringify(key)} dispatches nothing`, async () => {
      const { error, dispatched } = await runDispatch({ packageName: key });
      assert.equal(error, null, 'an inherited key is a legal npm name, so it must not throw');
      assert.deepEqual(dispatched, [], 'an inherited Object.prototype member is not a dependency-map entry');
    });
  }

  test('__proto__ is refused by the grammar', async () => {
    const { error, dispatched } = await runDispatch({ packageName: '__proto__' });
    assert.notEqual(error, null);
    assert.match(error.message, /is not a valid npm package name/);
    assert.deepEqual(dispatched, []);
  });
});

// The anti-drift sweep, and the only mechanism enforcing this suite's
// one-sentence rule. It used to iterate `npm-publish.yml` alone -- one of the
// five workflow files in the repo -- so adding a `${{ inputs.package-name }}`
// shell sink to `cascade.yml`, or a second `${{ inputs.audit-level }}` sink to
// `security-audit.yml`, left the suite fully green. The rule is about this
// repo's workflows, not about one file of them, and a file added later must
// inherit it without anyone remembering to opt in.
describe('no workflow in this repo interpolates a consumer string into program text (#32)', () => {
  const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);
  const FILES = readdirSync(WORKFLOW_DIR).filter((name) => name.endsWith('.yml')).sort();

  // Named exceptions only, and each one is pinned to a step and to an exact
  // occurrence count -- otherwise "this expression is tolerated in this file"
  // silently tolerates a SECOND copy of it, or the same expression appearing
  // in a step that has nothing to do with the recorded reason.
  const ALLOWLIST = {
    'npm-publish.yml': [{
      step: 'Install dependencies',
      expression: "${{ inputs.cascade-source != '' && '--no-frozen-lockfile' || '--frozen-lockfile' }}",
      occurrences: 1,
      why: 'Both arms are fixed literals selected by a boolean. No consumer string can reach the shell through it.',
    }],
    'security-audit.yml': [{
      step: 'Run security audit',
      expression: '${{ inputs.audit-level }}',
      occurrences: 1,
      why: 'KNOWN OPEN SINK, tracked as abofs/stonyx-workflows#34. A workflow_call input interpolated into a shell '
        + 'run: body -- the same defect class this suite closes, in a third file outside #32 two-file scope. '
        + 'Reported and tracked, not fixed here. When #34 lands, delete this entry.',
    }],
  };

  const exemption = (file, step, expression) => (ALLOWLIST[file] ?? [])
    .find((entry) => entry.step === step && entry.expression === expression);

  const countIn = (body, expression) => body.split(expression).length - 1;

  // Guards the sweep itself: if the directory read ever returned nothing, or a
  // file were renamed out from under it, every per-file case below would pass
  // by iterating an empty list.
  test('every workflow file in the repo is swept', () => {
    assert.deepEqual(FILES, ['cascade.yml', 'ci.yml', 'npm-publish.yml', 'security-audit.yml', 'self-ci.yml']);
  });

  for (const file of FILES) {
    test(`no run: body in ${file} interpolates anything but its allowlisted expressions`, () => {
      const text = readWorkflow(file);
      for (const step of parseSteps(text)) {
        let body;
        try {
          body = stepRunBody(text, step.name);
        } catch {
          // A `uses:` step. Its `with:` values are action inputs rather than
          // shell or JS source; the `script:` sweep below covers the ones that
          // do carry program text.
          continue;
        }
        for (const expression of new Set(body.match(/\$\{\{[^}]*\}\}/g) ?? [])) {
          const entry = exemption(file, step.name, expression);
          assert.ok(
            entry,
            `${file} step ${JSON.stringify(step.name)} interpolates ${expression} into shell source`,
          );
          assert.equal(
            countIn(body, expression),
            entry.occurrences,
            `${file} step ${JSON.stringify(step.name)} interpolates ${expression} `
            + `${countIn(body, expression)} time(s); the allowlist exempts ${entry.occurrences}`,
          );
        }
      }
    });

    test(`no github-script body in ${file} interpolates anything at all`, () => {
      const text = readWorkflow(file);
      for (const step of parseSteps(text)) {
        let script;
        try {
          script = stepScriptBody(text, step.name);
        } catch {
          continue; // no `script:` block on this step
        }
        assert.equal(
          script.match(/\$\{\{[^}]*\}\}/g),
          null,
          `${file} step ${JSON.stringify(step.name)} interpolates an expression into JS source`,
        );
      }
    });
  }

  test('no allowlist entry is dead -- a fixed sink must lose its exemption', () => {
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      const text = readWorkflow(file);
      for (const { step, expression, occurrences, why } of entries) {
        const body = stepRunBody(text, step);
        assert.equal(
          countIn(body, expression),
          occurrences,
          `${file} step ${JSON.stringify(step)} no longer interpolates ${expression} ${occurrences} time(s); `
          + `delete or correct its allowlist entry. Recorded reason was: ${why}`,
        );
      }
    }
  });
});

// The grammar is a security contract for eleven repos and it is stated eight
// times as eight string literals -- five copies of the npm name regex, three of
// the semver regex -- because the steps that need it run before any checkout of
// this repo exists on disk, so `scripts/` is genuinely unreachable from them.
// Extraction is not available; pinning the copies together is.
describe('the duplicated grammar literals do not drift apart (#32)', () => {
  /** Every regex literal in `text` that starts with `opener` and ends at `$/` plus flags. */
  function grammarLiterals(text, opener) {
    const found = [];
    for (let i = 0; ;) {
      const start = text.indexOf(opener, i);
      if (start === -1) return found;
      const end = text.indexOf('$/', start);
      if (end === -1) throw new Error(`unterminated regex literal at offset ${start}`);
      let after = end + 2;
      while (/[a-z]/.test(text[after] ?? '')) after++;
      found.push(text.slice(start, after));
      i = after;
    }
  }

  const nameLiterals = [
    ...grammarLiterals(npmPublish, '/^(?:@').map((literal) => ['npm-publish.yml', literal]),
    ...grammarLiterals(cascade, '/^(?:@').map((literal) => ['cascade.yml', literal]),
  ];

  test('all five copies of the npm name grammar are string-identical', () => {
    assert.equal(
      nameLiterals.length,
      5,
      `expected the four npm-publish.yml validators plus cascade.yml's; found ${JSON.stringify(nameLiterals)}`,
    );
    const [[, first]] = nameLiterals;
    for (const [file, literal] of nameLiterals) {
      assert.equal(literal, first, `the name grammar in ${file} has drifted from the others`);
    }
    assert.equal(first, '/^(?:@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*$/i');
  });

  test('every name-grammar site also carries the 214-character npm bound', () => {
    const bounds = [npmPublish, cascade]
      .map((text) => (text.match(/\.length > 214/g) ?? []).length)
      .reduce((a, b) => a + b, 0);

    assert.equal(bounds, nameLiterals.length, 'a regex site without the length bound accepts a name npm cannot host');
  });

  // The semver copies are deliberately two families, not one: a `package.json`
  // `version` can never legitimately be `v`-prefixed, while `custom-version`
  // and `published-version` are consumer-supplied tag-shaped strings and do
  // accept it. That asymmetry is documented in the README; what is pinned here
  // is that it is the ONLY difference between the copies.
  const semverWithV = [
    ...grammarLiterals(npmPublish, '/^v?\\d+').map((literal) => ['npm-publish.yml', literal]),
    ...grammarLiterals(cascade, '/^v?\\d+').map((literal) => ['cascade.yml', literal]),
  ];
  const semverWithoutV = grammarLiterals(npmPublish, '/^\\d+').map((literal) => ['npm-publish.yml', literal]);

  test('the three copies of the semver grammar differ only by the optional leading v', () => {
    assert.equal(semverWithV.length, 2, `expected custom-version and published-version; found ${JSON.stringify(semverWithV)}`);
    assert.equal(semverWithoutV.length, 1, `expected exactly one package.json version grammar; found ${JSON.stringify(semverWithoutV)}`);

    const [[, withV]] = semverWithV;
    for (const [file, literal] of semverWithV) {
      assert.equal(literal, withV, `the semver grammar in ${file} has drifted from the other input validator`);
    }
    assert.equal(
      semverWithoutV[0][1],
      withV.replace('v?', ''),
      'the package.json version grammar must be the input grammar minus the optional leading v, and nothing else',
    );
    assert.equal(withV, '/^v?\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/');
  });
});

describe('AC6 -- S4: $GITHUB_OUTPUT line injection (#32)', () => {
  // Red state, measured on a6e8a9e: `echo "name=$(node -p ...)"` renders a
  // newline in the JSON value as a real newline, so the value forges
  // additional `key=value` lines. Those keys then feed S3 and S5.
  test(`"${NAME_STEP}" cannot be made to forge extra output keys`, () => {
    const run = runStep(NAME_STEP, { packageJson: { name: OUTPUT_FORGERY, version: '0.1.0' } });

    assert.ok(
      !run.output.includes('malicious=1') && !run.output.includes('9.9.9-EVIL'),
      `a package name forged output keys:\n${run.output}`,
    );
    assert.notEqual(run.status, 0, 'a name that is not a legal npm package name must fail the step');
    assert.match(run.stderr, /not a valid npm package name/);
  });

  test(`"${VERSION_STEP}" cannot be made to forge extra output keys`, () => {
    const run = runStep(VERSION_STEP, { packageJson: { name: '@stonyx/oauth', version: '0.1.0\nmalicious=1' } });

    assert.ok(!run.output.includes('malicious=1'), `a package version forged output keys:\n${run.output}`);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /not a valid semver version/);
  });

  test(`"${NAME_STEP}" still emits exactly the name for a valid package`, () => {
    const run = runStep(NAME_STEP, { packageJson: { name: '@stonyx/oauth', version: '0.1.0' } });

    assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);
    assert.deepEqual(run.outputKeys, ['name=@stonyx/oauth']);
  });

  test(`"${VERSION_STEP}" still emits exactly the version for a valid package`, () => {
    const run = runStep(VERSION_STEP, { packageJson: { name: '@stonyx/oauth', version: '0.1.1-alpha.22' } });

    assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);
    assert.deepEqual(run.outputKeys, ['version=0.1.1-alpha.22']);
  });
});

describe('AC7 -- S6: custom-version shell interpolation (#32)', () => {
  // Dispatch-only, and workflow_dispatch on abofs/stonyx* is frozen -- folded
  // in anyway, because there is no lower-concern bucket for a finding in a
  // defect class that is being closed.
  //
  // Red state: `pnpm version ${{ inputs.custom-version }} --no-git-tag-version`
  // substitutes the input into shell source, so `;` starts a second command.
  test('a shell-metacharacter custom-version does not execute and fails the step', () => {
    const run = runStep(CUSTOM_STEP, { env: { CUSTOM_VERSION: '1.0.0; touch "$CANARY_DIR/PWNED_CUSTOM"' } });

    assert.deepEqual(run.canaries, [], 'the dispatch input must never become shell source');
    assert.notEqual(run.status, 0, 'an illegal version must fail the step');
    assert.match(run.stderr, /not a valid semver version/);
    assert.equal(run.pnpmArgs, '', 'pnpm must not be reached with an unvalidated version');
  });

  test('a $(...) custom-version does not execute', () => {
    const run = runStep(CUSTOM_STEP, { env: { CUSTOM_VERSION: '$(touch "$CANARY_DIR/PWNED_CUSTOM")' } });

    assert.deepEqual(run.canaries, []);
    assert.notEqual(run.status, 0);
  });

  for (const version of ['1.2.3', '0.1.1-beta.128', 'patch', 'minor', 'major', 'prerelease']) {
    test(`a valid custom version ${JSON.stringify(version)} still reaches pnpm version unchanged`, () => {
      const run = runStep(CUSTOM_STEP, { env: { CUSTOM_VERSION: version } });

      assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);
      assert.equal(run.pnpmArgs, `version ${version} --no-git-tag-version`);
    });
  }
});

// Beyond the seven sinks the issue inventories.
//
// These were found by sweeping every `run:` body in npm-publish.yml for a
// GitHub Actions expression rather than by working the list, and they are the
// same shape as S6: a value the same actor controls, interpolated into shell
// source. They are separated out here so a reviewer can weigh them
// independently of AC1-AC7.
describe('Beyond AC1-AC7 -- same-shape sinks found while sweeping the file (#32)', () => {
  const TYPE_STEP = 'Determine version bump type';
  const COMMIT_BETA_STEP = 'Commit version bump and create tag (beta)';

  test(`"${TYPE_STEP}" does not execute a payload in cascade-source`, () => {
    const run = runStep(TYPE_STEP, { env: { CASCADE_SOURCE: '@stonyx/x"; touch "$CANARY_DIR/PWNED_TYPE"; :"' } });

    assert.deepEqual(run.canaries, [], 'a workflow_call input must never become shell source');
    assert.equal(run.status, 0);
    assert.deepEqual(run.outputKeys, ['type=beta'], 'a cascade is still a beta publish');
  });

  test(`"${TYPE_STEP}" cannot be made to forge extra output keys through version-type`, () => {
    const run = runStep(TYPE_STEP, { env: { VERSION_TYPE: 'patch\nmalicious=1' } });

    assert.ok(!run.output.includes('malicious=1'), `version-type forged output keys:\n${run.output}`);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /version-type must be one of/);
  });

  // The truth table is the thing that must not move: it decides the release
  // channel for every publish in all eleven consumer repos.
  for (const [label, env, expected] of [
    ['a cascade', { CASCADE_SOURCE: '@stonyx/cron' }, 'type=beta'],
    ['a pull request', { EVENT_NAME: 'pull_request' }, 'type=alpha'],
    ['a push to main', { EVENT_NAME: 'push', GIT_REF: 'refs/heads/main' }, 'type=stable'],
    ['a push to any other branch', { EVENT_NAME: 'push', GIT_REF: 'refs/heads/dev' }, 'type=beta'],
    ['a dispatch with a custom version', { EVENT_NAME: 'workflow_dispatch', CUSTOM_VERSION: '1.2.3' }, 'type=custom'],
    ['a dispatch with a version type', { EVENT_NAME: 'workflow_dispatch', VERSION_TYPE: 'minor' }, 'type=minor'],
  ]) {
    test(`"${TYPE_STEP}" still resolves ${label} to ${expected}`, () => {
      const run = runStep(TYPE_STEP, { env });
      assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);
      assert.deepEqual(run.outputKeys, [expected]);
    });
  }

  // The fix moves values out of shell source and into step `env:` mappings,
  // each with a comment saying why. `stepEnv` is the helper that reads those
  // mappings back, so it has to survive the YAML the fix writes -- it threw on
  // a comment inside an `env:` block, and the obvious "fix" for that exception
  // would have been to delete the comment documenting the sink.
  test(`"${COMMIT_BETA_STEP}" declares its env: mapping and stepEnv reads it past the comment`, () => {
    assert.deepEqual(stepEnv(npmPublish, COMMIT_BETA_STEP), {
      BRANCH: '${{ github.ref_name }}',
      PUBLISHED_VERSION: '${{ steps.package-version.outputs.version }}',
    });
  });

  test('stepEnv reads every step in both workflows without throwing', () => {
    for (const [workflow, text] of Object.entries(WORKFLOWS)) {
      for (const step of parseSteps(text)) {
        assert.doesNotThrow(
          () => stepEnv(text, step.name),
          `stepEnv threw on ${workflow} step ${JSON.stringify(step.name)}`,
        );
      }
    }
  });

  test(`"${COMMIT_BETA_STEP}" does not execute a payload in the branch name`, () => {
    const run = runStep(COMMIT_BETA_STEP, {
      env: { BRANCH: 'dev"; touch "$CANARY_DIR/PWNED_BRANCH"; :"', PUBLISHED_VERSION: '0.1.1-beta.128' },
    });

    assert.deepEqual(run.canaries, [], 'a branch name must never become shell source');
    // git is stubbed, so the step succeeds; what is asserted is that the whole
    // branch name arrived as ONE argument to `git push`.
    assert.equal(run.status, 0, `stderr was:\n${run.stderr}`);
    assert.ok(
      run.gitArgs.some((args) => args[0] === 'push' && args.at(-1) === 'dev"; touch "$CANARY_DIR/PWNED_BRANCH"; :"'),
      `branch name was split or expanded: ${JSON.stringify(run.gitArgs)}`,
    );
  });

  // Quoting closes command injection; it does not close argument injection.
  // Measured against real git 2.50: `git update-ref refs/heads/--force HEAD`
  // succeeds where `git branch` refuses, and `git push origin '--force' --tags`
  // then consumes the branch name as a FLAG -- a force-push of tags. Both
  // invocations must therefore terminate option parsing before the ref.
  test(`"${COMMIT_BETA_STEP}" passes an option-shaped branch name after --end-of-options`, () => {
    const run = runStep(COMMIT_BETA_STEP, { env: { BRANCH: '--force', PUBLISHED_VERSION: '0.1.1-beta.128' } });

    assert.equal(run.status, 0, `stderr was:\n${run.stderr}`);
    for (const args of run.gitArgs.filter((a) => a[0] === 'pull' || a[0] === 'push')) {
      const terminator = args.indexOf('--end-of-options');
      assert.notEqual(terminator, -1, `git ${args[0]} must terminate option parsing: ${JSON.stringify(args)}`);
      assert.equal(args[terminator + 1], '--force', 'the branch name must be the first argument after the terminator');
      assert.equal(args.length, terminator + 2, 'nothing may follow the branch name and be re-read as a refspec');
    }
  });

  test(`"${COMMIT_BETA_STEP}" still tags and pushes the published version`, () => {
    const run = runStep(COMMIT_BETA_STEP, { env: { BRANCH: 'dev', PUBLISHED_VERSION: '0.1.1-beta.128' } });

    assert.equal(run.status, 0, `stderr was:\n${run.stderr}`);
    assert.deepEqual(run.gitArgs, [
      ['add', 'package.json', 'pnpm-lock.yaml'],
      ['commit', '-m', 'chore: release v0.1.1-beta.128 [skip ci]'],
      ['tag', 'v0.1.1-beta.128'],
      ['pull', '--rebase', '--autostash', 'origin', '--end-of-options', 'dev'],
      ['push', '--tags', 'origin', '--end-of-options', 'dev'],
    ]);
  });
});
