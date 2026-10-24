import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  MissingStepKeyError, onKeys, parseSteps, readWorkflow, runBodyOf, stepEnv, stepNamed, stepRunBody, workflowPath,
} from './helpers/workflow-yaml.js';

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
    // The publish steps are located by their EXECUTED `run:` body with comment
    // lines removed, not by a substring of the whole step body. The whole-body
    // form found the first step whose YAML happened to contain the characters
    // `pnpm publish` -- which, once abofs/stonyx-workflows#35 added a comment to
    // the checkout step naming the lifecycle hooks that run consumer code, was
    // step 0, and this assertion red on a documentation comment. A step's
    // comments are not things it does.
    //
    // The token within that body is also not `.includes('pnpm publish')`. That
    // form misses `npm publish`, `pnpm -r publish` and `yarn publish`, all of
    // which publish this package to the same registry -- so a publish step
    // added in any of those shapes would make `findIndex` return -1 and this
    // assertion pass vacuously, the cleanup "preceding" a step the reader
    // cannot see. Both halves are load-bearing: the run-body restriction stops
    // a comment from matching, the widened token stops a real publish from
    // hiding.
    const PUBLISH_COMMAND = /\b(?:p?npm|yarn)\b[^\n]*\bpublish\b/;
    const runsPublish = (step) => {
      let body;
      try {
        body = runBodyOf(step);
      } catch (err) {
        if (err.code === MissingStepKeyError.CODE) return false;
        throw err;
      }
      return body.split('\n').some((line) => !line.trim().startsWith('#') && PUBLISH_COMMAND.test(line));
    };

    const firstPublish = steps.findIndex(runsPublish);
    assert.notEqual(firstPublish, -1, 'npm-publish.yml must contain a publish step for this ordering to mean anything');
    assert.ok(
      steps.indexOf(cleanup) < firstPublish,
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

// abofs/stonyx#122 part 2: the docs-import check runs in the reusable ci.yml.
// Every consumer calls ci.yml@main, so these assertions are what stands
// between an edit here and a silently unchecked (or credentialed) check in
// ten repos at once.

const ci = readWorkflow('ci.yml');

const DOC_STEPS = {
  install: 'Install dependencies',
  build: 'Build',
  ref: 'Resolve stonyx-workflows ref',
  checkout: 'Checkout stonyx-workflows (for docs-import check)',
  tooling: 'Install docs-import check tooling',
  registry: 'Install stonyx packages the docs import but the repo does not declare',
  check: 'Check doc imports',
};

/** A step's `with:` (or other single-level mapping) entries, comments skipped. */
function mappingOf(step, key) {
  const lines = step.body.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s*${key}:\\s*$`).test(l));
  if (at === -1) return null;
  const indent = lines[at].match(/^ */)[0].length;
  const out = {};
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line.match(/^ */)[0].length <= indent) break;
    const m = line.match(/^\s*([\w-]+):\s*(.*)$/);
    assert.ok(m, `unreadable ${key}: line in ${step.name}: ${line}`);
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** A top-level `key: value` of the step itself (uses:, id:, working-directory:). */
function stepKey(step, key) {
  const lines = step.body.split('\n').filter((l) => l.trim() !== '');
  const indent = Math.min(...lines.map((l) => l.match(/^ */)[0].length));
  const line = lines.find((l) => l.match(/^ */)[0].length === indent && l.trim().startsWith(`${key}:`));
  return line ? line.trim().slice(key.length + 1).trim() : null;
}

describe('ci.yml runs check-doc-imports (abofs/stonyx#122 part 2)', () => {
  test('the docs-import steps exist once each, in order, after install', () => {
    const names = parseSteps(ci).map((s) => s.name);
    const positions = Object.values(DOC_STEPS).map((n) => {
      assert.equal(names.filter((x) => x === n).length, 1, `exactly one step named ${n}`);
      return names.indexOf(n);
    });
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b), `steps out of order: ${names.join(' | ')}`);
  });

  test('ci.yml builds before the check (the repo resolves itself through dist/)', () => {
    assert.equal(stepRunBody(ci, DOC_STEPS.build).trim(), 'pnpm run --if-present build');
  });

  test('the tooling ref is job.workflow_sha, and an empty one fails the job', () => {
    const step = stepNamed(ci, DOC_STEPS.ref);
    assert.equal(stepKey(step, 'id'), 'workflows-ref');
    assert.equal(stepEnv(ci, DOC_STEPS.ref).WORKFLOW_SHA, '${{ job.workflow_sha }}');
    const body = stepRunBody(ci, DOC_STEPS.ref);
    assert.match(body, /if \[ -z "\$WORKFLOW_SHA" \]; then[\s\S]*exit 1[\s\S]*fi/);
    assert.match(body, /echo "sha=\$WORKFLOW_SHA" >> "\$GITHUB_OUTPUT"/);
  });

  test('stonyx-workflows is checked out at that sha with persist-credentials: false', () => {
    const step = stepNamed(ci, DOC_STEPS.checkout);
    assert.match(stepKey(step, 'uses'), /^actions\/checkout@/);
    assert.deepEqual(mappingOf(step, 'with'), {
      repository: 'abofs/stonyx-workflows',
      ref: '${{ steps.workflows-ref.outputs.sha }}',
      path: '.stonyx-workflows',
      'persist-credentials': 'false',
    });
  });

  test('the tooling TypeScript is installed inside the checked-out tooling dir, with no lifecycle scripts', () => {
    const step = stepNamed(ci, DOC_STEPS.tooling);
    assert.equal(stepKey(step, 'working-directory'), '.stonyx-workflows');
    assert.equal(runBodyOf(step).trim(), 'pnpm install --frozen-lockfile --ignore-scripts --ignore-workspace');
  });

  test('registry packages are installed at @beta into RUNNER_TEMP, never with lifecycle scripts', () => {
    const body = stepRunBody(ci, DOC_STEPS.registry);
    assert.match(body, /^\s*set -euo pipefail$/m);
    assert.match(body, /registry="\$RUNNER_TEMP\/stonyx-doc-registry"/);
    assert.match(body, /node \.stonyx-workflows\/scripts\/doc-registry-packages\.mjs --repo \./);
    assert.match(body, /specs\+=\("\$name@beta"\)/);
    // Every line that names an install, except a message that only mentions one.
    const installs = body.split('\n')
      .filter((l) => /\b(npm|pnpm|yarn)\s+(install|i|add|ci)\b/.test(l) && !/^\s*echo\b/.test(l));
    assert.ok(installs.length >= 1, 'the step must install something');
    for (const line of installs) {
      assert.match(line, /--ignore-scripts/, line);
      assert.match(line, /--prefix "\$registry"/, line);
    }
  });

  test('the check runs the checked-out script against the consumer repo, with the registry dir', () => {
    assert.equal(
      stepRunBody(ci, DOC_STEPS.check).trim(),
      'node .stonyx-workflows/scripts/check-doc-imports.mjs --repo . --resolve-from "$RUNNER_TEMP/stonyx-doc-registry"',
    );
    for (const script of ['scripts/check-doc-imports.mjs', 'scripts/doc-registry-packages.mjs']) {
      assert.ok(existsSync(new URL(`../${script}`, import.meta.url)), `${script} must exist in this repo`);
    }
  });

  test('the job holds no secrets and only a read-only token', () => {
    assert.ok(!/\bsecrets\./.test(ci), 'ci.yml must not reference any secret');
    assert.ok(!/CASCADE_PAT|NPM_TOKEN|NODE_AUTH_TOKEN/.test(ci.replace(/^\s*#.*$/gm, '')), 'no credential names outside comments');
    assert.match(ci, /^permissions:\n {2}contents: read\n/m);
    assert.ok(!/^ +permissions:/m.test(ci), 'no job-level permissions override');
  });

  for (const file of ['npm-publish.yml', 'cascade.yml', 'security-audit.yml', 'self-ci.yml']) {
    test(`${file} does not run the docs-import check (it stays out of credentialed workflows)`, () => {
      const text = readWorkflow(file);
      assert.ok(!text.includes('check-doc-imports'), file);
      assert.ok(!text.includes('doc-registry-packages'), file);
    });
  }
});
