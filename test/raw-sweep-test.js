import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { EXPRESSION_ALLOWLIST } from './helpers/expression-allowlist.js';
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

/**
 * Every specifier the module at `url` resolves, recorded by a loader hook
 * registered in a CHILD PROCESS before the module is imported, with every
 * exported function then called.
 *
 * Reading `import` lines proves what a file says; this proves what the module
 * system did, which is the only thing that closes a dynamic `import()` inside a
 * function body. The module's own URL is dropped -- it is the entry point, not
 * a dependency.
 */
function resolvedGraph(url) {
  const dir = mkdtempSync(join(tmpdir(), 'raw-sweep-hook-'));
  try {
    const harness = join(dir, 'harness.mjs');
    writeFileSync(harness, step(
      "import { registerHooks } from 'node:module';",
      'const seen = [];',
      'registerHooks({ resolve(spec, ctx, next) { seen.push(spec); return next(spec, ctx); } });',
      'const mod = await import(process.argv[2]);',
      'for (const value of Object.values(mod)) {',
      "  if (typeof value !== 'function') continue;",
      '  try { await value(...new Array(value.length).fill(undefined)); } catch { /* shape, not behaviour */ }',
      '}',
      'console.log(JSON.stringify(seen));',
      '',
    ));
    const out = execFileSync(process.execPath, [harness, url.href], { encoding: 'utf8' });
    return JSON.parse(out).filter((spec) => spec !== url.href && !spec.startsWith('file://'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Every index in `code` where a regex literal could open -- a `/` that is not
 * inside a string literal.
 *
 * This is what "contains no regular expression at all" has to mean to be
 * checkable. The round-2 version listed method names, so a regex reached
 * through an unlisted one (`.split(`, `.replaceAll(`) was invisible; a scan for
 * the literal itself has no list to be incomplete.
 */
function regexOpeners(code) {
  const found = [];
  let quote = null;

  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '/') found.push(i);
  }

  return found;
}

/** The character after each backslash in `code`, stepping over the pair. */
function escapeSequences(code) {
  const found = [];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] !== '\\') continue;
    found.push(code[i + 1]);
    i += 1;
  }
  return found;
}

const sweep = (file, text, allowlist = EXPRESSION_ALLOWLIST) => rawSweepProblems(file, text, allowlist);

const UNPINNED = /No allowlist entry in test\/helpers\/expression-allowlist\.js pins that expression/;
const DEAD = /expression-allowlist\.js is dead/;
const CONSTRUCTED = /an opener can be CONSTRUCTED with no literal \$\{\{ in the bytes/;

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
  // versions of that claim.
  //
  // ROUND 3 REBUILT THEM, because two of the three could not see what they
  // excluded and one had already rotted (Phase 4 NEW-1/NEW-2 CRITICAL/HIGH;
  // Phase 1 F1/F2, independently):
  //
  //   * "no regex at all" was a seven-token blocklist. `.split(/\n/)` passed it
  //     -- `.split(` was not on the list -- and so did
  //     `.replaceAll(/ *steps: */g, ...)`, which is a whitespace-tolerant twin
  //     of the extractor's own `/^\s*steps:\s*$/`, the exact shared literal the
  //     pin exists to exclude, because `.replaceAll(` does not substring-match
  //     `.replace(` and the literal carries no backslash. Both 256 pass / 0
  //     fail. It is now a scan for regex literals themselves: a `/` outside a
  //     string is where one can open, and there must be none.
  //   * the import pin read only lines beginning `import `, so an INDENTED
  //     static import and a dynamic `import()` inside a function body were both
  //     invisible; a dynamic import of a re-export proxy defeated all three
  //     assertions at once at 256 pass / 0 fail. It is now backed by the
  //     module's RESOLVED DEPENDENCY GRAPH, recorded by a loader hook in a
  //     child process while the scanner's every exported function runs.
  //   * the symbol pin had no existence calibration: renaming `parseSteps`
  //     repo-wide left "`parseSteps` must not appear in the scanner" green. It
  //     now asserts each name IS in the extractor before asserting it is not
  //     here, so a rename reds and gets re-pointed deliberately.
  //
  // The shape of a source-reading pin matters more than its subject: a
  // WHITELIST over a constrained thing (what may be imported, where a regex may
  // open) outlives the author's discipline; a BLOCKLIST of currently-known
  // tokens does not.
  const SCANNER = new URL('./helpers/raw-expression-scan.js', import.meta.url);
  const source = readFileSync(SCANNER, 'utf8');
  const code = stripComments(source);

  test('it imports nothing but node: builtins', () => {
    const imports = source.split('\n').filter((l) => l.startsWith('import '));
    assert.ok(imports.length > 0, 'if this file stops importing anything the check below is vacuous');
    for (const line of imports) {
      assert.match(line, /from 'node:/, `the raw scanner may not import ${line}`);
    }
    assert.ok(!code.includes('workflow-yaml'), 'no path into the extractor');
    assert.ok(!code.includes('interpolation-sweep'), 'no path into the extractor-based sweep');
  });

  test('every way this file can load code is a top-level node: import -- text half', () => {
    // The whitelist the round-2 version was missing. Every occurrence of the
    // token `import` is either `import.meta` or opens a line that ends in a
    // `node:` specifier. An indented static import and a dynamic `import(` are
    // both occurrences that are neither.
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

    // Calibration: the detector sees the three shapes that defeated the old
    // one. Without these the check is a sentence about a `startsWith`.
    for (const evasion of [
      "  import { parseSteps } from './workflow-yaml.js';",
      "const m = await import('./yaml-proxy.js');",
      "const m = await import(['./yaml', '-proxy.js'].join(''));",
    ]) {
      assert.ok(
        loadSites(evasion).some((o) => o.kind !== 'import.meta' && o.kind !== 'node: static import'),
        `the load-site scan must see ${evasion}`,
      );
    }
  });

  test('every way this file can load code is a top-level node: import -- executed half', () => {
    // The text half above reads bytes; this one records what the module system
    // actually resolved. A loader hook is registered in a child process BEFORE
    // the scanner is imported, then every exported function is called, so a
    // dynamic `import()` buried in a function body is recorded when it runs --
    // which is exactly the shape that defeated all three round-2 assertions.
    assert.deepEqual(resolvedGraph(SCANNER), ['node:fs'], 'the scanner resolves node: builtins and nothing else');

    // Calibration, against the defeating mutation itself: the same harness on a
    // scanner that reaches the extractor through a dynamic re-export proxy must
    // report the proxy. Without this the assertion above cannot be shown to
    // fail.
    const dir = mkdtempSync(join(tmpdir(), 'raw-sweep-graph-'));
    try {
      writeFileSync(join(dir, 'yaml-proxy.js'), 'export const resolveItems = () => [];\n');
      writeFileSync(join(dir, 'proxied-scan.js'), step(
        "import { readdirSync } from 'node:fs';",
        'export function workflowFileNames() { return readdirSync(new URL(\'./\', import.meta.url)).sort(); }',
        "export function readWorkflowFile() { return ''; }",
        'export async function rawExpressions() {',
        "  const proxy = await import('./yaml-proxy.js');",
        '  return proxy.resolveItems();',
        '}',
        '',
      ));
      const graph = resolvedGraph(pathToFileURL(join(dir, 'proxied-scan.js')));
      assert.ok(
        graph.some((spec) => !spec.startsWith('node:')),
        `a dynamic import of a proxy must show up in the graph; got ${JSON.stringify(graph)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('it contains no regular expression at all, so it cannot share one', () => {
    // Not a list of method names -- a scan for the thing itself. A regex
    // literal opens at a `/` that is not inside a string, so the assertion is
    // that the executable code contains no such `/` at all.
    assert.deepEqual(
      regexOpeners(code),
      [],
      'a `/` outside a string literal is where a regex opens; the raw scanner must contain none',
    );

    // Calibration against the two mutations that defeated the token blocklist,
    // both measured at 256 pass / 0 fail against it. Both must be seen here.
    assert.notDeepEqual(regexOpeners("const lines = text.split(/\\n/);"), [], 'N10: .split( with a regex literal');
    assert.notDeepEqual(
      regexOpeners("const s = expression.replaceAll(/ *steps: */g, ' ');"),
      [],
      'N11: .replaceAll( with a whitespace-tolerant twin of the extractor\'s own /^\\s*steps:\\s*$/',
    );

    // And the other direction, so the scan is not merely counting slashes: a
    // path inside a string is not a regex, and the scanner is full of them.
    assert.deepEqual(regexOpeners("const dir = new URL('../../.github/workflows/', import.meta.url);"), []);
    assert.ok(code.includes('.github/workflows/'), 'if that string has gone, the line above proves nothing');

    // The escape charset, kept from round 2 but with an escape-aware reader:
    // the old one stepped one character at a time, so `'\\\\'` reported a stray
    // `'` and the whole assertion was noise waiting to happen.
    const escapes = escapeSequences(code);
    assert.ok(escapes.length > 0, "if there are no escapes at all, split('\\n') has gone and this is vacuous");
    assert.deepEqual(
      [...new Set(escapes)].sort(),
      ['\\', 'n', 'r'],
      'the raw scanner escapes a newline, a carriage return and a backslash, and nothing else',
    );
  });

  test('the extractor and its sweep are not in this file scan path at all', () => {
    // The guarantee is `rawSweepProblems`. Nothing it calls reaches
    // `parseSteps`, `stepScalar`, `readBody` or `structuralLineIdxs`.
    //
    // EXISTENCE FIRST. Round 2 asserted only absence, so renaming `parseSteps`
    // repo-wide left this green at 256 pass / 0 fail while asserting nothing at
    // all -- the pin had already rotted and reported success (Phase 1 F2).
    const extractor = readFileSync(new URL('./helpers/workflow-yaml.js', import.meta.url), 'utf8');
    for (const symbol of ['parseSteps', 'stepScalar', 'readBody', 'structuralLineIdxs', 'expressionsIn']) {
      assert.ok(
        extractor.includes(symbol),
        `${symbol} is gone from the extractor -- re-point this list deliberately rather than leaving it green`,
      );
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
      context: 'with',
      expression: '${{ inputs.pnpm-version }}',
      occurrences: 1,
      why: 'inputs.pnpm-version reaching pnpm/action-setup\'s `version:` input in the audit job. An action '
        + 'input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'node-version: ${{ inputs.node-version }}',
      context: 'with',
      expression: '${{ inputs.node-version }}',
      occurrences: 1,
      why: 'inputs.node-version reaching actions/setup-node\'s `node-version:` input in the audit job. An '
        + 'action input, not program text, and unrelated to the open sink recorded below.',
    },
    {
      line: 'run: pnpm audit --audit-level ${{ inputs.audit-level }}',
      context: 'steps',
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
    assert.deepEqual(rawSweepProblems('security-audit.yml', FIXTURE, ALLOWLIST_AT_E07E185), [], 'calibration: unmutated is clean');

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
      assertReports(rawSweepProblems('security-audit.yml', fixed, ALLOWLIST_AT_E07E185), UNPINNED, 'the env: line needs its own entry');
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

  const SPELLINGS = [
    ['a  \\x24 hex escape for $', '        run: "echo \\x24{{ inputs.node-version }}"'],
    ['b  \\u0024 four-digit escape for $', '        run: "echo \\u0024{{ inputs.node-version }}"'],
    ['c  \\x7b hex escape for {', '        run: "echo $\\x7b{ inputs.node-version }}"'],
    ['d  line continuation after $', '        run: "echo $\\\n          {{ inputs.node-version }}"'],
    ['e  line continuation between the braces', '        run: "echo ${\\\n          { inputs.node-version }}"'],
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

    const contexts = structuralContexts(ci);
    const lines = ci.split('\n');
    const at = lines.findIndex((l) => l.includes('version: ${{ inputs.pnpm-version }}'));
    assert.equal(contexts[at], 'with', 'the pnpm version input is written under with:');
    assert.equal(structuralContexts('a:\n  b: 1\n')[0], '(top level)', 'a line with no enclosing key says so');
  });

  test('calibration: every live entry states the context its line is actually written under', () => {
    // Vacuity guard on the field itself. If `structuralContexts` ever returned
    // one constant, every entry would still match and this suite would be
    // green on a key that discriminates nothing.
    const seen = new Set();
    for (const file of workflowFileNames()) {
      for (const { context } of rawExpressions(readWorkflowFile(file))) seen.add(context);
    }
    assert.ok(seen.size > 1, 'a context that is the same everywhere is not a context');
    assert.deepEqual(
      [...seen].sort(),
      ['concurrency', 'env', 'outputs', 'package-name', 'published-version', 'steps', 'version-channel', 'with'],
      'and the contexts the shipped workflows use are these',
    );
  });
});
