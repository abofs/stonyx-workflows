import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EXPRESSION_ALLOWLIST } from './helpers/expression-allowlist.js';
import {
  entryShapeProblems,
  rawExpressions,
  rawSweepProblems,
  readWorkflowFile,
  referencesIn,
  workflowFileNames,
} from './helpers/raw-expression-scan.js';

// The repo-wide `${{ }}` guarantee (abofs/stonyx-workflows#37).
//
// Three review rounds found nine ways to hide an expression from a sweep built
// on a YAML reader, each one after the previous fix shipped. This file proves
// the replacement: a raw byte scan over every file in `.github/workflows/`,
// enumerated with no extension filter, whose result must be pinned entry by
// entry in `test/helpers/expression-allowlist.js`.
//
// The claim being tested is a construction claim, and it is worth stating in
// the narrow form that is actually true. It is NOT "no bypass exists". It is:
// none of these shapes can hide an occurrence, BECAUSE NOTHING HERE PARSES
// YAML. The families below are re-run anyway -- a construction argument that
// nobody re-measured is how the last three rounds each started.
//
// The extractor in `test/helpers/workflow-yaml.js` is DIAGNOSTICS ONLY from
// here on. It still names which step and which sink an expression sits in, and
// the executed `run:`-body tests still need real step bodies from it. If it is
// wrong, a message gets less helpful; nothing goes unswept.

const cascade = readWorkflowFile('cascade.yml');
const FIXTURE = readFileSync(new URL('./fixtures/security-audit-e07e185.yml', import.meta.url), 'utf8');

/** Append a step to a workflow's `steps:` list. Every workflow here sits at six spaces. */
const appendStep = (text, stepYaml) => `${text.replace(/\n+$/, '\n')}\n${stepYaml.replace(/\n+$/, '')}\n`;

const step = (...lines) => lines.join('\n');

/** Assert at least one problem matches, and print what was actually reported when none does. */
function assertReports(problems, pattern, why) {
  assert.ok(
    problems.some((p) => pattern.test(p)),
    `${why}\nexpected a problem matching ${pattern}\ngot:\n${problems.map((p) => `  - ${p}`).join('\n') || '  (none)'}`,
  );
}

const sweep = (file, text, allowlist = EXPRESSION_ALLOWLIST) => rawSweepProblems(file, text, allowlist);

const UNPINNED = /No allowlist entry pins that expression to that line/;

describe('G1 -- the raw ${{ }} guarantee is green on the workflows that ship (#37)', () => {
  // AC5's successor. If this ever reds on an unmodified workflow the blast
  // radius stops being test-only: ten consumer repos reference these files
  // unpinned at @main, so a workflow change is consumer-visible.

  const FILES = workflowFileNames();

  test('every file in .github/workflows/ is enumerated, with no extension filter', () => {
    // The previous version of this pin deep-equalled the ALREADY-FILTERED list,
    // so a `.github/workflows/evil.yaml` was removed before the assertion could
    // see it -- measured at 206 pass / 0 fail with a live `workflow_call` input
    // reaching a shell body (#37, Phase 3 §4). This list is the raw directory.
    assert.deepEqual(FILES, ['cascade.yml', 'ci.yml', 'npm-publish.yml', 'security-audit.yml', 'self-ci.yml']);
  });

  test('the enumerator applies no extension filter at all', () => {
    // Proven against a directory rather than asserted about one, so restoring
    // `.filter((n) => n.endsWith('.yml'))` reds here rather than silently
    // shrinking the population every other case quantifies over.
    const dir = mkdtempSync(join(tmpdir(), 'raw-sweep-enum-'));
    try {
      for (const name of ['b.yml', 'a.yaml', 'c.txt', 'd']) writeFileSync(join(dir, name), 'x\n');
      assert.deepEqual(workflowFileNames(pathToFileURL(`${dir}/`)), ['a.yaml', 'b.yml', 'c.txt', 'd']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const file of FILES) {
    test(`every ${'${{ }}'} occurrence in ${file} is pinned to its source line with a reason`, () => {
      assert.deepEqual(sweep(file, readWorkflowFile(file)), []);
    });
  }

  test('the allowlist accounts for all 42 occurrences and nothing else', () => {
    // Two independent counts of the same thing. `rawExpressions` emits exactly
    // one record per opener; `split` counts openers without looking at records.
    // The allowlist's own `occurrences` sum is the third.
    let scanned = 0;
    let split = 0;
    for (const file of FILES) {
      const text = readWorkflowFile(file);
      scanned += rawExpressions(text).length;
      split += text.split('${{').length - 1;
    }

    const entries = Object.values(EXPRESSION_ALLOWLIST).flat();
    const pinned = entries.reduce((sum, e) => sum + e.occurrences, 0);

    assert.equal(scanned, 42, 'the scanner must see every opener in the five files');
    assert.equal(split, 42, 'and an independent count of the raw bytes must agree with it');
    assert.equal(pinned, 42, 'the allowlist must pin exactly as many occurrences as the files carry');
    assert.equal(entries.length, 36, '42 occurrences across 36 distinct (line, expression) pairs');
    assert.deepEqual(
      Object.keys(EXPRESSION_ALLOWLIST).sort(),
      FILES,
      'every file in the directory has an allowlist section, even if it is empty',
    );
  });

  test('no two entries within a file share a reason', () => {
    // Bulk approval is the failure mode an allowlist has. `entryShapeProblems`
    // already refuses a `why` that names none of its own expression's
    // references; this refuses forty-two copies of one sentence.
    for (const [file, entries] of Object.entries(EXPRESSION_ALLOWLIST)) {
      const reasons = entries.map((e) => e.why);
      assert.equal(new Set(reasons).size, reasons.length, `${file} has two allowlist entries with the same why:`);
    }
  });
});

describe('G1 -- the scanner owes nothing to the YAML reader (#37)', () => {
  // PR #38's previous "independent" population pin was independent in prose and
  // shared the literal `/^\s*steps:\s*$/` with the extractor it audited, so it
  // was blind in exactly the same place (Phase 3 §5). These are the mechanical
  // versions of that claim, and a reviewer grepping for a shared regex should
  // find these assertions doing it first.
  const SCANNER = new URL('./helpers/raw-expression-scan.js', import.meta.url);
  const source = readFileSync(SCANNER, 'utf8');
  const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

  test('it imports nothing but node: builtins', () => {
    const imports = source.split('\n').filter((l) => l.startsWith('import '));
    assert.ok(imports.length > 0, 'if this file stops importing anything the check below is vacuous');
    for (const line of imports) {
      assert.match(line, /from 'node:/, `the raw scanner may not import ${line}`);
    }
    assert.ok(!code.includes('workflow-yaml'), 'no path into the extractor');
    assert.ok(!code.includes('interpolation-sweep'), 'no path into the extractor-based sweep');
  });

  test('it contains no regular expression at all, so it cannot share one', () => {
    // The strongest form of "shares no literals": there are no regex literals
    // to share. Every escape in the code is `\n`; a regex literal cannot be
    // written without introducing another.
    for (const call of ['RegExp', '.match(', '.matchAll(', '.test(', '.exec(', '.search(', '.replace(']) {
      assert.ok(!code.includes(call), `the raw scanner must not use ${call}`);
    }
    const escapes = [...code].map((c, i) => (c === '\\' ? code[i + 1] : null)).filter((c) => c !== null);
    assert.ok(escapes.length > 0, "if there are no escapes at all, split('\\n') has gone and this is vacuous");
    assert.deepEqual([...new Set(escapes)], ['n'], 'the only escape sequence in the raw scanner is \\n');
  });

  test('the extractor and its sweep are not in this file scan path at all', () => {
    // The guarantee is `rawSweepProblems`. Nothing it calls reaches
    // `parseSteps`, `stepScalar`, `readBody` or `structuralLineIdxs`, and the
    // check above is what keeps that true rather than this sentence.
    for (const symbol of ['parseSteps', 'stepScalar', 'readBody', 'structuralLineIdxs', 'expressionsIn']) {
      assert.ok(!source.includes(symbol), `${symbol} must not appear in the raw scanner, even in a comment`);
    }
  });
});

describe('G1 -- every bypass family from all ten PR #38 reviews reds (#37)', () => {
  // The table. Each row is a shape that was MEASURED green against the
  // reader-based sweep at some point in this issue's life; every one of them
  // now reds on the raw scan, and none of the fixes for them is what makes it
  // red -- there is nothing to disagree with a byte scan about.
  const FAMILIES = [
    ['1  duplicate step name, run: sink', appendStep(cascade, step(
      '      - name: Checkout stonyx-workflows (for dependency map)',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ))],
    ['1  duplicate step name, script: sink', appendStep(cascade, step(
      '      - name: Dispatch to downstream dependents',
      '        uses: actions/github-script@v7',
      '        with:',
      '          script: |',
      "            const n = '${{ inputs.package-name }}';",
    ))],
    ['2  run: > folded block scalar', appendStep(cascade, step(
      '      - name: Announce the cascade',
      '        run: >',
      '          echo "cascading ${{ inputs.package-name }}"',
    ))],
    ['3  ${{ format(\'{0}\', ...) }}', appendStep(cascade, step(
      '      - name: Announce the cascade',
      '        run: |',
      "          echo \"cascading ${{ format('{0}', inputs.package-name) }}\"",
    ))],
    ['6  eval \"...\" relocation (NEW-5)', appendStep(cascade, step(
      '      - name: Announce the cascade',
      '        run: eval "echo ${{ inputs.package-name }}"',
    ))],
    ['6a unnamed step, inline run:', appendStep(cascade, '      - run: echo "${{ inputs.package-name }}"')],
    ['6a unnamed step, block run:', appendStep(cascade, step(
      '      - run: |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ))],
    ['6a unnamed github-script step', appendStep(cascade, step(
      '      - uses: actions/github-script@v7',
      '        with:',
      '          script: |',
      "            const n = '${{ inputs.package-name }}';",
    ))],
    ['6a uses: first, name: second', appendStep(cascade, step(
      '      - uses: actions/github-script@v7',
      '        name: Second dispatch',
      '        with:',
      '          script: |',
      "            const n = '${{ inputs.package-name }}';",
    ))],
    ['6a with: first, uses: last, no name', appendStep(cascade, step(
      '      - with:',
      '          script: |',
      "            const n = '${{ inputs.package-name }}';",
      '        uses: actions/github-script@v7',
    ))],
    ['6a item-level flow mapping', appendStep(cascade, "      - {name: Flow, run: 'echo \"${{ inputs.package-name }}\"'}")],
    ['6a alias resolved on the next line', appendStep(cascade, step(
      '      - name: Anchor holder',
      '        run: &sink echo "${{ inputs.package-name }}"',
      '      - name: Alias run',
      '        run:',
      '          *sink',
    ))],
    ['6b run: nested in an earlier block scalar', appendStep(cascade, step(
      '      - name: Emit the consumer snippet',
      '        env:',
      '          SNIPPET: |',
      '            run: pnpm test',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ))],
    ['6c quoted "run": key', appendStep(cascade, step(
      '      - name: Quoted key',
      '        "run": |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ))],
    ['N1a multi-line plain scalar run:', appendStep(cascade, step(
      '      - name: Plain scalar',
      '        run: echo',
      '          "${{ inputs.package-name }}"',
    ))],
    ['N1b multi-line double-quoted scalar run:', appendStep(cascade, step(
      '      - name: Double quoted scalar',
      '        run: "echo',
      '          ${{ inputs.package-name }}"',
    ))],
    ['N1c multi-line single-quoted scalar run:', appendStep(cascade, step(
      '      - name: Single quoted scalar',
      "        run: 'echo",
      "          ${{ inputs.package-name }}'",
    ))],
    ['N1d multi-line double-quoted with: script:', appendStep(cascade, step(
      '      - name: Multi-line script',
      '        uses: actions/github-script@v7',
      '        with:',
      '          script: "console.log(',
      '            \'${{ inputs.package-name }}\')"',
    ))],
    ['N2 single-line flow mapping under with:', appendStep(cascade, step(
      '      - uses: actions/github-script@v7',
      '        name: Flow with',
      "        with: {script: 'console.log(\"${{ inputs.package-name }}\")'}",
    ))],
    ['N4 explicit key ? run', appendStep(cascade, step(
      '      - name: Explicit key',
      '        ? run',
      '        : echo "${{ inputs.package-name }}"',
    ))],
    ['N5 escaped double-quoted key', appendStep(cascade, step(
      '      - name: Escaped key',
      '        "ru\\x6e": |',
      '          echo "cascading ${{ inputs.package-name }}"',
    ))],
  ];

  for (const [family, mutated] of FAMILIES) {
    test(`${family} -- the expression is found and has no entry`, () => {
      assert.notEqual(mutated, cascade, `the ${family} mutation must actually have applied`);
      assertReports(
        sweep('cascade.yml', mutated),
        UNPINNED,
        'a raw byte scan cannot be evaded by YAML shape; if this is green the scan has grown an opinion',
      );
    });
  }

  test('a whole .yaml workflow file is swept like any other file', () => {
    // Measured at 206 pass / 0 fail before this change: a complete, valid
    // reusable workflow whose only step carried `${{ inputs.package-name }}`
    // into a shell body, invisible because both enumerations filtered to
    // `.yml` (#37, Phase 3 §4).
    const dir = mkdtempSync(join(tmpdir(), 'raw-sweep-yaml-'));
    try {
      writeFileSync(join(dir, 'evil.yaml'), step(
        'name: Evil',
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      package-name:',
        '        required: true',
        '        type: string',
        'jobs:',
        '  evil:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Sink',
        '        run: echo "${{ inputs.package-name }}"',
        '',
      ));
      const dirUrl = pathToFileURL(`${dir}/`);
      const names = workflowFileNames(dirUrl);
      assert.deepEqual(names, ['evil.yaml'], 'the enumerator must list a .yaml file');
      assertReports(
        rawSweepProblems('evil.yaml', readWorkflowFile('evil.yaml', dirUrl), EXPRESSION_ALLOWLIST),
        UNPINNED,
        'a file with no allowlist section has no entries, so every expression in it is unpinned',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('G1 -- the guarantee fails closed (#37)', () => {
  // Three ways to red, each measured. An unanticipated shape must not be able
  // to fall out of the population -- that is the failure mode the reader-based
  // sweep had at every level it was pinned at.

  test('an expression on a #-comment line is a live sink, never exempt', () => {
    // The runner substitutes `${{ }}` into a run: body TEXTUALLY before bash
    // parses it, and a workflow_call input can contain a newline. Executed
    // under `bash --noprofile --norc -e` with
    // inputs.audit-level = "moderate\ntouch /tmp/canary/PWNED\n#": exit 0, and
    // the canary written. A raw scan does not know what a comment is, which is
    // the correct amount of knowledge to have about one.
    const commented = appendStep(cascade, step(
      '      - name: Announce the cascade',
      '        run: |',
      '          # cascading ${{ inputs.package-name }}',
      '          echo done',
    ));
    assertReports(sweep('cascade.yml', commented), UNPINNED, 'a commented expression is substituted, so it is a sink');
  });

  test('a second copy on an allowlisted line reds on the pinned occurrence count', () => {
    const doubled = appendStep(cascade, step(
      '      - name: Second dispatch',
      '        env:',
      '          PACKAGE_NAME: ${{ inputs.package-name }}',
      '        run: echo done',
    ));
    assertReports(
      sweep('cascade.yml', doubled),
      /carries \$\{\{ inputs\.package-name \}\} 2 time\(s\).*its allowlist entry pins 1/s,
      'an entry exempts a stated number of occurrences on a stated line, not a line pattern',
    );
  });

  test('an opener that does not close on its own line reds rather than being dropped', () => {
    const spanning = appendStep(cascade, step(
      '      - name: Announce the cascade',
      '        run: >',
      '          echo "hi ${{',
      '          inputs.package-name }}"',
    ));
    const occurrences = rawExpressions(spanning).filter((e) => e.expression === null);
    assert.equal(occurrences.length, 1, 'the scanner must still emit a record for an opener it cannot close');
    assertReports(
      sweep('cascade.yml', spanning),
      /does not close on the same line/,
      'a shape the scanner does not model must report itself, never vanish from the population',
    );
  });

  test('an unparseable expression reds -- there is no shape the scan skips', () => {
    const unparseable = appendStep(cascade, step(
      '      - name: Announce the cascade',
      '        run: |',
      '          echo "cascading ${{ inputs.package-name }"',
    ));
    assertReports(
      sweep('cascade.yml', unparseable),
      /does not close on the same line/,
      'the old matcher DROPPED an opener it could not resolve and leaned on a separate count to notice',
    );
  });

  test('a stale entry that matches nothing is reported dead', () => {
    // A deleted entry and a never-consulted entry look identical from a green
    // suite, so the exemption is re-derived from the file every run.
    const stale = {
      'cascade.yml': [
        ...EXPRESSION_ALLOWLIST['cascade.yml'],
        {
          line: 'AUDIT_LEVEL: ${{ inputs.audit-level }}',
          expression: '${{ inputs.audit-level }}',
          occurrences: 1,
          why: 'A deliberately dead entry: inputs.audit-level appears nowhere in cascade.yml, so this must be '
            + 'reported rather than sitting silently as a standing exemption.',
        },
      ],
    };
    assertReports(
      rawSweepProblems('cascade.yml', cascade, stale),
      /allowlist entry is dead/,
      'an exemption whose expression is gone must not survive as a standing permission',
    );
  });

  test('#34: fixing the sink kills its entry, whether or not a comment quotes it', () => {
    // The scheduled trigger. #34 moves `inputs.audit-level` to a step env: and
    // reads "$AUDIT_LEVEL". With the entry left in place the suite must red --
    // once as a dead entry, and again on the comment if the fix leaves one.
    const SINK = '        run: pnpm audit --audit-level ${{ inputs.audit-level }}';
    const AL = { 'security-audit.yml': EXPRESSION_ALLOWLIST['security-audit.yml'] };
    const fix34 = ({ comment }) => FIXTURE.replace(SINK, step(
      '        env:',
      '          AUDIT_LEVEL: ${{ inputs.audit-level }}',
      '        run: |',
      ...(comment ? ['          # Was: pnpm audit --audit-level ${{ inputs.audit-level }} -- now via env (#34).'] : []),
      '          pnpm audit --audit-level "$AUDIT_LEVEL"',
    ));

    assert.ok(FIXTURE.includes(SINK), 'the fixture must still carry the #34 sink line to mutate it');
    assert.deepEqual(rawSweepProblems('security-audit.yml', FIXTURE, AL), [], 'calibration: unmutated is clean');

    for (const comment of [true, false]) {
      const fixed = fix34({ comment });
      assert.notEqual(fixed, FIXTURE, `the #34 fix (comment=${comment}) must actually have applied`);
      assertReports(
        rawSweepProblems('security-audit.yml', fixed, AL),
        /allowlist entry is dead/,
        'a fixed sink must lose its exemption; deleting the entry is what #34 owes, not an assertion about it',
      );
      // The new env: line is itself an unpinned expression, so #34 also has to
      // write the entry that approves the remediation it introduces.
      assertReports(rawSweepProblems('security-audit.yml', fixed, AL), UNPINNED, 'the env: line needs its own entry');
    }

    // Positive re-arming: with the sink fixed and the entry deleted, putting
    // the original line back must red. A green here means the exemption
    // survived somewhere and the guarantee is gone.
    const fixedAndDisarmed = fix34({ comment: false });
    const disarmed = { 'security-audit.yml': [] };
    const reArmed = fixedAndDisarmed.replace(
      '          pnpm audit --audit-level "$AUDIT_LEVEL"',
      '          pnpm audit --audit-level ${{ inputs.audit-level }}',
    );
    assert.notEqual(reArmed, fixedAndDisarmed, 'the re-arming replacement must actually have applied');
    assertReports(
      rawSweepProblems('security-audit.yml', reArmed, disarmed),
      UNPINNED,
      'the guarantee must be positively re-armable; a sweep that stays green here is guarding nothing',
    );
  });
});

describe('G1 -- an allowlist entry has to say something (#37)', () => {
  // The allowlist is the review artifact, so a bulk approval must not be
  // expressible. These are the entry-shape refusals, each shown firing.
  const GOOD = EXPRESSION_ALLOWLIST['ci.yml'][0];

  test('the live entries are all well-formed', () => {
    for (const [file, entries] of Object.entries(EXPRESSION_ALLOWLIST)) {
      for (const entry of entries) assert.deepEqual(entryShapeProblems(file, entry), []);
    }
  });

  test('an entry with no line: is refused', () => {
    assertReports(
      entryShapeProblems('ci.yml', { ...GOOD, line: undefined }),
      /has no line:/,
      'an entry without a line exempts its expression anywhere in the file -- bypass 4 and NEW-5',
    );
  });

  test('an entry whose line does not carry its expression is refused', () => {
    assertReports(
      entryShapeProblems('ci.yml', { ...GOOD, line: 'version: 9' }),
      /pins a line that does not contain the expression/,
      'a typo in either field would otherwise produce an entry that can never match and never be noticed',
    );
  });

  test('a generic reason is refused because it names none of the expression\'s references', () => {
    assertReports(
      entryShapeProblems('ci.yml', { ...GOOD, why: 'Safe. Not a shell sink. Reviewed and approved on the PR.' }),
      /names none of the expression's own references/,
      'a reason that could be pasted onto any of the 42 entries is not a reason',
    );
    assert.deepEqual(referencesIn(GOOD.expression), ['inputs.pnpm-version']);
  });

  test('an unpinned occurrence count is refused', () => {
    assertReports(
      entryShapeProblems('ci.yml', { ...GOOD, occurrences: 0 }),
      /positive integer occurrences:/,
      'an unpinned count tolerates a second copy of the expression on the same line for free',
    );
  });
});
