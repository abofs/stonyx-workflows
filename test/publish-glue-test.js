import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseSteps, readWorkflow, stepRunBody } from './helpers/workflow-yaml.js';

// Behavioural coverage of the npm-publish.yml derivation glue, for
// abofs/stonyx-workflows#22.
//
// test/workflows-test.js asserts that the YAML *references*
// scripts/derive-version.mjs. That is anti-drift, and it is not coverage of the
// invocation: SME Phase 4 (Test Coverage, HIGH-2) and SME Phase 2 (Framework,
// WARNING-1) between them found four mutations that leave that suite fully
// green while breaking every consumer's publish.
//
//   1. the checkout `ref:` changed to something that does not resolve
//   2. `console.log(...)` dropped from the beta arm
//   3. `console.log` -> `console.error`          (empties NEXT_VERSION on BOTH
//                                                 channels: $( ) captures only
//                                                 stdout)
//   4. the checkout `if:` narrowed to 'alpha'     (breaks every beta publish in
//                                                 all nine consumers)
//
// (2) and (3) are behavioural and are killed below by executing the real `run:`
// body offline against a fake `npm`. (1) and (4) are properties of step
// metadata that no execution of a `run:` body can observe, so they are pinned
// as explicit assertions on the checkout step rather than pretended away.
//
// No network: `npm` and `pnpm` are stubbed on PATH. The derivation script is
// the real one, copied to where the checkout would have put it.

const npmPublish = readWorkflow('npm-publish.yml');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/oauth-registry-state.json', import.meta.url), 'utf8'));

const CHECKOUT_STEP = 'Checkout stonyx-workflows (for version derivation script)';
const RESOLVE_STEP = 'Resolve stonyx-workflows ref';

const stepNamed = (name) => {
  const step = parseSteps(npmPublish).find((s) => s.name === name);
  assert.ok(step, `npm-publish.yml should have a step named ${JSON.stringify(name)}`);
  return step;
};

/**
 * Run one derivation step's real `run:` body in a throwaway directory laid out
 * like a consumer's workspace after the checkout step, and return everything
 * the step wrote to `$GITHUB_OUTPUT` plus the arguments it handed to `pnpm`.
 */
function runDerivationStep(stepName) {
  const body = stepRunBody(npmPublish, stepName);
  const workspace = mkdtempSync(join(tmpdir(), 'wf22-glue-'));

  try {
    const bin = join(workspace, 'bin');
    mkdirSync(bin);
    mkdirSync(join(workspace, '.stonyx-workflows', 'scripts'), { recursive: true });

    // The real script, at the path the checkout step puts it.
    copyFileSync(
      new URL('../scripts/derive-version.mjs', import.meta.url),
      join(workspace, '.stonyx-workflows', 'scripts', 'derive-version.mjs'),
    );

    // A consumer package. The name is what the step reads and interpolates.
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({ name: '@stonyx/oauth', version: '0.1.0' }, null, 2),
    );

    const versionsPath = join(workspace, 'versions.json');
    writeFileSync(versionsPath, JSON.stringify(fixture.versions));

    // Registry stub. Serves the committed fixture; anything else is a hard
    // error, so a step that queried something unexpected cannot pass quietly.
    const npmStub = join(bin, 'npm');
    writeFileSync(npmStub, [
      '#!/bin/sh',
      'if [ "$1" = "view" ] && [ "$3" = "dist-tags.latest" ]; then',
      `  printf '%s\\n' '${fixture.distTags.latest}'`,
      '  exit 0',
      'fi',
      'if [ "$1" = "view" ] && [ "$3" = "versions" ]; then',
      `  cat '${versionsPath}'`,
      '  exit 0',
      'fi',
      'echo "unexpected npm invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'));
    chmodSync(npmStub, 0o755);

    // Records the version the step actually bumped to, so an empty
    // NEXT_VERSION is visible as an argument and not only as an output line.
    const pnpmLog = join(workspace, 'pnpm-args.log');
    const pnpmStub = join(bin, 'pnpm');
    writeFileSync(pnpmStub, ['#!/bin/sh', `printf '%s\\n' "$*" >> '${pnpmLog}'`, 'exit 0', ''].join('\n'));
    chmodSync(pnpmStub, 0o755);

    const githubOutput = join(workspace, 'github-output');
    writeFileSync(githubOutput, '');
    writeFileSync(pnpmLog, '');

    const scriptPath = join(workspace, 'step.sh');
    writeFileSync(scriptPath, body.split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n') + '\n');

    // The shell GitHub Actions uses for a `run:` block.
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
      cwd: workspace,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: githubOutput },
      encoding: 'utf8',
    });

    return {
      status: result.status,
      stderr: result.stderr,
      output: readFileSync(githubOutput, 'utf8').trim(),
      pnpmArgs: readFileSync(pnpmLog, 'utf8').trim(),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('npm-publish.yml derivation glue executes correctly (#22 AC2)', () => {
  for (const [stepName, expected] of [
    ['Calculate next alpha version', '0.1.1-alpha.22'],
    ['Calculate next beta version', '0.1.1-beta.128'],
  ]) {
    test(`"${stepName}" writes version=${expected} to $GITHUB_OUTPUT`, () => {
      const run = runDerivationStep(stepName);

      assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);

      // The whole failure mode this test exists for: an empty NEXT_VERSION
      // still produces a well-formed `version=` line and a zero exit status.
      assert.equal(
        run.output,
        `version=${expected}`,
        'the step must capture the derived version on stdout, not stderr, and must print it at all',
      );

      // ...and the empty value must not reach `pnpm version` either.
      assert.equal(run.pnpmArgs, `version ${expected} --no-git-tag-version`);
    });
  }
});

describe('npm-publish.yml checkout-step invariants (#22 AC2)', () => {
  // The one field that decides whether the checkout resolves at all. Pinning
  // it to the workflow's own commit is what keeps the script and the workflow
  // a single artifact; a literal branch name here is the ref skew that
  // SME Phases 2 and 3 both flagged.
  test('the checkout ref is pinned to the resolved workflow SHA, not a moving branch', () => {
    assert.match(
      stepNamed(CHECKOUT_STEP).body,
      /ref: \$\{\{ steps\.workflows-ref\.outputs\.sha \}\}/,
      'checkout ref must come from the Resolve stonyx-workflows ref step',
    );

    const resolve = stepNamed(RESOLVE_STEP);
    assert.match(resolve.body, /job\.workflow_sha/, 'the ref must be derived from job.workflow_sha');
    // An empty ref makes actions/checkout fall back to the default branch,
    // silently restoring the skew. The step has to fail instead.
    assert.match(resolve.body, /exit 1/, 'an empty job.workflow_sha must fail the job, not fall back');
  });

  // The checkout guard must be a superset of the two step guards. Narrowing it
  // to 'alpha' alone breaks every beta publish across all nine consumers --
  // the beta path being the merge-to-main path, the highest-traffic publish in
  // the org.
  test('the checkout runs on both the alpha and the beta path', () => {
    for (const name of [CHECKOUT_STEP, RESOLVE_STEP]) {
      const { body } = stepNamed(name);
      const guard = body.split('\n').find((l) => /^\s*if:/.test(l));
      assert.ok(guard, `${name} should carry an if: guard`);
      assert.match(guard, /'alpha'/, `${name} must run on the alpha path`);
      assert.match(guard, /'beta'/, `${name} must run on the beta path`);
    }
  });
});
