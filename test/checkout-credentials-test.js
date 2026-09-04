import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  anyPersistingCheckouts,
  checkoutSteps,
  describeViolation,
  persistedCredentialViolations,
  rawCheckoutCount,
} from './helpers/checkout-credentials.js';
import { workflowFileNames } from './helpers/raw-expression-scan.js';
import { stepEnv, stepRunBody } from './helpers/workflow-yaml.js';

// abofs/stonyx-workflows#35 -- the org-level CASCADE_PAT was persisted into the
// workspace and consumer code then ran in the same job.
//
// `workflow-yaml.js` is imported here only where a diagnostic or an EXECUTED
// `run:` body is wanted, which is exactly the two jobs its own header reserves
// for it. THE GUARANTEE below runs on `checkout-credentials.js`, which reads
// raw text and shares no code with that reader.

const WORKFLOWS_DIR = new URL('../.github/workflows/', import.meta.url);
const FILES = workflowFileNames();
const read = (file) => readFileSync(new URL(file, WORKFLOWS_DIR), 'utf8');

const npmPublish = read('npm-publish.yml');

// The token expression the checkout uses in cascade mode. Written out once and
// compared verbatim: the two push steps must be handed THE SAME credential the
// checkout was handed, or the fix has quietly changed which identity pushes.
const CASCADE_TOKEN_EXPR = "${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}";

const PUSH_STEPS = [
  'Commit version bump and create tag (beta)',
  'Commit version bump and create tag (stable)',
];

describe('#35 -- a privileged checkout does not persist its credential', () => {
  // THE POPULATION, before anything is asserted about it. Every check below
  // quantifies over `checkoutSteps`, so a checkout that reader cannot see is
  // silently exempt from all of them -- #37's bypass 6a, where an unnamed step
  // was appended to the previous step's body and the suite stayed green at
  // 185/0. `rawCheckoutCount` counts the same thing off raw text by a
  // mechanism the reader uses nowhere -- occurrences of the action name with
  // comment lines dropped -- so it can see a step shape the reader misses.
  test('every actions/checkout step is found, with the population pinned off raw text', () => {
    assert.deepEqual(FILES, ['cascade.yml', 'ci.yml', 'npm-publish.yml', 'security-audit.yml', 'self-ci.yml']);

    const perFile = Object.fromEntries(FILES.map((f) => [f, checkoutSteps(read(f), f).length]));
    const rawPerFile = Object.fromEntries(FILES.map((f) => [f, rawCheckoutCount(read(f))]));

    assert.deepEqual(perFile, rawPerFile, 'the reader and the raw count must agree about how many checkouts exist');
    assert.deepEqual(perFile, {
      'cascade.yml': 1,
      'ci.yml': 1,
      'npm-publish.yml': 2,
      'security-audit.yml': 1,
      'self-ci.yml': 1,
    }, 'hand-read from the five files; a new checkout has to be added here deliberately');
  });

  // CALIBRATION FOR THE GUARD BELOW. If the reader classified nothing as
  // privileged, the guard would pass on an empty set and say nothing at all --
  // the vacuous-check shape this repo has paid for repeatedly. So the set is
  // named, not counted.
  test('the reader identifies exactly the two checkouts that receive the org PAT', () => {
    const privileged = FILES.flatMap((f) => checkoutSteps(read(f), f)).filter((s) => s.privileged);

    assert.deepEqual(
      privileged.map((s) => [s.file, s.name, s.token]),
      [
        ['cascade.yml', 'Checkout stonyx-workflows (for dependency map)', '${{ secrets.CASCADE_PAT }}'],
        ['npm-publish.yml', 'Checkout code', CASCADE_TOKEN_EXPR],
      ],
      'these are the two checkouts abofs/stonyx-workflows#35 is about',
    );
  });

  // THE GUARD, at the bar AC2 sets.
  test('every checkout taking a token other than github.token sets persist-credentials: false', () => {
    const violations = FILES.flatMap((f) => persistedCredentialViolations(read(f), f));
    assert.deepEqual(violations.map(describeViolation), []);
  });

  // The stricter property this repo actually holds. Nothing in these five
  // workflows reads ambient git credentials -- the only two steps that reach a
  // remote are handed a token explicitly -- so a persisted GITHUB_TOKEN would
  // be a live credential sitting next to consumer lifecycle scripts for no
  // benefit at all.
  test('no checkout in this repo persists a credential, privileged or not', () => {
    const persisting = FILES.flatMap((f) => anyPersistingCheckouts(read(f), f));
    assert.deepEqual(persisting.map(describeViolation), []);
  });

  test('a checkout whose keys are ambiguous is refused, never resolved to the first match', () => {
    const twoTokens = [
      'jobs:',
      '  publish:',
      '    steps:',
      '      - name: Checkout code',
      '        uses: actions/checkout@v4',
      '        with:',
      '          token: ${{ github.token }}',
      '          token: ${{ secrets.CASCADE_PAT }}',
      '',
    ].join('\n');

    assert.throws(() => checkoutSteps(twoTokens, 'two-tokens.yml'), /declares token: 2 times/);
  });

  test('a checkout this reader cannot bound to a step throws rather than going unchecked', () => {
    const orphan = ['jobs:', '  publish:', '    uses: actions/checkout@v4', ''].join('\n');
    assert.throws(() => checkoutSteps(orphan, 'orphan.yml'), /not inside a step list item/);
  });
});

describe('#35 -- the guard can fail (non-vacuity)', () => {
  // THE OUT-OF-SAMPLE CASE, and the reason it is first: every other red below
  // is a mutation this test file wrote itself, and a guard tuned to its own
  // mutations is the failure mode. These are REAL SHIPPED BYTES -- the
  // npm-publish.yml blob from main@692d122, already committed as a fixture for
  // #22 and pinned there by git object hash. It is the file that persisted the
  // org PAT in production, and the guard has never seen it.
  const ORIGINAL = readFileSync(new URL('./fixtures/npm-publish-692d122.yml', import.meta.url));

  test('the real main@692d122 npm-publish.yml -- the file that shipped the defect -- reds the guard', () => {
    const sha = createHash('sha1')
      .update(Buffer.concat([Buffer.from(`blob ${ORIGINAL.length}\0`), ORIGINAL]))
      .digest('hex');
    assert.equal(sha, '38a0b3f5fd710240005bb8cf3e0cd7fa65b65a70', 'the fixture is not the blob it claims to be');

    const violations = persistedCredentialViolations(ORIGINAL.toString('utf8'), 'npm-publish-692d122.yml');
    assert.deepEqual(violations.map(describeViolation), [
      'npm-publish-692d122.yml:57 (Checkout code) '
      + `token=${CASCADE_TOKEN_EXPR} persist-credentials=<absent, defaults to true>`,
    ]);
  });

  // MUTATIONS OF THE REAL FILES, not of a synthetic one. The line is deleted
  // from the bytes that ship, and the guard has to notice.
  for (const file of ['cascade.yml', 'npm-publish.yml']) {
    test(`deleting persist-credentials from the real ${file} reds the guard`, () => {
      const text = read(file);
      const mutated = text.replace('          persist-credentials: false\n', '');
      assert.notEqual(mutated, text, 'the mutation must actually have removed a line');

      const violations = persistedCredentialViolations(mutated, file);
      assert.equal(violations.length, 1, `expected exactly one violation, got ${violations.map(describeViolation)}`);
      assert.match(describeViolation(violations[0]), /CASCADE_PAT/);
    });

    for (const value of ['true', "'false '", 'False', 'no', '0']) {
      test(`rewriting persist-credentials to ${value} in the real ${file} reds the guard`, () => {
        const text = read(file);
        const mutated = text.replace('persist-credentials: false', `persist-credentials: ${value}`);
        assert.notEqual(mutated, text);
        assert.equal(persistedCredentialViolations(mutated, file).length, 1);
      });
    }
  }

  // THE TRAP THIS GUARD EXISTS TO NOT FALL INTO. npm-publish.yml's real token
  // expression CONTAINS the literal `github.token`, so any substring or
  // `includes()` test for "is this just the ambient token?" exempts precisely
  // the checkout the issue is about.
  test('the composed cascade expression is privileged even though it contains github.token', () => {
    const [step] = checkoutSteps([
      '    steps:',
      '      - name: Checkout code',
      '        uses: actions/checkout@v4',
      '        with:',
      `          token: ${CASCADE_TOKEN_EXPR}`,
      '',
    ].join('\n'), 'x.yml');

    assert.ok(step.token.includes('github.token'), 'the expression really does contain the ambient spelling');
    assert.equal(step.privileged, true, 'and it is still privileged');
  });

  const synthetic = (...withLines) => [
    'jobs:',
    '  publish:',
    '    steps:',
    '      - name: Checkout code',
    '        uses: actions/checkout@v4',
    '        with:',
    ...withLines,
    '',
    '      - name: Run tests',
    '        run: pnpm test',
    '',
  ].join('\n');

  test('a synthetic checkout carrying the PAT without the setting is reported', () => {
    const problems = persistedCredentialViolations(synthetic('          token: ${{ secrets.CASCADE_PAT }}'), 's.yml');
    assert.deepEqual(problems.map(describeViolation), [
      's.yml:5 (Checkout code) token=${{ secrets.CASCADE_PAT }} persist-credentials=<absent, defaults to true>',
    ]);
  });

  test('control: the same synthetic checkout WITH the setting is silent', () => {
    const problems = persistedCredentialViolations(synthetic(
      '          token: ${{ secrets.CASCADE_PAT }}',
      '          persist-credentials: false',
    ), 's.yml');
    assert.deepEqual(problems.map(describeViolation), []);
  });

  test('control: a synthetic checkout with no token: at all is not reported by the guard', () => {
    assert.deepEqual(persistedCredentialViolations(synthetic('          fetch-depth: 0'), 's.yml'), []);
  });

  // NON-VACUITY FOR THE STRICTER PROPERTY, which nothing else in this suite
  // supplies. `anyPersistingCheckouts` is the SOLE pin on four of the six
  // `persist-credentials: false` lines -- deleting the line from `ci.yml`,
  // `self-ci.yml`, `security-audit.yml` or npm-publish.yml's
  // `.stonyx-workflows` checkout reds that one test and nothing else. Measured:
  // stubbing the function to `return []` left the suite at 350/350, and
  // composing that stub with deleting the line from `ci.yml` ALSO left it at
  // 350/350 -- a real regression, invisible. The pair below is what makes an
  // empty return red: the ambient-token case the AC2 guard deliberately ignores
  // is exactly the case only this function can see.
  test('an ambient-token checkout with no persist-credentials is reported by the stricter check', () => {
    const text = synthetic('          fetch-depth: 0');

    assert.deepEqual(
      persistedCredentialViolations(text, 's.yml'),
      [],
      'AC2 is silent here by design -- so this case can only be pinned through anyPersistingCheckouts',
    );
    assert.deepEqual(anyPersistingCheckouts(text, 's.yml').map(describeViolation), [
      's.yml:5 (Checkout code) token=null persist-credentials=<absent, defaults to true>',
    ]);
  });

  test('control: the same ambient-token checkout WITH the setting is silent to the stricter check', () => {
    assert.deepEqual(anyPersistingCheckouts(synthetic(
      '          fetch-depth: 0',
      '          persist-credentials: false',
    ), 's.yml').map(describeViolation), [], 'so the report above is detection, not a function that always reports');
  });

  test('control: `token: ${{ github.token }}` is the ambient token and is not reported by the guard', () => {
    assert.deepEqual(persistedCredentialViolations(synthetic('          token: ${{ github.token }}'), 's.yml'), []);
  });

  // `name:` is OPTIONAL on a GitHub Actions step and omitting it on a `uses:`
  // step is the commonest step form there is. A reader that recognises a step
  // only at `- name:` appends this one to the previous step's body and never
  // sees its `token:` -- #37's bypass 6a, measured green at 185/0.
  test('an UNNAMED inline checkout step carrying the PAT is found and reported', () => {
    const text = [
      'jobs:',
      '  publish:',
      '    steps:',
      '      - name: Something else',
      '        run: echo hi',
      '      - uses: actions/checkout@v4',
      '        with:',
      '          token: ${{ secrets.CASCADE_PAT }}',
      '',
    ].join('\n');

    assert.equal(rawCheckoutCount(text), 1, 'the raw count sees it');
    assert.equal(checkoutSteps(text, 'u.yml').length, 1, 'and so does the reader');
    assert.deepEqual(persistedCredentialViolations(text, 'u.yml').map(describeViolation), [
      'u.yml:6 (unnamed step) token=${{ secrets.CASCADE_PAT }} persist-credentials=<absent, defaults to true>',
    ]);
  });

  // THE CONTROL MUST NOT BE THE READER IN A HAT. `rawCheckoutCount` exists so
  // that a checkout `checkoutSteps` cannot see still reds the population
  // assertion. That only works if the two disagree about SOMETHING, and an
  // earlier revision counted with a byte-identical copy of the reader's own
  // `USES_CHECKOUT` selector -- an independent import graph over an identical
  // predicate, which is not independence at all.
  //
  // The flow-mapping step below is valid GitHub Actions, is one of the bypass
  // families this repo's README already lists for #37, and persists an org PAT.
  // The reader does not find it. The count must, or a real credential leak in
  // this shape lands with the suite green.
  test('a flow-mapping checkout the reader cannot see is still counted, so the population reds', () => {
    const text = [
      'jobs:',
      '  test:',
      '    steps:',
      '      - { uses: actions/checkout@v4, with: { token: "${{ secrets.CASCADE_PAT }}" } }',
      '',
    ].join('\n');

    assert.equal(checkoutSteps(text, 'flow.yml').length, 0, 'a documented limit of the reader, recorded not hidden');
    assert.equal(rawCheckoutCount(text), 1, 'and the control disagrees with it, which is the whole point');
  });

  test('the control drops whole comment lines rather than counting the action name in prose', () => {
    const text = ['      # see actions/checkout@v4 for why', '      - uses: actions/checkout@v4', ''].join('\n');
    assert.equal(rawCheckoutCount(text), 1, 'the comment must not inflate the count');
  });

  test('a quoted `"uses":` key spelling of the same step is still found', () => {
    const text = [
      '    steps:',
      '      - "uses": "actions/checkout@v4"',
      '        with:',
      '          token: ${{ secrets.CASCADE_PAT }}',
      '',
    ].join('\n');

    assert.equal(rawCheckoutCount(text), 1);
    assert.equal(persistedCredentialViolations(text, 'q.yml').length, 1);
  });
});

describe('#35 -- the cascade path still receives its credential explicitly', () => {
  test('both push steps bind the SAME token expression the checkout was handed', () => {
    for (const name of PUSH_STEPS) {
      assert.equal(
        stepEnv(npmPublish, name).GIT_REMOTE_TOKEN,
        CASCADE_TOKEN_EXPR,
        `${name} must push as the identity the checkout authenticated as`,
      );
    }
  });

  // AC3, ENUMERATED RATHER THAN ASSUMED. Every git invocation in every workflow
  // that could reach a remote is listed here. `\bgit` does not match
  // `authed_git`, so a bare `git push` anywhere reds this and has to be
  // accounted for. The three survivors are `#` comment lines, which bash does
  // not execute -- pinned verbatim rather than filtered out, so a new one
  // cannot arrive unnoticed. Two of them are abofs/stonyx-workflows#39's prose
  // about the pack destination, which cites the tag steps' `git pull` by name
  // to explain what a dirty worktree would break; they arrived here as a merge
  // conflict this inventory caught, which is the mechanism working.
  test('no bare git command in any workflow reaches a remote', () => {
    const REMOTE_VERBS = /\bgit\s+(?:push|pull|fetch|clone|ls-remote|submodule)\b/;
    const found = FILES.flatMap((f) => read(f).split('\n')
      .map((line, i) => ({ file: f, line: line.trim(), n: i + 1 }))
      .filter(({ line }) => REMOTE_VERBS.test(line)));

    assert.deepEqual(found.map(({ file, line }) => `${file}: ${line}`), [
      'npm-publish.yml: # leaves the worktree dirty for the `git pull --rebase --autostash` in',
      'npm-publish.yml: # perturb the `git pull --rebase --autostash` in the tag steps below.',
      'npm-publish.yml: # does not), and `git push origin "--force" --tags` consumes it as a',
    ], 'every remote-reaching git command must go through authed_git');
    assert.ok(found.every(({ line }) => line.startsWith('#')), 'and the survivor is a comment, not a command');
  });

  // BEHAVIOURAL. The real `run:` body, executed offline against a stubbed
  // `git` that records both its argv and its environment.
  for (const [name, remoteArgs] of [
    [PUSH_STEPS[0], [['pull', '--rebase', '--autostash', 'origin', '--end-of-options', 'dev'],
      ['push', '--tags', 'origin', '--end-of-options', 'dev']]],
    [PUSH_STEPS[1], [['pull', '--rebase', '--autostash', 'origin', 'main'],
      ['push', 'origin', 'main', '--tags']]],
  ]) {
    test(`"${name}" hands the credential to git for the remote calls and to nothing else`, () => {
      const run = runStep(name, { BRANCH: 'dev', PUBLISHED_VERSION: '0.1.1-beta.4', GIT_REMOTE_TOKEN: 'SENTINEL-PAT' });

      assert.equal(run.status, 0, `step should exit 0; stderr was:\n${run.stderr}`);

      const expectedHeader = `AUTHORIZATION: basic ${Buffer.from('x-access-token:SENTINEL-PAT').toString('base64')}`;
      const credentialed = run.gitCalls.filter((c) => c.env.GIT_CONFIG_VALUE_0 === expectedHeader);

      assert.deepEqual(
        credentialed.map((c) => c.argv),
        remoteArgs,
        'exactly the two remote-reaching commands may carry the credential',
      );
      for (const call of credentialed) {
        assert.equal(call.env.GIT_CONFIG_COUNT, '1');
        assert.equal(call.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
      }

      // THE OTHER HALF. `git add`, `git commit` and `git tag` must not receive
      // GIT_CONFIG_VALUE_0 -- that is what "per command rather than exported"
      // buys, and exporting it would red here.
      //
      // It is NOT containment, and the second assertion is the one that says
      // so out loud rather than serving only as a control. GIT_REMOTE_TOKEN is
      // a step-level `env:`, so the RAW PAT is in all five processes'
      // environment; what these three are denied is a base64 ENCODING of a
      // token they already hold in plaintext. A consumer that repoints
      // core.hooksPath reads it from a pre-commit hook. Pinned here because
      // the prose about this step has been wrong once already
      // (abofs/stonyx-workflows#35, Phase 3 and Phase 5), and the closure is
      // abofs/stonyx-workflows#36.
      const local = run.gitCalls.filter((c) => !credentialed.includes(c));
      assert.deepEqual(local.map((c) => c.argv[0]), ['add', 'commit', 'tag'], 'the local commands, in order');
      for (const call of local) {
        assert.equal(call.env.GIT_CONFIG_VALUE_0, undefined, `${call.argv[0]} must not inherit the encoded header`);
        assert.equal(call.env.GIT_REMOTE_TOKEN, 'SENTINEL-PAT', 'the RAW token IS here -- which makes the '
          + 'assertion above detection rather than an empty environment, AND is itself the residual exposure #36 '
          + 'closes; any doc saying these three do not get the credential is wrong');
      }
    });
  }

  test('the credential is masked in the log before it is used', () => {
    for (const name of PUSH_STEPS) {
      const run = runStep(name, { BRANCH: 'dev', PUBLISHED_VERSION: '1.0.0', GIT_REMOTE_TOKEN: 'SENTINEL-PAT' });
      const b64 = Buffer.from('x-access-token:SENTINEL-PAT').toString('base64');
      assert.ok(run.stdout.includes(`::add-mask::${b64}`), `${name} must mask the encoded credential:\n${run.stdout}`);
    }
  });
});

/**
 * Execute one step's real `run:` body offline with `git` stubbed, recording
 * each invocation's argv AND the environment it was given.
 *
 * The environment is the point: the whole fix is about which processes can see
 * the credential, and an argv-only stub cannot tell.
 */
function runStep(stepName, env) {
  const body = stepRunBody(npmPublish, stepName);
  const workspace = mkdtempSync(join(tmpdir(), 'wf35-'));

  try {
    const bin = join(workspace, 'bin');
    mkdirSync(bin);
    const log = join(workspace, 'git-calls.log');
    writeFileSync(log, '');

    const gitStub = join(bin, 'git');
    writeFileSync(gitStub, [
      `#!${process.execPath}`,
      `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({`,
      '  argv: process.argv.slice(2),',
      '  env: Object.fromEntries(Object.entries(process.env)',
      "    .filter(([k]) => k.startsWith('GIT_CONFIG_') || k === 'GIT_REMOTE_TOKEN')),",
      "}) + '\\n');",
      '',
    ].join('\n'));
    chmodSync(gitStub, 0o755);

    const lines = body.split('\n');
    const widths = lines.filter((l) => l.trim() !== '').map((l) => l.match(/^(\s*)/)[1].length);
    const strip = widths.length ? Math.min(...widths) : 0;
    const scriptPath = join(workspace, 'step.sh');
    writeFileSync(scriptPath, lines.map((l) => l.slice(strip)).join('\n') + '\n');

    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptPath], {
      cwd: workspace,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_SERVER_URL: 'https://github.com', ...env },
      encoding: 'utf8',
    });

    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      gitCalls: readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
