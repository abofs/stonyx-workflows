import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { EXPRESSION_ALLOWLIST } from './helpers/expression-allowlist.js';
import { rawSweepProblems, workflowFileNames } from './helpers/raw-expression-scan.js';
import {
  ALLOWLIST,
  NON_BODY_KEY_LINES,
  deadAllowlistProblems,
  duplicateNameProblems,
  runSweepProblems,
  scriptSweepProblems,
  stepPopulationProblems,
  sweepProblems,
} from './helpers/interpolation-sweep.js';
import {
  MissingStepKeyError,
  duplicateStepNames,
  envOf,
  expressionOpenerCount,
  expressionsIn,
  parseSteps,
  readWorkflow,
  runBodyOf,
  scalarKeyLineCount,
  scriptBodyOf,
  stepNamed,
} from './helpers/workflow-yaml.js';

// Five bypasses of the interpolation sweep PR #33 added (abofs/stonyx-workflows#37).
//
// Every one of them was MEASURED green at 161 pass / 0 fail against `main`
// @ e07e185 -- a fully green suite guarding nothing. The artifact under repair
// was a check that could not fail, so an assertion here that cannot go red
// would recreate the exact bug one layer up. Each case therefore ships its
// reproducing mutation, applied to the real workflow text, and asserts the
// sweep now reports it. Delete the fix and these go red; that is the point.
//
// The mutations are the ones refinement and SME review ran verbatim, not
// paraphrases of them.

const cascade = readWorkflow('cascade.yml');
const securityAudit = readWorkflow('security-audit.yml');
const npmPublish = readWorkflow('npm-publish.yml');

// NO EXTENSION FILTER. GitHub Actions reads `.yaml` too, and filtering here is
// what made the pin that guards this population unable to fire (#37, Phase 3
// §4). The list is asserted below, so a non-workflow file in this directory
// reds and gets a decision rather than a silent exemption.
//
// This used to call `readdirSync` here, which reproduced the SAME defect one
// file over: the `deepEqual` at the bottom compared against a list this file
// had filtered itself, so restoring `.filter((n) => n.endsWith('.yml'))` was
// 282 pass / 0 fail -- a pin that could not fire, in the round whose G8
// publishes having removed exactly this shape from `injection-test.js`. It
// matters more here than it did there because the benign control below calls
// `rawSweepProblems` over this list, so a filter would silently narrow a
// GUARANTEE case and not only a diagnostic one (#37, Phase 4 NEW-7). The
// enumeration is now `workflowFileNames`, whose no-extension-filter property
// is proven against a real temp directory in `raw-sweep-test.js`.
const WORKFLOW_FILES = workflowFileNames();

/**
 * Append a step to a workflow's `steps:` list.
 *
 * Callers supply the list indentation in their own string literal; every
 * workflow in this repo sits at six spaces. This does no indentation work.
 */
const withExtraStep = (text, stepYaml) => `${text.replace(/\n+$/, '\n')}\n${stepYaml.replace(/\n+$/, '')}\n`;

/** Assert at least one problem matches, and say which problems were actually reported when none does. */
function assertReports(problems, pattern, why) {
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `${why}\nexpected a problem matching ${pattern}\ngot:\n${problems.map((p) => `  - ${p}`).join('\n') || '  (none)'}`,
  );
}

describe('AC1 -- a duplicate step name cannot hide a step from either sweep (#37)', () => {
  // Measured: 161 pass / 0 fail with this exact mutation applied.
  const M1 = withExtraStep(cascade, [
    '      - name: Checkout stonyx-workflows (for dependency map)',
    '        run: |',
    '          echo "cascading ${{ inputs.package-name }}"',
  ].join('\n'));

  // M1c, folded in from PR #33 review 5087736712. The duplicate-name hole
  // reaches the `script:` sweep too -- the S3/S5 github-script sink class,
  // which is the one holding the org-level CASCADE_PAT.
  const M1c = withExtraStep(cascade, [
    '      - name: Dispatch to downstream dependents',
    '        uses: actions/github-script@v7',
    '        with:',
    '          script: |',
    "            const n = '${{ inputs.package-name }}';",
    '            console.log(n);',
  ].join('\n'));

  test('step names are unique within every workflow file', () => {
    for (const file of WORKFLOW_FILES) {
      assert.deepEqual(duplicateNameProblems(file, readWorkflow(file)), []);
    }
  });

  test('M1: a duplicated step name hiding a run: sink reds the run sweep', () => {
    assertReports(
      runSweepProblems('cascade.yml', M1),
      /interpolates \$\{\{ inputs\.package-name \}\} into shell source/,
      'a second step reusing an existing name had its run: body never read: both sweeps re-resolved bodies '
      + 'by name with .find(), so the FIRST step\'s body was checked twice. 161/0 green.',
    );
    assertReports(duplicateNameProblems('cascade.yml', M1), /has 2 steps named/, 'the duplicate itself is reported');
  });

  test('M1c: a duplicated step name hiding a script: sink reds the github-script sweep', () => {
    assertReports(
      scriptSweepProblems('cascade.yml', M1c),
      /interpolates 1 expression\(s\) into JS source/,
      'the same aliasing hole in the `script:` sweep, i.e. the S3/S5 sink class. 161/0 green.',
    );
  });

  test('the name-taking helpers refuse an ambiguous name instead of returning the first match', () => {
    assert.throws(
      () => stepNamed(M1, 'Checkout stonyx-workflows (for dependency map)'),
      /2 steps are named/,
      'a name is not an identity in GitHub Actions; answering with the first match is what hid the sink',
    );

    // Why positional iteration is load-bearing rather than stylistic: the
    // legacy `.find()` resolves to position 0 while the sink sits at the end.
    const steps = parseSteps(M1);
    const named = steps.filter((s) => s.name === 'Checkout stonyx-workflows (for dependency map)');
    assert.equal(named.length, 2);
    assert.equal(named[0].index, 0);
    assert.ok(!named[0].body.includes('${{ inputs.package-name }}'), 'the first match carries no sink');
    assert.ok(named[1].body.includes('${{ inputs.package-name }}'), 'the sink is in the step .find() never returns');
  });
});

describe('AC2 -- folded block scalars are swept, unknown run: headers throw (#37)', () => {
  // Measured: 161 pass / 0 fail. `stepRunBody`'s inline branch excluded `|` and
  // not `>`, so this whole body was replaced by the literal string ">".
  const M2 = withExtraStep(cascade, [
    '      - name: Announce the cascade',
    '        run: >',
    '          echo "cascading ${{ inputs.package-name }}"',
  ].join('\n'));

  const stepWith = (runValue, extra = []) => parseSteps([
    'jobs:',
    '  j:',
    '    steps:',
    '      - name: S',
    `        run: ${runValue}`,
    ...extra,
  ].join('\n'))[0];

  test('M2: `run: >` carrying an expression reds the sweep', () => {
    assertReports(
      runSweepProblems('cascade.yml', M2),
      /interpolates \$\{\{ inputs\.package-name \}\} into shell source/,
      'a folded scalar body was never swept; the helper returned ">" as the entire body. 161/0 green.',
    );
  });

  test('stepRunBody returns the body for every block-scalar header, not just `|`', () => {
    const folded = ['          echo "a ${{ inputs.x }}"', '          echo b'];
    // `|-` and `|+` were already handled; they are asserted here so the fix
    // cannot be narrowed back down to `>` alone.
    for (const header of ['|', '|-', '|+', '|2', '|-2', '>', '>-', '>+', '>2']) {
      const body = runBodyOf(stepWith(header, folded));
      assert.match(
        body,
        /echo "a \$\{\{ inputs\.x \}\}"/,
        `run: ${header} must return the block body, not the header text`,
      );
      assert.ok(!/^\s*[|>]/.test(body), `run: ${header} returned the header itself as the body`);
    }
  });

  test('stepRunBody throws on a run: scalar header it does not understand', () => {
    for (const header of ['!!str foo', '&anchor foo', '*alias', '|nonsense']) {
      assert.throws(
        () => runBodyOf(stepWith(header)),
        /unrecognised run: scalar header/,
        `run: ${header} must throw rather than be handed back as if it were the body`,
      );
    }
  });

  test('an unreadable run: body is reported by the sweep, not silently skipped', () => {
    const tagged = withExtraStep(cascade, [
      '      - name: Announce the cascade',
      '        run: !!str echo hi',
    ].join('\n'));

    assertReports(
      runSweepProblems('cascade.yml', tagged),
      /the extractor could not read its run: body/,
      'the sweep used to wrap the body read in a bare `catch { continue; }`, so any extractor failure '
      + 'removed that step from the sweep entirely',
    );
  });
});

describe('AC3 -- an expression containing } is matched, unmatched openers are impossible (#37)', () => {
  // Measured: 161 pass / 0 fail. /\$\{\{[^}]*\}\}/ stops at the first `}`, and
  // `format()` placeholders are `{0}`, `{1}`.
  const M3 = withExtraStep(cascade, [
    '      - name: Announce the cascade',
    '        run: |',
    '          echo "cascading ${{ format(\'{0}\', inputs.package-name) }}"',
  ].join('\n'));

  const LEGACY = /\$\{\{[^}]*\}\}/g;

  test("M3: `${{ format('{0}', inputs.package-name) }}` reds the sweep", () => {
    assertReports(
      runSweepProblems('cascade.yml', M3),
      /interpolates \$\{\{ format\('\{0\}', inputs\.package-name\) \}\} into shell source/,
      'the sweep regex could not match an expression containing `}` at all. 161/0 green.',
    );
  });

  test('the matcher extracts a brace-carrying expression whole', () => {
    const line = 'echo "${{ format(\'{0}\', inputs.x) }}" && echo "${{ inputs.y }}"';

    assert.deepEqual(
      expressionsIn(line).map((e) => e.expression),
      ["${{ format('{0}', inputs.x) }}", '${{ inputs.y }}'],
    );

    // Calibration in the same run: the regex this replaced could not do it.
    // Restoring /\$\{\{[^}]*\}\}/ reds the assertion above.
    assert.notDeepEqual(
      line.match(LEGACY),
      ["${{ format('{0}', inputs.x) }}", '${{ inputs.y }}'],
      'if the legacy regex now agrees, this calibration has stopped measuring anything',
    );

    // A brace inside a GHA single-quoted literal cannot unbalance the scan.
    assert.deepEqual(
      expressionsIn("${{ format('{0}}', inputs.x) }}").map((e) => e.expression),
      ["${{ format('{0}}', inputs.x) }}"],
      'a lazy /\\$\\{\\{[\\s\\S]*?\\}\\}/ would have stopped inside the string literal',
    );
  });

  test('the accounting pin reds when the matcher cannot resolve an opener', () => {
    // The pin has to be shown capable of failing, in the same run. This body
    // holds an opener the matcher deliberately refuses (unterminated), so the
    // only thing that can report it is the count taken off the raw text.
    const unparseable = withExtraStep(cascade, [
      '      - name: Announce the cascade',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }"',
    ].join('\n'));

    const body = 'echo "cascading ${{ inputs.package-name }"';
    assert.equal(expressionOpenerCount(body), 1, 'the raw-text opener count must see it');
    assert.equal(expressionsIn(body).length, 0, 'the matcher must not resolve it -- that is the whole scenario');

    assertReports(
      runSweepProblems('cascade.yml', unparseable),
      /opener\(s\) but the matcher resolved 0 expression\(s\)/,
      'a shape the matcher cannot parse must red on the COUNT; otherwise it simply vanishes from the sweep',
    );

    // And the pin is not permanently red: the same step with a well-formed
    // expression reports the sink, never an accounting gap.
    const wellFormed = withExtraStep(cascade, [
      '      - name: Announce the cascade',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));
    assert.ok(
      !runSweepProblems('cascade.yml', wellFormed).some((p) => /opener\(s\) but the matcher resolved/.test(p)),
      'the accounting pin must not fire on an expression the matcher handles',
    );
  });
});

describe('AC4 -- the allowlist entry dies with its sink (#37)', () => {
  // These run against a FIXTURE of `security-audit.yml` at e07e185, not against
  // the live file, and against a local copy of its allowlist entry rather than
  // the shared `ALLOWLIST`.
  //
  // That is deliberate hand-off work, not indirection. #34 will fix this exact
  // sink and delete this exact entry -- and if these cases read the live file
  // and the live allowlist, all four of them would evaporate the day #34
  // merges, taking the proof of the repair with them. The property being proven
  // here is a property of the SWEEP, so it is pinned to the text the bypass was
  // measured against. `test/injection-test.js` keeps sweeping the real files
  // with the real allowlist, which is where drift in `security-audit.yml`
  // itself has to show up.
  //
  // Same precedent as `test/fixtures/npm-publish-692d122.yml` -- INCLUDING its
  // blob-SHA pin (`test/lift-equivalence-test.js:77-81`), whose own comment
  // says it exists "so the fixture cannot be edited to make this test agree
  // with a script that has drifted". Citing that precedent without its guard
  // is what made this a mutable file with a commit hash in its name: nothing
  // asserted the bytes, `FIXTURE.includes(ORIGINAL_SINK)` pins one line, and
  // the cheapest way to make a future red go away would have been to edit the
  // file the mutations are measured against (abofs/stonyx-workflows#37,
  // Phase 2 WARNING 1).
  //
  // Snapshot of `.github/workflows/security-audit.yml` at e07e185 -- the merge
  // commit of PR #33, `fix(#32): close consumer-controlled-string injection
  // sinks in npm-publish.yml and cascade.yml`, and the base of this branch:
  // https://github.com/abofs/stonyx-workflows/commit/e07e185
  const FIXTURE_PATH = new URL('./fixtures/security-audit-e07e185.yml', import.meta.url);
  const FIXTURE_BYTES = readFileSync(FIXTURE_PATH);
  const FIXTURE = FIXTURE_BYTES.toString('utf8');

  // `git rev-parse e07e185:.github/workflows/security-audit.yml`
  const FIXTURE_BLOB_SHA = '501fad8b335e3f927bae9036ca8d1bf5c2765064';

  const ORIGINAL_SINK = '        run: pnpm audit --audit-level ${{ inputs.audit-level }}';

  // An abridged copy of the live entry as it stands before #34: only the
  // pinned fields matter here, and nothing asserts on `why`.
  const ALLOWLIST_AT_E07E185 = {
    'security-audit.yml': [{
      step: 'Run security audit',
      line: 'pnpm audit --audit-level ${{ inputs.audit-level }}',
      expression: '${{ inputs.audit-level }}',
      occurrences: 1,
      why: 'KNOWN OPEN SINK, tracked as abofs/stonyx-workflows#34.',
    }],
  };

  const runProblems = (text) => runSweepProblems('security-audit.yml', text, ALLOWLIST_AT_E07E185);
  const deadProblems = (text) => deadAllowlistProblems('security-audit.yml', text, ALLOWLIST_AT_E07E185);

  /** #34's likely fix shape: the input moved to step `env:`, the body reading "$AUDIT_LEVEL". */
  const fix34 = ({ comment }) => FIXTURE.replace(ORIGINAL_SINK, [
    '        env:',
    '          AUDIT_LEVEL: ${{ inputs.audit-level }}',
    '        run: |',
    ...(comment ? ['          # Was: pnpm audit --audit-level ${{ inputs.audit-level }} -- now via env (#34).'] : []),
    '          pnpm audit --audit-level "$AUDIT_LEVEL"',
  ].join('\n'));

  // Measured: 161 pass / 0 fail. The sink is genuinely closed and the exemption
  // stays alive, because `countIn` counted the expression ANYWHERE in the step.
  const M4 = fix34({ comment: true });
  const CALIBRATION = fix34({ comment: false });

  // NEW-5, from review 5087736712: same step, same expression, same occurrence
  // count, different shell position. 161 pass / 0 fail.
  const NEW5 = FIXTURE.replace(
    ORIGINAL_SINK,
    '        run: eval "pnpm audit --audit-level ${{ inputs.audit-level }}"',
  );

  test('the pinned fixture is the exact blob from main@e07e185', () => {
    const header = Buffer.from(`blob ${FIXTURE_BYTES.length}\0`, 'utf8');
    const sha = createHash('sha1').update(Buffer.concat([header, FIXTURE_BYTES])).digest('hex');
    assert.equal(sha, FIXTURE_BLOB_SHA, 'fixtures/security-audit-e07e185.yml is not the blob it claims to be');
  });

  test('the fixture is the text these mutations were measured against, and it sweeps clean', () => {
    assert.ok(FIXTURE.includes(ORIGINAL_SINK), 'the fixture must still carry the #34 sink line to mutate it');
    assert.notEqual(M4, FIXTURE, 'the M4 replacement must actually have applied');
    assert.notEqual(NEW5, FIXTURE, 'the NEW-5 replacement must actually have applied');

    // Calibration: unmutated, with the entry present, nothing is reported. If
    // this were red the three cases below would be proving nothing.
    assert.deepEqual(runProblems(FIXTURE), []);
    assert.deepEqual(deadProblems(FIXTURE), []);
  });

  test('M4: #34 fix plus a run-body comment quoting the expression reds twice', () => {
    assertReports(
      deadProblems(M4),
      /no longer carries the exempted source line/,
      'the entry must be named DEAD -- the sink it recorded is gone. 161/0 green before the line pin.',
    );
    assertReports(
      runProblems(M4),
      /interpolates \$\{\{ inputs\.audit-level \}\} into shell source/,
      'the expression is now on a comment line the allowlist never pinned, so it is an unexempted sink',
    );
  });

  test('calibration: #34 fix without the comment still reds as a dead entry', () => {
    // This half already worked before #37 (160 pass / 1 fail) and must be
    // preserved: a fixed sink has to lose its exemption. Reported here in the
    // same run as M4 so the two are read together -- one comment is the entire
    // difference between them.
    assertReports(
      deadProblems(CALIBRATION),
      /no longer carries the exempted source line/,
      'deleting the entry is what #34 must do; keeping it must stay red',
    );
    assert.deepEqual(
      runProblems(CALIBRATION),
      [],
      'without the comment there is no expression left in the run: body, so the run sweep is clean',
    );
  });

  test('NEW-5: relocating the expression into eval "..." reds the sweep', () => {
    assertReports(
      runProblems(NEW5),
      /interpolates \$\{\{ inputs\.audit-level \}\} into shell source/,
      'same step, same expression, same count -- the exemption pinned none of the position. 161/0 green.',
    );
    assertReports(
      deadProblems(NEW5),
      /no longer carries the exempted source line/,
      "the entry's recorded `why` stopped describing reality and nothing noticed",
    );
  });

  test('#34 re-arming: re-applying the original sink line to the fixed workflow reds the sweep', () => {
    // The assertion #34 owes, proven here on the mechanism it will rely on.
    // Deleting an allowlist entry and never consulting one look identical, so
    // #34 must re-apply `pnpm audit --audit-level ${{ inputs.audit-level }}` to
    // its OWN FIXED workflow, with the entry deleted, and observe the sweep go
    // red. If it stays green the exemption survived somewhere.
    const fixedAndDisarmed = CALIBRATION;
    const noAllowlist = { 'security-audit.yml': [] };
    assert.deepEqual(
      runSweepProblems('security-audit.yml', fixedAndDisarmed, noAllowlist),
      [],
      'with the sink fixed and the entry deleted, the sweep is clean -- the state #34 lands in',
    );

    const reArmed = fixedAndDisarmed.replace(
      '          pnpm audit --audit-level "$AUDIT_LEVEL"',
      '          pnpm audit --audit-level ${{ inputs.audit-level }}',
    );
    assert.notEqual(reArmed, fixedAndDisarmed, 'the re-arming replacement must actually have applied');
    assertReports(
      runSweepProblems('security-audit.yml', reArmed, noAllowlist),
      /interpolates \$\{\{ inputs\.audit-level \}\} into shell source/,
      'the sweep must be positively re-armable; a sweep that stays green here is guarding nothing',
    );
  });

  test('an expression on a #-comment line is a live sink, never exempt', () => {
    // NOT fixed by stripping comment lines, which was the proposal on review
    // 5087736712 and is wrong. The runner substitutes ${{ }} textually before
    // bash parses, and a workflow_call input can contain a newline, so a
    // commented expression executes. Measured on the runner's own shell
    // (`bash --noprofile --norc -e`) with
    // inputs.audit-level = "moderate\ntouch /tmp/canary/PWNED\n#": exit 0 and
    // the canary written. Exempting comment lines would teach the sweep to
    // ignore a real sink class -- this issue's defect, one layer deeper.
    const commented = withExtraStep(cascade, [
      '      - name: Announce the cascade',
      '        run: |',
      '          # cascading ${{ inputs.package-name }}',
      '          echo done',
    ].join('\n'));

    assertReports(
      runSweepProblems('cascade.yml', commented),
      /interpolates \$\{\{ inputs\.package-name \}\} into shell source/,
      'a commented expression is substituted before bash parses it, so it is a sink and not documentation',
    );
  });

  test('the allowlist itself pins a line for every entry', () => {
    // A structural guard on the live allowlist: an entry added later without a
    // `line` would fall back to exempting the whole step, which is the shape
    // bypass 4 and NEW-5 both exploited.
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      for (const entry of entries) {
        assert.equal(typeof entry.line, 'string', `${file}: allowlist entry for ${entry.expression} pins no line`);
        assert.ok(entry.line.includes(entry.expression), `${file}: the pinned line must carry the exempted expression`);
        assert.equal(entry.line, entry.line.trim(), `${file}: the pinned line is compared trimmed`);
      }
    }
  });
});

describe('AC6 -- bypass 6: a step the reader cannot see is not swept (#37)', () => {
  // The sixth family, found independently by SME Phases 2, 3 and 4 on PR #38
  // and measured green at 185 pass / 0 fail on the REAL workflow files -- the
  // repaired sweep reporting nothing about a live `workflow_call` input in
  // shell source and in `actions/github-script` source, in the job holding the
  // org-level CASCADE_PAT.
  //
  // Three distinct root causes, which is why one fix does not close them:
  //
  //   6a  `parseSteps` recognised a step only at `- name:`, and `name:` is
  //       OPTIONAL in GitHub Actions.
  //   6b  `stepScalar` took the first `run:`/`script:` at ANY indentation, so a
  //       key line inside an earlier block scalar won.
  //   6c  a quoted key (`"run": |`) matched no probe, and `readBody` then read
  //       "could not parse" as "has none" by substring-matching a message.
  //
  // The unifying defect is one level above the one PR #38 first repaired: the
  // `${{` accounting pin counts openers off the body the extractor RETURNED, so
  // an extractor that returns nothing agrees with its own omission. The
  // `node -e` sweep survives the identical mutation because its population is
  // counted off the raw file. That A/B is pinned below.

  const unnamedRunInline = withExtraStep(cascade, '      - run: echo "${{ inputs.package-name }}"');

  const unnamedRunBlock = withExtraStep(cascade, [
    '      - run: |',
    '          echo "cascading ${{ inputs.package-name }}"',
  ].join('\n'));

  // The CASCADE_PAT sink class: `actions/github-script` source, no `name:`.
  const unnamedScript = withExtraStep(cascade, [
    '      - uses: actions/github-script@v7',
    '        with:',
    '          github-token: ${{ secrets.CASCADE_PAT }}',
    '          script: |',
    "            const n = '${{ inputs.package-name }}';",
  ].join('\n'));

  const nameSecond = withExtraStep(cascade, [
    '      - uses: actions/github-script@v7',
    '        name: Extra dispatch',
    '        with:',
    '          script: |',
    "            const n = '${{ inputs.package-name }}';",
  ].join('\n'));

  const usesLast = withExtraStep(cascade, [
    '      - with:',
    '          script: |',
    "            const n = '${{ inputs.package-name }}';",
    '        uses: actions/github-script@v7',
  ].join('\n'));

  const SINK = /interpolates \$\{\{ inputs\.package-name \}\} into shell source/;
  const JS_SINK = /interpolates 1 expression\(s\) into JS source/;

  test('6a: an unnamed `- run:` step is swept, inline and block', () => {
    for (const [shape, text] of [['inline', unnamedRunInline], ['block', unnamedRunBlock]]) {
      assertReports(
        runSweepProblems('cascade.yml', text),
        SINK,
        `an unnamed ${shape} run: step was not a step to the reader; its lines were appended to the PREVIOUS `
        + 'step\'s body, where stepScalar took that step\'s run: and never read this one. 185/0 green.',
      );
    }
  });

  test('6a: an unnamed github-script step is swept -- the CASCADE_PAT sink class', () => {
    for (const [shape, text] of [['no name:', unnamedScript], ['name: second', nameSecond], ['uses: last', usesLast]]) {
      assertReports(
        scriptSweepProblems('cascade.yml', text),
        JS_SINK,
        `a step whose first key is not name: (${shape}) hid JS source in the step that holds the org-level `
        + 'CASCADE_PAT. 185/0 green.',
      );
    }
  });

  test('6a: the same sink in npm-publish.yml, after a step that already has a run:', () => {
    // Placed after an existing `run:` step on purpose: the merged-body shapes
    // that red before this fix only did so by accident, because the step they
    // were merged into happened to have no `run:` of its own for findIndex to
    // return first.
    assertReports(
      runSweepProblems('npm-publish.yml', withExtraStep(npmPublish, [
        '      - run: |',
        '          echo "${{ inputs.package-name }}"',
      ].join('\n'))),
      /interpolates \$\{\{ inputs\.package-name \}\} into shell source/,
      'the smuggled body must be read even when the preceding step has a run: of its own',
    );
  });

  test('6a calibration: the SAME sink reds whether or not the step carries a name:', () => {
    // Phase 3's calibration pair, and the finding in one assertion. Same file,
    // same input, same sink, same expression. Before this fix, named -> 183/2
    // red and unnamed -> 185/0 green: the presence of `- name:` was the entire
    // difference between a reported sink and a silent one.
    const sink = '        run: echo "level ${{ inputs.audit-level }}"';
    const unnamed = withExtraStep(securityAudit, `      - ${sink.trim()}`);
    const named = withExtraStep(securityAudit, ['      - name: Second audit', sink].join('\n'));

    // The assertion pins the LINE, not merely the expression. Matching on the
    // expression alone made this test a placebo: under K9 (`parseSteps`
    // narrowed back to `- name:`) the appended item re-indents the merged
    // step's keys, the step LOSES its `name:`, the file's own pre-existing
    // allowlist entry stops matching, and what reds is `security-audit.yml`'s
    // OWN `pnpm audit` line -- never the sink this test appends. It passed
    // under the exact revert it exists to guard, and the PR body called it
    // "the finding in one assertion" (#37, Phase 4 verification, CRITICAL).
    const ECHO_LINE = /on the line "echo \\"level \$\{\{ inputs\.audit-level \}\}\\""/;

    for (const [shape, text] of [['unnamed', unnamed], ['named', named]]) {
      assertReports(
        runSweepProblems('security-audit.yml', text),
        ECHO_LINE,
        `the ${shape} form must red ON THE APPENDED LINE; if only one of these two reds, or if the red names `
        + 'a different line, the sweep is keyed on the name again',
      );
    }
  });

  test('6a: a list item in a shape the reader cannot resolve throws, never skips', () => {
    // Flow mappings, aliases and merge keys are all legal YAML that produce a
    // real step GitHub Actions would run. Skipping one puts it outside every
    // sweep, which is this whole family; so the reader refuses instead.
    const items = [
      `      - {name: Flow map sink, run: 'echo "\${{ inputs.package-name }}"'}`,
      '      - *base',
      '      - <<: *base',
    ];

    for (const item of items) {
      assert.throws(
        () => sweepProblems('cascade.yml', withExtraStep(cascade, item)),
        /unrecognised step list item/,
        `${item.trim()} must throw rather than silently not being a step`,
      );
    }
  });

  test('6b: a `run:` key inside an EARLIER block scalar does not win', () => {
    // Phase 2's repro, on the real cascade.yml: a step-level `env:` value
    // holding a YAML snippet -- a workflows repo writing a consumer snippet
    // into $GITHUB_STEP_SUMMARY, which this repo's own README ships. The
    // extractor returned "pnpm test" as the run body and sweepProblems() -> [].
    // 185/0 green, and green on main too, so a family member not a regression.
    const M6b = withExtraStep(cascade, [
      '      - name: Emit the consumer snippet',
      '        env:',
      '          SNIPPET: |',
      '            name: CI',
      '            uses: abofs/stonyx-workflows/.github/workflows/ci.yml@main',
      '            run: pnpm test',
      '        run: |',
      '          echo "$SNIPPET" >> "$GITHUB_STEP_SUMMARY"',
      '          echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));

    const step = parseSteps(M6b).at(-1);
    assert.match(
      runBodyOf(step),
      /echo "cascading \$\{\{ inputs\.package-name \}\}"/,
      'the REAL run: body must be returned; the snippet line is block-scalar payload, not a key',
    );
    assert.ok(!/^\s*pnpm test\s*$/.test(runBodyOf(step)), 'the run: line inside the env: snippet must not win');

    assertReports(runSweepProblems('cascade.yml', M6b), SINK, 'the sink in the real run: body must be reported');
  });

  test('6b: the same shape ahead of a `with: script:` block does not win either', () => {
    // The script: twin. An indentation anchor on `run:` alone -- the cheapest
    // remedy -- leaves this open, because `script:` legitimately sits deeper
    // than the step's own keys.
    const M6bScript = withExtraStep(cascade, [
      '      - name: Emit and dispatch',
      '        uses: actions/github-script@v7',
      '        env:',
      '          SNIPPET: |',
      '            script: console.log(1)',
      '        with:',
      '          script: |',
      "            const n = '${{ inputs.package-name }}';",
    ].join('\n'));

    assert.match(
      scriptBodyOf(parseSteps(M6bScript).at(-1)),
      /const n = '\$\{\{ inputs\.package-name \}\}';/,
      'the REAL script: body must be returned, not the line inside the env: snippet',
    );
    assertReports(scriptSweepProblems('cascade.yml', M6bScript), JS_SINK, 'the sink in the real script: body reds');
  });

  test('6c: a quoted `run:`/`script:` key is read, not reported as absent', () => {
    const quotedRun = withExtraStep(cascade, [
      '      - name: Quoted key sink',
      '        "run": |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));

    const quotedScript = withExtraStep(cascade, [
      '      - name: Quoted script sink',
      '        uses: actions/github-script@v7',
      '        with:',
      "          'script': |",
      "            const n = '${{ inputs.package-name }}';",
    ].join('\n'));

    assertReports(runSweepProblems('cascade.yml', quotedRun), SINK, '`"run": |` is valid YAML that GitHub runs');
    assertReports(scriptSweepProblems('cascade.yml', quotedScript), JS_SINK, "`'script': |` likewise");
  });

  test('6c: "has no key" is a typed error, not a message a caller string-matches', () => {
    // `readBody` decides skip-vs-report on this. It used to decide by
    // `err.message.includes('has no run: key')`, so rewording this message
    // would have turned every unreadable body into a silent skip -- and the
    // kill mutation guarding that branch deletes the branch rather than
    // changing the string, so nothing would have caught it.
    const usesOnly = parseSteps([
      'jobs:', '  j:', '    steps:', '      - name: S', '        uses: actions/checkout@v4',
    ].join('\n'))[0];

    const thrownBy = (fn) => {
      try { fn(); } catch (err) { return err; }
      return assert.fail('expected a throw');
    };

    const err = thrownBy(() => runBodyOf(usesOnly));
    assert.ok(err instanceof MissingStepKeyError, 'the missing-key case must be identifiable without reading prose');
    assert.equal(err.code, MissingStepKeyError.CODE);
    assert.equal(err.key, 'run');

    // And an unreadable body is NOT that error, so it can never be skipped.
    const tagged = parseSteps([
      'jobs:', '  j:', '    steps:', '      - name: S', '        run: !!str echo hi',
    ].join('\n'))[0];
    const unreadable = thrownBy(() => runBodyOf(tagged));
    assert.match(unreadable.message, /unrecognised run: scalar header/);
    assert.notEqual(unreadable.code, MissingStepKeyError.CODE, 'an unreadable body must never look like an absent one');
  });
});

describe('AC6b -- the body population the DIAGNOSTICS quantify over is pinned off raw text (#37)', () => {
  // Scope, stated because it changed. This is no longer any part of the
  // `${{ }}` guarantee -- that is a raw byte scan over the whole directory
  // (`test/raw-sweep-test.js`) and it counts nothing off this reader. What is
  // left here keeps the EXECUTED `run:`-body tests honest: they extract a real
  // step body and run it under bash, so a body the reader never returns is a
  // test that silently stops executing the thing it names.
  //
  // The STEP-ITEM half of this pin is deleted, not demoted. Phase 3 measured it
  // effectively dead -- re-deriving `stepListItemCount` from the very extractor
  // it audited left 206/0 green, deleting it outright left 206/0 green, and the
  // only committed test that spoke to its defining property compared it against
  // a reader RE-IMPLEMENTED INSIDE THE TEST FILE rather than against the real
  // `parseSteps`, so the re-derivation passed it. Its snapshot companion
  // hard-coded a per-file count and reds on a benign added step: a churn
  // tripwire, not a security signal (Phase 4 verification). Under the raw scan
  // it is redundant as well as unfalsifiable, so it is gone.

  test('the run:/script: key-line pin reds when a body is outside the sweep', () => {
    // A live red rather than a hypothetical one: the 6b shape leaves two `run:`
    // key lines in the raw text and one run: body readable as a step key.
    const M6b = withExtraStep(cascade, [
      '      - name: Emit the consumer snippet',
      '        env:',
      '          SNIPPET: |',
      '            run: pnpm test',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));

    // Derived from the file, never snapshotted. `cascade.yml` carries no `run:`
    // body today, so hard-coding `2` here reds on the first `run:` step anyone
    // adds to it -- the churn-tripwire shape `7e41b0f` deleted for `ci.yml`,
    // surviving twice in this file, and the reason B27's benign control was
    // green only because it was appended to `ci.yml` (#37, Phase 3 §6, Phase 4
    // NEW-7, Phase 1 F6).
    const bodies = scalarKeyLineCount(cascade, 'run');
    assert.equal(scalarKeyLineCount(M6b, 'run'), bodies + 2, 'the 6b shape adds a real run: line and a payload one');
    assertReports(
      stepPopulationProblems('cascade.yml', M6b),
      new RegExp(`holds ${bodies + 2} \`run:\` key line\\(s\\) in its raw text but the sweep read ${bodies + 1} `),
      'a run: key line the sweep never read is a body the executed tests are not really running',
    );
  });

  test('the key-line pin also reds when a REAL body escapes the reader, not only on payload over-count', () => {
    // The honest calibration the pin was missing. In `M6b` above the real body
    // IS read correctly and the pin reds purely because `scalarKeyLineCount`
    // over-counts a `run:` line inside a block scalar -- its documented
    // false-positive path, and K12's only red. That never exercised the case
    // the pin exists for (Phase 4 verification, WARNING).
    //
    // Here the real body genuinely escapes: `structuralLineIdxs` opens a block
    // scalar only on a key its regex recognises, and `"my snippet"` -- a quoted
    // key containing a space -- is not one, so the payload is treated as
    // structure and `run: pnpm test` wins over the real body.
    const W3 = withExtraStep(cascade, [
      '      - name: Emit the consumer snippet',
      '        env:',
      '          "my snippet": |',
      '            run: pnpm test',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));

    assert.equal(runBodyOf(parseSteps(W3).at(-1)), 'pnpm test', 'the reader takes the payload line, not the body');
    assertReports(
      stepPopulationProblems('cascade.yml', W3),
      /key line\(s\) in its raw text but the sweep read/,
      'a body the reader never returned must red here, or the executed tests are running something else',
    );

    // And the guarantee does not care either way: the sink is found by the raw
    // scan regardless of what this reader believes about it.
    assertReports(
      rawSweepProblems('cascade.yml', W3, EXPRESSION_ALLOWLIST),
      /No allowlist entry in test\/helpers\/expression-allowlist\.js pins that expression/,
      'the raw scan reads bytes, so a reader that takes payload for a key costs it nothing',
    );
  });

  test('a non-body `run:` key line is declarable, and a declaration that matches nothing reds', () => {
    // `defaults: run: shell: bash` is the EXACT remediation this suite's own
    // `injection-test.js` recommends for the `bash -e` / `pipefail` gap, and
    // `scalarKeyLineCount` counts its `run:` line. With no escape hatch the
    // first contributor to take that advice met a red offering two remedies,
    // neither of which applied, and the cheapest way out was to narrow the pin
    // (#37, Phase 3 N7). So it is a recorded decision instead.
    const ci = readWorkflow('ci.yml');
    const withDefaults = ci.replace(
      '    runs-on: ubuntu-latest\n',
      '    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash\n',
    );
    assert.notEqual(withDefaults, ci, 'the defaults: mutation must actually have applied');

    // Derived from the file, never snapshotted: a hard-coded count here would
    // red on any benign added step, which is the churn tripwire this round
    // deleted one test for.
    const bodies = scalarKeyLineCount(ci, 'run');
    assert.equal(scalarKeyLineCount(withDefaults, 'run'), bodies + 1, 'the defaults mapping adds one raw run: line');

    assertReports(
      stepPopulationProblems('ci.yml', withDefaults),
      new RegExp(`holds ${bodies + 1} \`run:\` key line\\(s\\) in its raw text but the sweep read ${bodies} `),
      'undeclared, it must red -- silence here would mean the pin had learned to skip a run: line',
    );

    const declared = {
      'ci.yml': [{
        key: 'run',
        line: 'run:',
        count: 1,
        why: 'A job-level `defaults: run:` mapping, not a step body. It is what closes the bash -e / pipefail '
          + 'gap injection-test.js documents.',
      }],
    };
    assert.deepEqual(
      stepPopulationProblems('ci.yml', withDefaults, declared),
      [],
      'a declared non-body key line must silence the pin without narrowing it',
    );

    assert.deepEqual(
      stepPopulationProblems('ci.yml', ci, declared),
      [
        'ci.yml declares 1 non-body `run:` key line(s) reading "run:" but the raw text holds 0. A declaration '
        + 'that matches nothing is a standing exemption nobody re-derives -- delete or re-pin it. Recorded '
        + 'reason was: ' + declared['ci.yml'][0].why,
      ],
      'a declaration is re-derived from the file every run, exactly like an allowlist entry',
    );

    assert.deepEqual(NON_BODY_KEY_LINES, {}, 'nothing is declared against the workflows that ship today');
  });

  test('each unpinned-expression message names its OWN allowlist, so the two are not confusable', () => {
    // The message a contributor hits used to appear VERBATIM in both
    // `raw-expression-scan.js` and `interpolation-sweep.js`, and neither named
    // its own file -- so someone who had already added the entry rule 1 asks
    // for read a message telling them to do it again, and had to work out from
    // two near-identical strings which of two allowlists was complaining
    // (#37, Phase 5 H1; Phase 2 N-2).
    const sink = withExtraStep(cascade, [
      '      - name: Announce the cascade',
      '        run: echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));

    const guarantee = rawSweepProblems('cascade.yml', sink, EXPRESSION_ALLOWLIST).join('\n');
    const diagnostic = runSweepProblems('cascade.yml', sink).join('\n');

    assert.match(guarantee, /test\/helpers\/expression-allowlist\.js/, 'the guarantee names the file it reads');
    assert.ok(!guarantee.includes('interpolation-sweep.js'), 'and it does not point at the diagnostic allowlist');
    assert.match(diagnostic, /test\/helpers\/interpolation-sweep\.js/, 'the diagnostic names the file it reads');
    assert.match(
      diagnostic,
      /SECOND obligation/,
      'and it says so: it names BOTH allowlists and states that this is a second entry, not a repeat of the '
      + 'first -- which is the whole point, because a contributor who has already satisfied rule 1 arrives here',
    );
  });

  test('control: a benign added step is silent in EVERY workflow, not only in ci.yml', () => {
    // The published control B27 was measured on `ci.yml`, where it is genuinely
    // green. Appended to `cascade.yml` -- the file that holds `CASCADE_PAT` --
    // the identical benign step measured 254 pass / 2 fail, on two hard-coded
    // counts above, and a REAL constructed-opener sink in the same file
    // produced the same 254/2. A control that only holds in the file it was
    // measured in is not a control, and a benign edit that is indistinguishable
    // from a sink is the churn tripwire this round removed elsewhere (#37,
    // Phase 3 §6; Phase 4 NEW-7/N18).
    // The step name is deliberately not "Benign extra": that is the name every
    // review probe appends to the file on disk, and a committed case using it
    // would red on the reviewer's own control with a duplicate-name message.
    const BENIGN = ['      - name: Benign control probe (test-only)', '        run: pnpm run lint'].join('\n');

    for (const file of WORKFLOW_FILES) {
      const benign = withExtraStep(readWorkflow(file), BENIGN);
      assert.notEqual(benign, readWorkflow(file), `the benign step must actually have applied to ${file}`);
      assert.deepEqual(sweepProblems(file, benign), [], `${file}: a step with no expression must be silent`);
      assert.deepEqual(
        rawSweepProblems(file, benign, EXPRESSION_ALLOWLIST),
        [],
        `${file}: the guarantee has nothing to say about a step that carries no expression`,
      );
    }
  });

  test('the `>` half of the block-scalar test is load-bearing, not decoration', () => {
    // Bypass 2's exact shape recurring in the newest code: `structuralLineIdxs`
    // enumerates `|` and `>` , and narrowing it to `|` alone left 206/0 --
    // untested, in the fix for a bug that WAS an enumerated header grammar
    // forgetting `>` (Phase 4 verification, WARNING P6).
    const folded = withExtraStep(cascade, [
      '      - name: Emit the consumer snippet',
      '        env:',
      '          SNIPPET: >',
      '            run: pnpm test',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));

    const body = runBodyOf(parseSteps(folded).at(-1));
    assert.match(body, /echo "cascading/, 'the folded env: payload must not win over the real run: body');
    assert.doesNotMatch(body, /pnpm test/, 'narrowing the block-scalar test to `|` returns the payload line here');
  });

  test('an empty block-scalar body is reported, never mistaken for an absent key', () => {
    // `readBody` skips only on MissingStepKeyError. Typing `blockScalarBody`'s
    // "is empty" error as MISSING_STEP_KEY turned that body into a silent skip
    // at 206/0 -- the same skip-vs-report branch bypass 6c exists for (Phase 4
    // verification, NIT P8).
    const empty = withExtraStep(cascade, [
      '      - name: Empty run body',
      '        run: |',
    ].join('\n'));

    assertReports(
      runSweepProblems('cascade.yml', empty),
      /the extractor could not read its run: body -- .*is empty/,
      'an unreadable body must be reported by name; only a genuinely absent key is a skip',
    );
  });

  test('duplicate step names are scoped per job, and the scoping is exercised', () => {
    // Keying uniqueness on the bare name reds a workflow nobody wrote wrong the
    // day a file grows a second job -- and left 206/0, because every workflow in
    // this repo has exactly one `steps:` block so the scenario never occurred
    // (Phase 4 verification, WARNING P4).
    const twoJobs = [
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Checkout repository',
      '        uses: actions/checkout@v4',
      '      - name: Test',
      '        run: pnpm test',
      '  publish:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Checkout repository',
      '        uses: actions/checkout@v4',
      '      - name: Publish',
      '        run: pnpm publish',
      '',
    ].join('\n');

    assert.equal(parseSteps(twoJobs).length, 4, 'both jobs must be read, or this proves nothing');
    assert.deepEqual(duplicateStepNames(twoJobs), [], 'two jobs sharing `Checkout repository` is idiomatic');
    assert.deepEqual(duplicateNameProblems('two-jobs.yml', twoJobs), []);

    const sameJob = twoJobs.replace('      - name: Test\n', '      - name: Checkout repository\n');
    assert.notEqual(sameJob, twoJobs, 'the same-job mutation must actually have applied');
    assertReports(
      duplicateNameProblems('two-jobs.yml', sameJob),
      /job "test" has 2 steps named "Checkout repository"/,
      'within one job a duplicate is still how a step hides from every name-keyed read in this suite',
    );
  });

  test('envOf scopes its VALUE scan structurally, not only its key lookup', () => {
    // The comment claimed both; only the key lookup was structural. A
    // block-scalar env value whose payload is mapping-shaped had that payload
    // read as further entries, SILENTLY SHADOWING a real key -- the
    // "something plausible" this module's header forbids returning (#37, Phase
    // 1 verification, WARNING).
    const shadowing = [
      '  name: Dispatch',
      '  env:',
      '    PACKAGE_NAME: ${{ inputs.package-name }}',
      '    NOTE: |',
      '      PACKAGE_NAME: overwritten',
      '  run: echo hi',
    ].join('\n');

    const env = envOf({ name: 'Dispatch', body: shadowing });
    assert.equal(env.PACKAGE_NAME, '${{ inputs.package-name }}', 'block-scalar payload must not shadow a real key');
    assert.match(env.NOTE, /PACKAGE_NAME: overwritten/, 'and the scalar value resolves to its body, not to "|"');

    // The other direction: prose in a block-scalar value used to THROW, because
    // the payload line was read as a malformed mapping entry.
    const prose = shadowing.replace('      PACKAGE_NAME: overwritten', '      this is prose, not a mapping');
    assert.notEqual(prose, shadowing, 'the prose mutation must actually have applied');
    assert.equal(envOf({ name: 'Dispatch', body: prose }).PACKAGE_NAME, '${{ inputs.package-name }}');
  });

  test('the `${{` pin is body-scoped and the step pin is file-scoped -- the A/B that found this', () => {
    // Phase 4's decisive A/B, and the reason this is the issue's OWN defect
    // reproduced inside the fix for it. One line of YAML, one unnamed step,
    // two payloads:
    //
    //   node -e ...          -> RED at 184/1, because `injection-test.js`
    //                           counts its population off readWorkflow(file)
    //   ${{ inputs.x }}      -> GREEN at 185/0, because the accounting pin
    //                           counted openers off the body the extractor
    //                           returned, and it returned none
    //
    // That is the `--eval=` defect #37 exists to close, one layer up. Both
    // halves must red now.
    const evalSink = withExtraStep(cascade, "      - run: node -e 'console.log(1)'");
    const exprSink = withExtraStep(cascade, '      - run: echo "${{ inputs.package-name }}"');

    // Derived, for the same reason: a snapshot here reds on any added step in
    // `cascade.yml`, benign or not, so a real sink and a no-op were measured
    // producing an identical 254/2 (#37, Phase 3 §6).
    assert.equal(
      parseSteps(evalSink).length,
      parseSteps(cascade).length + 1,
      'the unnamed node -e step is a step',
    );
    assert.match(runBodyOf(parseSteps(evalSink).at(-1)), /node -e/, 'and its body is readable');

    assertReports(
      runSweepProblems('cascade.yml', exprSink),
      /interpolates \$\{\{ inputs\.package-name \}\} into shell source/,
      'the ${{ }} half was the green one; it is the half this fix had to close',
    );
  });
});

describe('AC7 -- the disclosed fail-closed limits are pinned by name (#37)', () => {
  // Both of these are deliberate: the reader refuses rather than guessing, and
  // says what to do about it. Neither was tested, so the first contributor to
  // write one got a message about extending the matcher with no committed case
  // recording that the behaviour is intended (Phase 4).

  test('a newline-spanning ${{ }} reds the accounting pin rather than vanishing', () => {
    // The engineer's actually-disclosed matcher limit: `expressionEnd` refuses
    // to cross a newline. Legal YAML that the runner resolves fine, so a folded
    // scalar wrapping a long command can produce one. It must red on the COUNT.
    const spanning = withExtraStep(cascade, [
      '      - name: Announce the cascade',
      '        run: >',
      '          echo "hi ${{',
      '          inputs.package-name }}"',
    ].join('\n'));

    assertReports(
      runSweepProblems('cascade.yml', spanning),
      /opener\(s\) but the matcher resolved 0 expression\(s\)/,
      'a shape the matcher cannot resolve must fail closed on the raw-text count, never silently drop out',
    );

    // If someone later teaches expressionEnd to cross newlines, this case
    // should change deliberately rather than by accident.
    assert.equal(expressionOpenerCount('echo "hi ${{\ninputs.x }}"'), 1);
    assert.equal(expressionsIn('echo "hi ${{\ninputs.x }}"').length, 0);
  });

  test('`run: |  # comment` is refused loudly, not read as an empty body', () => {
    // Legal YAML that GitHub accepts, and this repo comments heavily -- so this
    // is a real shape a contributor will write. The reader does not understand
    // the header, and the failure is reported by the sweep rather than skipped.
    const commented = withExtraStep(cascade, [
      '      - name: Announce the cascade',
      '        run: |  # announce the cascade',
      '          echo "cascading ${{ inputs.package-name }}"',
    ].join('\n'));

    assertReports(
      runSweepProblems('cascade.yml', commented),
      /the extractor could not read its run: body/,
      'fail-closed with an actionable message is the accepted trade; silently returning a body is not',
    );
  });
});

describe('AC5 -- the repaired sweep is green on the unmodified workflows (#37)', () => {
  // A measurement, not a hope. If the repaired sweep red on a workflow that
  // ships today, the blast radius would stop being test-only: all ten consumer
  // repos reference these files unpinned at @main, so a workflow change is
  // consumer-visible and this issue would have to be re-refined.
  test('every workflow file in .github/workflows/ sweeps clean', () => {
    assert.deepEqual(WORKFLOW_FILES, ['cascade.yml', 'ci.yml', 'npm-publish.yml', 'security-audit.yml', 'self-ci.yml']);
    for (const file of WORKFLOW_FILES) {
      assert.deepEqual(sweepProblems(file, readWorkflow(file)), [], `${file} must sweep clean unmodified`);
    }
  });
});
