import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
// The seventh (AC5, the two `actions/github-script` sinks) is STRUCTURAL ONLY
// and says so -- see the comment on that describe block. GitHub Actions
// `${{ }}` substitution happens before the script is ever parsed, in the
// runner, and there is no offline engine for it, so no execution of any body
// can reach it. It is not padded out with a mock that would pass regardless.

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
  const ILLEGAL = {
    'leading dot': '.stonyx',
    'leading underscore': '_stonyx',
    'contains a space': '@stonyx/rest server',
    'contains a newline': OUTPUT_FORGERY,
    'contains a backtick': '@stonyx/x`id`',
    'contains a pipe': '@stonyx/x|id',
    'contains a backslash': '@stonyx/x\\u0000',
    'empty': '',
    'over 214 characters': '@stonyx/' + 'a'.repeat(220),
  };

  for (const [stepName] of DERIVATION_STEPS) {
    for (const [label, name] of Object.entries(ILLEGAL)) {
      test(`"${stepName}" rejects a name that ${label}`, () => {
        const run = runDerivation(stepName, name);
        assert.notEqual(run.status, 0, `${JSON.stringify(name)} is not a legal npm package name`);
        assert.deepEqual(run.canaries, []);
      });
    }
  }

  // Guard against the opposite failure: a validator so tight it rejects the
  // repos that actually use this workflow would be a production incident on
  // every one of them.
  const LEGAL = ['@stonyx/oauth', '@stonyx/rest-server', 'stonyx', '@stonyx/logs', 'some.pkg', 'a'];
  for (const name of LEGAL) {
    test(`"${ALPHA_STEP}" accepts the legal name ${JSON.stringify(name)}`, () => {
      const run = runDerivation(ALPHA_STEP, name);
      assert.equal(run.status, 0, `${name} must be accepted; stderr was:\n${run.stderr}`);
    });
  }
});

// STRUCTURAL ONLY, BY CONSTRUCTION -- stated rather than papered over.
//
// `actions/github-script` receives its `script:` after the runner has already
// substituted `${{ }}` expressions into the text. That substitution happens in
// the runner, before the JS is parsed, and there is no offline implementation
// of it: `stepRunBody` cannot execute a `with: script:` block, and nothing in
// this repo can evaluate a GitHub Actions expression. So these two sinks
// cannot be exercised the way S1/S2/S4/S6 are.
//
// What is asserted instead is the property that makes the sink impossible: no
// `${{ }}` expression appears inside the script text at all, an `env:` mapping
// carries the values, and the script reads them from `process.env`. This was
// mutation-checked by restoring `const packageName = '${{ ... }}';` in each
// file and confirming these tests go red; the local substitution PoC that
// stands behind them is recorded in the PR body.
describe('AC5 -- S3/S5: the two github-script sinks (structural only) (#32)', () => {
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
  // cannot quietly reintroduce an interpolation next to it.
  test('cascade.yml dispatch still runs under CASCADE_PAT and validates the name it was handed', () => {
    const step = parseSteps(cascade).find((s) => s.name === DISPATCH_STEP);
    assert.match(step.body, /github-token: \$\{\{ secrets\.CASCADE_PAT \}\}/);
    const script = stepScriptBody(cascade, DISPATCH_STEP);
    assert.match(script, /throw new Error/, 'an illegal package name must abort the dispatch, not index the map with it');
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
