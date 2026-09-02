import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import {
  ALLOWLIST,
  deadAllowlistProblems,
  duplicateNameProblems,
  runSweepProblems,
  scriptSweepProblems,
  sweepProblems,
} from './helpers/interpolation-sweep.js';
import {
  expressionOpenerCount,
  expressionsIn,
  parseSteps,
  readWorkflow,
  runBodyOf,
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

const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);
const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR).filter((n) => n.endsWith('.yml')).sort();

/** Append a step to a workflow's `steps:` list. The list sits at six spaces in every file here. */
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
  const ORIGINAL_SINK = '        run: pnpm audit --audit-level ${{ inputs.audit-level }}';
  assert.ok(securityAudit.includes(ORIGINAL_SINK), 'the #34 sink line must still be present to mutate');

  /** #34's likely fix shape: the input moved to step `env:`, the body reading "$AUDIT_LEVEL". */
  const fix34 = ({ comment }) => securityAudit.replace(ORIGINAL_SINK, [
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
  const NEW5 = securityAudit.replace(
    ORIGINAL_SINK,
    '        run: eval "pnpm audit --audit-level ${{ inputs.audit-level }}"',
  );

  test('M4: #34 fix plus a run-body comment quoting the expression reds twice', () => {
    assertReports(
      deadAllowlistProblems('security-audit.yml', M4),
      /no longer carries the exempted source line/,
      'the entry must be named DEAD -- the sink it recorded is gone. 161/0 green before the line pin.',
    );
    assertReports(
      runSweepProblems('security-audit.yml', M4),
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
      deadAllowlistProblems('security-audit.yml', CALIBRATION),
      /no longer carries the exempted source line/,
      'deleting the entry is what #34 must do; keeping it must stay red',
    );
    assert.deepEqual(
      runSweepProblems('security-audit.yml', CALIBRATION),
      [],
      'without the comment there is no expression left in the run: body, so the run sweep is clean',
    );
  });

  test('NEW-5: relocating the expression into eval "..." reds the sweep', () => {
    assertReports(
      runSweepProblems('security-audit.yml', NEW5),
      /interpolates \$\{\{ inputs\.audit-level \}\} into shell source/,
      'same step, same expression, same count -- the exemption pinned none of the position. 161/0 green.',
    );
    assertReports(
      deadAllowlistProblems('security-audit.yml', NEW5),
      /no longer carries the exempted source line/,
      "the entry's recorded `why` stopped describing reality and nothing noticed",
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
    // A structural guard on the allowlist, not on the workflows: an entry added
    // later without a `line` would fall back to exempting the whole step, which
    // is the shape bypass 4 and NEW-5 both exploited.
    for (const [file, entries] of Object.entries(ALLOWLIST)) {
      for (const entry of entries) {
        assert.equal(typeof entry.line, 'string', `${file}: allowlist entry for ${entry.expression} pins no line`);
        assert.ok(entry.line.includes(entry.expression), `${file}: the pinned line must carry the exempted expression`);
        assert.equal(entry.line, entry.line.trim(), `${file}: the pinned line is compared trimmed`);
      }
    }
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
