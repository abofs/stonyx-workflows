import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { onKeys, parseSteps, readWorkflow, stepRunBody, workflowPath } from './helpers/workflow-yaml.js';

// Workflow-source assertions for abofs/stonyx-workflows#22 (story A).
//
// AC2 anti-drift: the version derivation must live in scripts/derive-version.mjs
// and npm-publish.yml must CALL it, not carry a second copy of the arithmetic.
// Without this, derive-version-test.js would be validating a transcription that
// silently diverges from the YAML on the next edit -- and an extracted module
// with no caller is a dormant primitive, not a refactor.

const npmPublish = readWorkflow('npm-publish.yml');

const ALPHA_STEP = 'Calculate next alpha version';
const BETA_STEP = 'Calculate next beta version';

// The nine lifted lines named these. If either survives in the YAML, the
// arithmetic was copied rather than moved.
const INLINE_ARITHMETIC = ['nextPatch', "-beta.'", "-alpha.'"];

describe('npm-publish.yml invokes the derivation script (#22 AC2)', () => {
  // Guards the extractor itself: if stepRunBody silently returned '' the
  // assertions below would pass against an empty string.
  test('the two derivation steps are found and have non-trivial run bodies', () => {
    const names = parseSteps(npmPublish).map((s) => s.name);
    assert.ok(names.includes(ALPHA_STEP), `steps should include ${ALPHA_STEP}`);
    assert.ok(names.includes(BETA_STEP), `steps should include ${BETA_STEP}`);
    for (const step of [ALPHA_STEP, BETA_STEP]) {
      assert.ok(stepRunBody(npmPublish, step).length > 100, `${step} run body should be substantial`);
    }
  });

  for (const [step, channel] of [[ALPHA_STEP, 'alpha'], [BETA_STEP, 'beta']]) {
    test(`"${step}" run body calls scripts/derive-version.mjs for the ${channel} channel`, () => {
      const body = stepRunBody(npmPublish, step);
      assert.match(body, /scripts\/derive-version\.mjs/);
      assert.match(body, /deriveVersion\(/);
      // Either quote form: #32 moved these programs inside a single-quoted
      // `node -e '...'` so that nothing in the shell can expand into the
      // program text, which forces double quotes on every JS string literal.
      assert.match(body, new RegExp(`channel: ['"]${channel}['"]`));
    });
  }

  test('neither run body retains inline version arithmetic', () => {
    for (const step of [ALPHA_STEP, BETA_STEP]) {
      const body = stepRunBody(npmPublish, step);
      for (const token of INLINE_ARITHMETIC) {
        assert.ok(!body.includes(token), `${step} run body should not contain ${JSON.stringify(token)}`);
      }
    }
  });

  test('no inline version arithmetic survives anywhere in npm-publish.yml', () => {
    for (const token of INLINE_ARITHMETIC) {
      assert.ok(!npmPublish.includes(token), `npm-publish.yml should not contain ${JSON.stringify(token)}`);
    }
  });

  // The script has to be reachable from the workflow, not merely referenced.
  // npm-publish.yml runs inside the CONSUMER's checkout, so this repo is
  // checked out alongside it; assert both halves of that arrangement.
  test('the referenced script path exists in this repo and exports deriveVersion', () => {
    const body = stepRunBody(npmPublish, BETA_STEP);
    const referenced = body.match(/['"]\.\/([\w./-]*scripts\/derive-version\.mjs)['"]/);
    assert.ok(referenced, 'run body should reference the script by a resolvable relative path');

    const tail = referenced[1].replace(/^\.stonyx-workflows\//, '');
    assert.equal(tail, 'scripts/derive-version.mjs');
    assert.ok(existsSync(new URL(`../${tail}`, import.meta.url)), `${tail} should exist in this repo`);

    const source = readFileSync(new URL(`../${tail}`, import.meta.url), 'utf8');
    assert.match(source, /export function deriveVersion\(/);
  });

  test('npm-publish.yml checks this repo out so the script is on disk at run time', () => {
    const steps = parseSteps(npmPublish);
    const checkout = steps.find((s) => s.body.includes('repository: abofs/stonyx-workflows'));
    assert.ok(checkout, 'a step should check out abofs/stonyx-workflows');
    assert.match(checkout.body, /path: \.stonyx-workflows/);

    // ...and cleans it up again. Note the scope: `npm pack` does pack a
    // dot-prefixed directory at the package root, but all ten current
    // consumers declare a `files` allowlist that excludes it, so this step is
    // defence-in-depth for a consumer that later drops that allowlist -- not
    // the only thing standing between the checkout and a published tarball.
    const cleanup = steps.find((s) => s.body.includes('rm -rf .stonyx-workflows'));
    assert.ok(cleanup, 'a step should remove the .stonyx-workflows checkout before publish');
    assert.ok(
      steps.indexOf(cleanup) < steps.findIndex((s) => s.body.includes('pnpm publish')),
      'cleanup must run before the first publish step',
    );
  });
});

describe('self-ci.yml gates this repo (#22 AC3)', () => {
  test('self-ci.yml exists and its steps parse', () => {
    assert.ok(existsSync(workflowPath('self-ci.yml')), '.github/workflows/self-ci.yml should exist');
    const steps = parseSteps(readWorkflow('self-ci.yml'));
    assert.ok(steps.length > 0, 'self-ci.yml should declare steps');
  });

  // The shape is `push` scoped to `main` plus an unscoped `pull_request`, so a
  // PR gets exactly one run and a merge to main gets exactly one run. What this
  // test pins is that BOTH triggers survive: self-ci.yml must never quietly
  // become PR-only (nothing would gate a direct push to main) or push-only
  // (nothing would gate a PR). It deliberately does not pin the `branches:`
  // filter, so widening `push` back to every branch stays green here -- that
  // regression costs a duplicate check run, not a coverage hole.
  test('its on: keys include both push and pull_request', () => {
    const keys = onKeys(readWorkflow('self-ci.yml'));
    assert.ok(keys.includes('push'), `on: keys ${JSON.stringify(keys)} should include push`);
    assert.ok(keys.includes('pull_request'), `on: keys ${JSON.stringify(keys)} should include pull_request`);
  });

  // The point of the workflow is to run this suite. A self-CI workflow that
  // installs and does nothing else is a green light with no bulb behind it.
  test('it installs with a frozen lockfile and runs pnpm test', () => {
    const body = readWorkflow('self-ci.yml');
    assert.match(body, /pnpm install --frozen-lockfile/);
    assert.match(body, /pnpm test/);
  });

  // Contrast case, and the reason AC3 exists at all: the four pre-existing
  // reusable workflows are workflow_call-only, so a push to this repo produced
  // zero check runs before this story.
  test('the pre-existing reusable workflows remain workflow_call-only', () => {
    for (const name of ['ci.yml', 'npm-publish.yml', 'cascade.yml', 'security-audit.yml']) {
      assert.deepEqual(onKeys(readWorkflow(name)), ['workflow_call'], `${name} triggers`);
    }
  });
});
