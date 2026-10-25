import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { stepShapes } from './helpers/step-shape.js';
import { parseSteps } from './helpers/workflow-yaml.js';

// abofs/stonyx-workflows#61, round 4. The evaluated #39/#60 publish-implies-
// guard check is only as true as the `if:` it is handed, and three rounds each
// found a YAML shape the hand-written reader read differently from GitHub. The
// fix is not a fourth reader patch: `test/helpers/step-shape.js` refuses every
// step shape outside the few the live files use, so the reader only ever sees
// shapes it reads correctly. Its rules are in its header.
//
// The allowlist reads the REAL workflow files only -- every file in
// `.github/workflows/`, no extension filter. Synthetic fixtures elsewhere in the
// suite deliberately build broken shapes (duplicate `run:` keys in the #37
// sweep tests, for one) and are not workflows anyone runs.

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(WORKFLOWS).sort();
const read = (f) => readFileSync(new URL(f, WORKFLOWS), 'utf8');
const npmPublish = read('npm-publish.yml');

const BETA_NAME = '      - name: Publish to NPM (beta)';
const STABLE_NAME = '      - name: Publish to NPM (stable)';
const BETA_IF = "        if: steps.release-gate.outputs.release == 'true' && contains(steps.package-version.outputs.version, 'beta')";
const STABLE_IF = "        if: \"steps.release-gate.outputs.release == 'true' && !contains(steps.package-version.outputs.version, 'alpha') && !contains(steps.package-version.outputs.version, 'beta')\"";
const GATE_BETA = BETA_IF.replace('        if: ', '');
const GATE_STABLE = STABLE_IF.replace('        if: ', '').slice(1, -1);
const BYPASS = "|| github.event_name == 'workflow_dispatch'";

/**
 * `npmPublish` with `from` (which must occur exactly once) replaced by `to`.
 *
 * `BETA_IF`/`STABLE_IF` as an anchor mean "that publish step's one-line `if:`,
 * WHATEVER IT SAYS": the step's name line followed by any one-line `if:`, so
 * an edit to a live condition reds the evaluated check and not these cases.
 * (`BETA_IF`/`STABLE_IF` inside `to` are injected text, not anchors.)
 */
function mutate(from, to) {
  for (const [ifLine, nameLine] of [[BETA_IF, BETA_NAME], [STABLE_IF, STABLE_NAME]]) {
    if (from !== ifLine) continue;
    const anchor = new RegExp(`^${nameLine.replace(/[()]/g, '\\$&')}\n {8}if: [^\n]*$`, 'gm');
    assert.equal(npmPublish.match(anchor)?.length, 1, `${nameLine.trim()} must open with a one-line if: exactly once`);
    return npmPublish.replace(anchor, () => `${nameLine}\n${to}`);
  }
  if (from instanceof RegExp) {
    assert.equal(npmPublish.match(new RegExp(from.source, 'gm'))?.length, 1, `the mutation anchor must match exactly once: ${from}`);
    return npmPublish.replace(new RegExp(from.source, 'm'), to);
  }
  assert.equal(npmPublish.split(from).length, 2, `the mutation anchor must occur exactly once: ${JSON.stringify(from)}`);
  const out = npmPublish.replace(from, () => to);
  assert.notEqual(out, npmPublish);
  return out;
}

describe('workflow step shape allowlist (#61)', () => {
  test('every live workflow file is inside the allowlist', () => {
    assert.ok(files.includes('npm-publish.yml') && files.includes('cascade.yml'),
      `the files the guarantees read must be in the allowlist's population: ${files.join(', ')}`);
    for (const file of files) {
      const { steps, violations } = stepShapes(read(file), file);
      assert.deepEqual(violations, [], file);
      assert.ok(steps.length > 0, `${file}: no steps found; a vacuous pass is not a pass`);
    }
  });

  // A cross-check, not a dependency: the two share no code, so a step one of
  // them cannot see and the other can reds here.
  test('the allowlist and parseSteps find the same steps in every live workflow', () => {
    for (const file of files) {
      assert.deepEqual(stepShapes(read(file), file).steps.map((s) => s.name), parseSteps(read(file)).map((s) => s.name), file);
    }
  });

  test('the allowlist loads nothing, and so shares no code with the reader it fences', () => {
    const code = readFileSync(new URL('./helpers/step-shape.js', import.meta.url), 'utf8')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const loads = (src) => /\bimport\b|\brequire\b|\beval\b|\bFunction\s*\(/.test(src);
    assert.equal(loads(code), false, 'step-shape.js must not load code');
    for (const evasion of ["import { parseSteps } from './workflow-yaml.js';", "await import('./x.js')",
      "require('./workflow-yaml.js')", "new Function('return 1')"]) {
      assert.equal(loads(evasion), true, `the load scan must see ${evasion}`);
    }
  });

  // Each shape a review round used to slip a condition past the reader, applied
  // to the live file. Each must be refused with a message naming the step, the
  // key and the rule. Where a case is also caught by the evaluated check in
  // tarball-guard-test.js, that is noted; the allowlist does not depend on it.
  const RED = {
    // Framework r3 HIGH: GitHub reads one quoted literal (always truthy); the
    // old reader stripped the quotes and evaluated the gated condition.
    'block scalar with a quoted body, stable publish': [STABLE_IF,
      `        if: >-\n          '${GATE_STABLE.replaceAll("'", "''")}'`, 'if', /block scalar is refused/, 'stable'],
    // Test Coverage r3 SW1: YAML reads this step as having no if: at all.
    'unclosed quoted name absorbs the if: line': [/^ {6}- name: Publish to NPM \(beta\)$/,
      `      - name: "Publish to NPM (beta)\n${BETA_IF}\n        "`, 'name', /double-quoted value must close on its own line/, '"Publish to NPM (beta)'],
    // Convention r3 NIT: the reader took the first, YAML the last.
    'duplicate if:': [BETA_IF, `${BETA_IF}\n        if: ${GATE_BETA} ${BYPASS}`, 'if', /appears twice/, 'beta'],
    // Convention r2 HIGH.
    'plain if: continued on the next line': [BETA_IF, `${BETA_IF}\n          ${BYPASS}`, null, /continuation of the previous value/, 'beta'],
    'plain if: continued after a comment line': [BETA_IF, `${BETA_IF}\n          # reviewed\n          ${BYPASS}`, null, /continuation/, 'beta'],
    'if: >-': [BETA_IF, `        if: >-\n          ${GATE_BETA}\n          ${BYPASS}`, 'if', /block scalar is refused/, 'beta'],
    'if: >': [BETA_IF, `        if: >\n          ${GATE_BETA}`, 'if', /block scalar is refused/, 'beta'],
    'if: |': [BETA_IF, `        if: |\n          ${GATE_BETA}`, 'if', /block scalar is refused/, 'beta'],
    'if: |-': [BETA_IF, `        if: |-\n          ${GATE_BETA}`, 'if', /block scalar is refused/, 'beta'],
    'single-quoted if:': [BETA_IF, `        if: '${GATE_BETA.replaceAll("'", "''")}'`, 'if', /single-quoted is refused/, 'beta'],
    'double-quoted if: over two lines': [STABLE_IF, `        if: "${GATE_STABLE}\n          ${BYPASS}"`, 'if', /must close on its own line/, 'stable'],
    'double-quoted if: folded to column 0': [STABLE_IF, `        if: "${GATE_STABLE}\n${BYPASS}"`, 'if', /must close on its own line/, 'stable'],
    'trailing comment on a plain if:': [BETA_IF, `${BETA_IF} # ${BYPASS}`, 'if', /starts a YAML comment/, 'beta'],
    'trailing comment after a double-quoted if:': [STABLE_IF, `${STABLE_IF} # x`, 'if', /nothing after the closing quote/, 'stable'],
    'double-quoted if: with an escape': [STABLE_IF, STABLE_IF.replace("'true'", "'tr\\x75e'"), 'if', /backslash/, 'stable'],
    'quoted "if": key': [BETA_IF, BETA_IF.replace('if:', '"if":'), null, /not a "key: value" line/, 'beta'],
    'if: on the dash line, continued': [/^ {6}- name: Publish to NPM \(beta\)$/,
      `      - if: ${GATE_BETA}\n          ${BYPASS}\n        name: Publish to NPM (beta)`, null, /continuation/, 'beta'],
    'if: key indented one column deeper': [BETA_IF, ` ${BETA_IF}`, null, /column 9 is not one of the step's own keys/, 'beta'],
    'run: folded': [/^ {8}run: (pnpm publish [^\n]*--tag beta [^\n]*)$/, '        run: >\n          $1', 'run', /YAML indicator/, 'beta'],
    'if: with its value on the next lines': [BETA_IF, `        if:\n          ${GATE_BETA}\n          ${BYPASS}`, 'if', /no inline value/, 'beta'],
    'duplicate env: key': [BETA_IF, `${BETA_IF}\n        env:\n          A: one\n          A: two`, 'env.A', /appears twice under env:/, 'beta'],
    'env: value as a block': [BETA_IF, `${BETA_IF}\n        env:\n          A: |\n            x`, 'env.A', /block is allowed on run: and with: script: only/, 'beta'],
    'env: nested mapping': [BETA_IF, `${BETA_IF}\n        env:\n          A:\n            B: c`, 'env.A', /nested mapping/, 'beta'],
    'flow-mapping step': [/^ {6}- name: Publish to NPM \(beta\)$/, `      - {name: x, run: npm publish}\n${BETA_NAME}`, null, /not a "key: value" line/, 'none'],
  };

  test('every bypass shape from rounds 2 and 3 is refused, naming the step, the key and the rule', () => {
    const missed = [];
    for (const [label, [from, to, key, rule, which]] of Object.entries(RED)) {
      const { violations } = stepShapes(mutate(from, to), 'npm-publish.yml');
      const stepName = `(name: ${{ beta: 'Publish to NPM (beta)', stable: 'Publish to NPM (stable)' }[which] ?? which})`;
      const hit = violations.find((v) => v.includes(stepName) && (key === null || v.includes(`: key ${key}: `)) && rule.test(v));
      if (!hit) missed.push(`${label}: ${JSON.stringify(violations)}`);
    }
    assert.deepEqual(missed, []);
  });

  test('a character YAML reads as a line break, or as non-space whitespace, is refused before any step is read', () => {
    for (const [label, ch] of [['LS', '\u2028'], ['PS', '\u2029'], ['NEL', '\u0085'], ['CR', '\r'], ['TAB', '\t'],
      ['NBSP', '\u00a0'], ['BOM', '\ufeff']]) {
      // The runner breaks the line at LS/PS/NEL/CR, so this hides a second if: inside the first one's line.
      const { violations } = stepShapes(mutate(BETA_IF, `${BETA_IF}${ch}        if: true`), 'npm-publish.yml');
      assert.ok(violations.length > 0 && violations.every((v) => /control character or whitespace other than a space/.test(v)),
        `${label}: ${JSON.stringify(violations)}`);
    }
  });

  test('a steps: key the allowlist would not walk is refused, not skipped', () => {
    for (const shape of ['    steps: # c', '    "steps":', "    'steps' :", '    steps: []']) {
      const { violations } = stepShapes(npmPublish.replace(/^ {4}steps:$/m, shape), 'npm-publish.yml');
      assert.ok(violations.some((v) => /steps: key in a form this check does not read/.test(v)), `${shape}: ${JSON.stringify(violations)}`);
    }
  });

  // The inverse: every shape the allowlist admits, in one synthetic workflow,
  // reads clean -- including block bodies whose lines look like refused
  // shapes, which must be skipped as payload. Without this, the reds above
  // could be red because everything is.
  test('every admitted shape reads clean, and block-scalar payload is not read as structure', () => {
    const wf = [
      'jobs:',
      '  j:',
      '    steps:',
      '      - name: plain',
      "        if: steps.a.outputs.b == 'c'",
      '        id: an-id',
      '        run: echo one',
      '      - name: "double-quoted: with a colon"',
      "        if: \"!contains(steps.a.outputs.b, 'c')\"",
      "        uses: 'actions/checkout@v4'",
      '        with:',
      '          persist-credentials: false',
      "          ref: ''",
      '        env:',
      '          A: ${{ inputs.a }}',
      "          B: 'it''s'",
      '        run: |',
      '          if: x',
      '            || y',
      '          "if": z',
      '          - {name: flow}',
      '          if: >-',
      '      -   name: wide dash',
      '          if: ${{ always() }}',
      '          run: |-',
      '            echo two',
      '      - uses: actions/github-script@v7',
      '        with:',
      '          script: |',
      '            const if_ = 1; // if: a',
      '              name: b',
      '',
    ].join('\n');
    const { steps, violations } = stepShapes(wf, 'synthetic.yml');
    assert.deepEqual(violations, []);
    assert.deepEqual(steps.map((s) => s.name), ['plain', '"double-quoted: with a colon"', 'wide dash', null]);
  });
});
